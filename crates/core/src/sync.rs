//! Replication between replicas of the same core (docs/adr/015-sync-server.md).
//!
//! Replicas exchange `ops` rows. An incoming op writes only the fields where its HLC is
//! newer than the latest write recorded in `field_clocks`: the latest edit wins, per field,
//! whatever order ops arrive in. Edits never write `deleted_at`, so a delete wins over a
//! later edit. After applying incoming ops, [`repair`] fixes states that two valid edits
//! can merge into but no single device would write, with ordinary local ops; every rule is
//! deterministic, so replicas repairing the same state reach the same rows.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::clock::{Hlc, check_id};
use crate::error::{Error, Result};
use crate::model::{Id, Timestamp};
use crate::ops::{self, Batch, Change, Entity, EntityKind, OpKind, Patch, Sql};
use crate::store::Changes;

/// `sync_state` key: the last local op the server has acknowledged.
pub(crate) const PUSHED_SEQ: &str = "pushed_seq";
/// `sync_state` key: the last server op applied here.
pub(crate) const CURSOR: &str = "cursor";

/// Rebuilds `field_clocks` from the ops log (after an import). Same rule as migration 0007.
pub(crate) const REBUILD_CLOCKS: &str = "
    DELETE FROM field_clocks;
    INSERT INTO field_clocks (entity, entity_id, field, hlc)
      SELECT o.entity, o.entity_id, j.key, MAX(o.hlc)
      FROM ops o, json_each(o.patch) j
      WHERE o.entity <> 'task_tag'
      GROUP BY o.entity, o.entity_id, j.key;
    INSERT INTO field_clocks (entity, entity_id, field, hlc)
      SELECT entity, entity_id, json_extract(patch, '$.tag_id'), MAX(hlc)
      FROM ops
      WHERE entity = 'task_tag'
      GROUP BY entity, entity_id, json_extract(patch, '$.tag_id');";

/// One op as replicas exchange it. The inverse stays local: each replica computes its own
/// from its rows when it applies the op.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncOp {
    pub op_id: Id,
    pub device_id: String,
    pub hlc: String,
    pub entity: String,
    pub entity_id: Id,
    pub kind: String,
    pub patch: Map<String, Value>,
    pub batch_id: Option<Id>,
}

/// A page of ops in `seq` order.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OpsPage {
    pub ops: Vec<SyncOp>,
    /// `seq` of the last op in the page (the next cursor), or the `after` asked for when
    /// the page is empty.
    pub last_seq: i64,
    /// More ops follow this page.
    pub more: bool,
}

// ---------------------------------------------------------------------------------------
// Wire types shared by the server and its clients (docs/server.md).

/// How a server authenticates requests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// Anyone who reaches the server (a private network).
    #[default]
    None,
    /// A bearer token made on the server.
    Token,
    /// Sign in with an OpenID Connect provider, which gives the device a server token.
    Oidc,
}

/// `GET /info`: what a client needs before it can sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    /// The database schema the server runs. Clients push only with the same one.
    pub schema_version: u32,
    pub auth: AuthMode,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    /// The server's clock (Unix ms), so clients can correct theirs.
    pub server_time: Timestamp,
    pub public_url: Option<String>,
}

/// `POST /sync/push`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushRequest {
    pub schema_version: u32,
    pub ops: Vec<SyncOp>,
}

/// Answer to a push.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushResult {
    pub applied: u32,
    pub duplicates: u32,
    pub skipped: u32,
    pub repairs: u32,
    /// The server's newest op `seq` after the push.
    pub head: i64,
}

/// `GET /sync/pull?after=<seq>&limit=<n>`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PullPage {
    #[serde(flatten)]
    pub page: OpsPage,
    /// The server's newest op `seq`.
    pub head: i64,
}

/// `POST /auth/oidc`: trade an ID token from the provider for a device token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OidcExchange {
    pub id_token: String,
    /// Shown in `token list` (e.g. the computer's name).
    pub device_name: String,
}

/// A token issued by the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuedToken {
    pub token: String,
    pub name: String,
}

/// What [`crate::Store::apply_remote`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Merged {
    /// New ops recorded (whether or not they won any field).
    pub applied: u32,
    /// Ops already here (sent twice, or this replica's own).
    pub duplicates: u32,
    /// Ops changing a row this replica has never seen. Not recorded; they cannot happen
    /// when a server relays each device's ops in order.
    pub skipped: u32,
    /// Local ops written by [`repair`].
    pub repairs: u32,
    /// Entities changed, as they are now.
    pub changes: Changes,
}

pub(crate) fn state(conn: &Connection, key: &str) -> Result<i64> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(value.and_then(|v| v.parse().ok()).unwrap_or(0))
}

pub(crate) fn set_state(conn: &Connection, key: &str, value: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value.to_string()],
    )?;
    Ok(())
}

/// Ops with `seq > after`, oldest first; only this replica's own when `local_only`.
pub(crate) fn ops_after(
    conn: &Connection,
    after: i64,
    limit: u32,
    local_only: bool,
) -> Result<OpsPage> {
    let limit = limit.max(1);
    let mut stmt = conn.prepare_cached(
        "SELECT seq, op_id, device_id, hlc, entity, entity_id, kind, patch, batch_id FROM ops
         WHERE seq > ?1 AND (?2 = 0 OR received = 0) ORDER BY seq LIMIT ?3",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![after, i64::from(local_only), i64::from(limit) + 1],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                SyncOp {
                    op_id: r.get(1)?,
                    device_id: r.get(2)?,
                    hlc: r.get(3)?,
                    entity: r.get(4)?,
                    entity_id: r.get(5)?,
                    kind: r.get(6)?,
                    patch: Map::new(),
                    batch_id: r.get(8)?,
                },
                r.get::<_, String>(7)?,
            ))
        },
    )?;
    let mut page = OpsPage {
        last_seq: after,
        ..OpsPage::default()
    };
    for row in rows {
        let (seq, mut op, patch) = row?;
        if page.ops.len() == limit as usize {
            page.more = true;
            break;
        }
        op.patch = serde_json::from_str(&patch)?;
        page.last_seq = seq;
        page.ops.push(op);
    }
    Ok(page)
}

/// The result of applying incoming ops, before [`crate::Store`] loads the changes.
pub(crate) struct Applied {
    pub merged: Merged,
    pub touched: BTreeSet<(EntityKind, Id)>,
    pub last_seq: Option<i64>,
    pub batch_id: Id,
}

/// Applies incoming ops, then repairs the merged state, all in the caller's transaction.
pub(crate) fn apply(
    tx: &Transaction<'_>,
    clock: &mut Hlc,
    device_id: &str,
    incoming: Vec<SyncOp>,
    now: Timestamp,
) -> Result<Applied> {
    let mut merged = Merged::default();
    let mut touched = BTreeSet::new();
    let mut last_seq = None;
    let mut tag_losers = Vec::new();
    for op in incoming {
        match apply_one(tx, clock, op, now, &mut tag_losers)? {
            Outcome::Duplicate => merged.duplicates += 1,
            Outcome::Skipped => merged.skipped += 1,
            Outcome::Applied { kind, id, seq } => {
                merged.applied += 1;
                touched.insert((kind, id));
                last_seq = Some(seq);
            }
        }
    }
    let mut batch = Batch::new(tx, clock, device_id, now);
    merged.repairs = repair(&mut batch, &tag_losers)?;
    touched.extend(std::mem::take(&mut batch.touched));
    Ok(Applied {
        merged,
        touched,
        last_seq: batch.last_seq.or(last_seq),
        batch_id: batch.batch_id,
    })
}

enum Outcome {
    Duplicate,
    Skipped,
    Applied { kind: EntityKind, id: Id, seq: i64 },
}

fn apply_one(
    tx: &Transaction<'_>,
    clock: &mut Hlc,
    op: SyncOp,
    now: Timestamp,
    tag_losers: &mut Vec<Id>,
) -> Result<Outcome> {
    let known = tx
        .prepare_cached("SELECT 1 FROM ops WHERE op_id = ?1")?
        .query_row([&op.op_id], |_| Ok(()))
        .optional()?;
    if known.is_some() {
        return Ok(Outcome::Duplicate);
    }
    if Hlc::parse(&op.hlc).is_none() {
        return Err(Error::invalid(format!("op {} has a bad clock", op.op_id)));
    }
    let entity = Entity::parse(&op.entity)?;
    let kind = OpKind::parse(&op.kind)?;
    check_id(&op.entity_id)?;
    let allowed = entity.columns();
    if let Some(bad) = op.patch.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(Error::invalid(format!(
            "column '{bad}' cannot be written on {}",
            entity.as_str()
        )));
    }
    clock.observe(&op.hlc);
    let id = op.entity_id.as_str();

    // Fields this op wins: its clock is newer than the last write to them.
    let mut winners = Vec::new();
    for field in ops::clock_fields(entity, &op.patch) {
        let newer = ops::field_clock(tx, entity, id, field)?.is_none_or(|c| op.hlc > c);
        if newer {
            winners.push(field.to_owned());
        }
    }

    let inverse = match (entity, kind) {
        (Entity::TaskTag, OpKind::Link | OpKind::Unlink) => {
            let tag_id = op
                .patch
                .get("tag_id")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::invalid("link needs a tag_id"))?;
            if !winners.is_empty() {
                let sql = if kind == OpKind::Link {
                    "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)"
                } else {
                    "DELETE FROM task_tags WHERE task_id = ?1 AND tag_id = ?2"
                };
                tx.execute(sql, [id, tag_id])?;
            }
            op.patch.clone()
        }
        (Entity::TaskTag, _) | (_, OpKind::Link | OpKind::Unlink) => {
            return Err(Error::invalid(format!(
                "op '{}' does not apply to {}",
                kind.as_str(),
                entity.as_str()
            )));
        }
        _ => {
            let cols: Vec<&str> = winners.iter().map(String::as_str).collect();
            match ops::read_row(tx, entity, id, &cols)? {
                None if kind == OpKind::Create => {
                    let mut row = op.patch.clone();
                    row.insert("id".into(), Value::String(id.to_owned()));
                    if entity == Entity::Tag
                        && tag_clash(tx, now, id, &row, &Patch::new(), tag_losers)?
                    {
                        row.insert("deleted_at".into(), json!(now));
                    }
                    let names: Vec<&str> = row.keys().map(String::as_str).collect();
                    let marks = vec!["?"; names.len()].join(", ");
                    let sql = format!(
                        "INSERT INTO {} ({}) VALUES ({marks})",
                        entity.table(),
                        names.join(", ")
                    );
                    tx.execute(&sql, params_from_iter(row.values().map(Sql)))?;
                    winners = op.patch.keys().cloned().collect();
                    let mut inv = Patch::new();
                    inv.insert("deleted_at".into(), json!(now));
                    inv
                }
                None => return Ok(Outcome::Skipped),
                Some(previous) => {
                    let mut set: Patch = winners
                        .iter()
                        .filter_map(|f| op.patch.get(f).map(|v| (f.clone(), v.clone())))
                        .collect();
                    if entity == Entity::Tag {
                        let current = ops::read_row(tx, entity, id, &["name", "deleted_at"])?
                            .unwrap_or_default();
                        if tag_clash(tx, now, id, &set, &current, tag_losers)? {
                            set.insert("deleted_at".into(), json!(now));
                        }
                    }
                    if !set.is_empty() {
                        let sets: Vec<String> = set.keys().map(|k| format!("{k} = ?")).collect();
                        let sql = format!(
                            "UPDATE {} SET {} WHERE id = ?",
                            entity.table(),
                            sets.join(", ")
                        );
                        let id_value = Value::String(id.to_owned());
                        let values = set.values().chain(std::iter::once(&id_value)).map(Sql);
                        tx.execute(&sql, params_from_iter(values))?;
                    }
                    previous
                }
            }
        }
    };

    for field in &winners {
        ops::bump_clock(tx, entity, id, field, &op.hlc)?;
    }
    tx.execute(
        "INSERT INTO ops (op_id, device_id, hlc, entity, entity_id, kind, patch, inverse,
                          batch_id, received)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1)",
        rusqlite::params![
            op.op_id,
            op.device_id,
            op.hlc,
            entity.as_str(),
            id,
            kind.as_str(),
            Value::Object(op.patch).to_string(),
            Value::Object(inverse).to_string(),
            op.batch_id,
        ],
    )?;
    Ok(Outcome::Applied {
        kind: entity.kind(),
        id: op.entity_id,
        seq: tx.last_insert_rowid(),
    })
}

/// Live tag names are unique. When writing `set` over `current` would make tag `id` share
/// its name with another live tag, the tag with the larger id (created later) loses: an
/// existing loser is deleted here, and `true` tells the caller to write `id` deleted.
/// Losers are recorded so [`repair`] logs their delete as an op and moves their links.
fn tag_clash(
    tx: &Transaction<'_>,
    now: Timestamp,
    id: &str,
    set: &Patch,
    current: &Patch,
    losers: &mut Vec<Id>,
) -> Result<bool> {
    let field = |key: &str| set.get(key).or_else(|| current.get(key)).cloned();
    let live = field("deleted_at").is_none_or(|v| v.is_null());
    let Some(Value::String(name)) = field("name") else {
        return Ok(false);
    };
    if !live {
        return Ok(false);
    }
    let other: Option<String> = tx
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE AND deleted_at IS NULL
             AND id <> ?2",
            [name.as_str(), id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(other) = other else {
        return Ok(false);
    };
    if id < other.as_str() {
        tx.execute(
            "UPDATE tags SET deleted_at = ?1 WHERE id = ?2",
            rusqlite::params![now, other],
        )?;
        losers.push(other);
        Ok(false)
    } else {
        losers.push(id.to_owned());
        Ok(true)
    }
}

/// Fixes merged states no single device would write. Returns the number of ops written.
pub(crate) fn repair(b: &mut Batch<'_, '_>, tag_losers: &[Id]) -> Result<u32> {
    // Tags that lost a name clash: log their delete (the row is already deleted).
    for id in tag_losers {
        let now = b.now;
        b.apply(Change::new(
            Entity::Tag,
            id,
            OpKind::Delete,
            json!({ "deleted_at": now }),
        ))?;
    }

    // Each pass can expose more (a deleted task's children, then theirs): repeat until a
    // pass writes nothing. The bound only guards against a bug looping forever.
    for _ in 0..64 {
        let before = b.last_seq;
        repair_pass(b)?;
        if b.last_seq == before {
            break;
        }
    }
    let written: i64 = b.tx.query_row(
        "SELECT COUNT(*) FROM ops WHERE batch_id = ?1",
        [&b.batch_id],
        |r| r.get(0),
    )?;
    Ok(u32::try_from(written).unwrap_or(u32::MAX))
}

fn repair_pass(b: &mut Batch<'_, '_>) -> Result<()> {
    let now = b.now;

    // Links to a deleted tag move to the live tag of the same name, else go.
    let links: Vec<(Id, Id, Option<Id>)> = rows(
        b.tx,
        "SELECT tt.task_id, tt.tag_id,
                (SELECT l.id FROM tags l WHERE l.deleted_at IS NULL
                 AND l.name = d.name COLLATE NOCASE)
         FROM task_tags tt JOIN tags d ON d.id = tt.tag_id
         WHERE d.deleted_at IS NOT NULL
         ORDER BY tt.task_id, tt.tag_id",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    for (task_id, tag_id, live) in links {
        b.apply(Change::new(
            Entity::TaskTag,
            &task_id,
            OpKind::Unlink,
            json!({ "tag_id": tag_id }),
        ))?;
        if let Some(live) = live {
            b.apply(Change::new(
                Entity::TaskTag,
                &task_id,
                OpKind::Link,
                json!({ "tag_id": live }),
            ))?;
        }
    }

    // A live task under a deleted parent: the delete wins, as for a local subtree delete.
    for id in ids(
        b.tx,
        "SELECT c.id FROM tasks c JOIN tasks p ON p.id = c.parent_id
         WHERE c.deleted_at IS NULL AND p.deleted_at IS NOT NULL ORDER BY c.id",
    )? {
        b.apply(Change::new(
            Entity::Task,
            &id,
            OpKind::Delete,
            json!({ "deleted_at": now, "updated_at": now }),
        ))?;
    }

    // Parent cycles: the latest move wins, so the task in the cycle whose parent was set
    // earliest goes to the top level.
    for id in cycle_breaks(b.tx, Entity::Task, "tasks")? {
        b.apply(Change::new(
            Entity::Task,
            &id,
            OpKind::Update,
            json!({ "parent_id": null }),
        ))?;
    }

    // Projects nest one level: a project under a project that itself has a parent (which
    // includes cycles). The earliest of the two moves is undone.
    let nested: Vec<(Id, Id)> = rows(
        b.tx,
        "SELECT c.id, p.id FROM projects c JOIN projects p ON p.id = c.parent_id
         WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NOT NULL
         ORDER BY c.id",
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mut detached = BTreeSet::new();
    for (child, parent) in nested {
        let key = |id: &str| -> Result<(String, String)> {
            let clock = ops::field_clock(b.tx, Entity::Project, id, "parent_id")?;
            Ok((clock.unwrap_or_default(), id.to_owned()))
        };
        let (_, earliest) = key(&child)?.min(key(&parent)?);
        if detached.insert(earliest.clone()) {
            b.apply(Change::new(
                Entity::Project,
                &earliest,
                OpKind::Update,
                json!({ "parent_id": null }),
            ))?;
        }
    }

    // Deleted projects: a project is only deleted empty, so what landed in it moves out.
    let moves: [(&str, Entity, &str); 4] = [
        (
            "SELECT id FROM tasks WHERE deleted_at IS NULL AND project_id IN
               (SELECT id FROM projects WHERE deleted_at IS NOT NULL) ORDER BY id",
            Entity::Task,
            "project_id",
        ),
        (
            "SELECT id FROM epics WHERE deleted_at IS NULL AND project_id IN
               (SELECT id FROM projects WHERE deleted_at IS NOT NULL) ORDER BY id",
            Entity::Epic,
            "project_id",
        ),
        (
            "SELECT id FROM projects WHERE deleted_at IS NULL AND parent_id IN
               (SELECT id FROM projects WHERE deleted_at IS NOT NULL) ORDER BY id",
            Entity::Project,
            "parent_id",
        ),
        // A deleted epic detaches its tasks.
        (
            "SELECT id FROM tasks WHERE deleted_at IS NULL AND epic_id IN
               (SELECT id FROM epics WHERE deleted_at IS NOT NULL) ORDER BY id",
            Entity::Task,
            "epic_id",
        ),
    ];
    for (sql, entity, field) in moves {
        for id in ids(b.tx, sql)? {
            let mut patch = Map::new();
            patch.insert(field.into(), Value::Null);
            b.apply(Change::new(
                entity,
                &id,
                OpKind::Update,
                Value::Object(patch),
            ))?;
        }
    }

    // A live task on a deleted status: the first live status of the same category, else
    // the first live status.
    let stranded: Vec<(Id, String)> = rows(
        b.tx,
        "SELECT t.id, s.category FROM tasks t JOIN statuses s ON s.id = t.status_id
         WHERE t.deleted_at IS NULL AND s.deleted_at IS NOT NULL ORDER BY t.id",
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    for (id, category) in stranded {
        let target: Option<Id> =
            b.tx.query_row(
                "SELECT id FROM statuses WHERE deleted_at IS NULL
                 ORDER BY category <> ?1, rank, id LIMIT 1",
                [&category],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(target) = target {
            b.apply(Change::new(
                Entity::Task,
                &id,
                OpKind::Update,
                json!({ "status_id": target }),
            ))?;
        }
    }

    // `completed_at` follows the status: set in a `done` column, cleared elsewhere.
    let mismatched: Vec<(Id, bool)> = rows(
        b.tx,
        "SELECT t.id, s.category = 'done' FROM tasks t JOIN statuses s ON s.id = t.status_id
         WHERE t.deleted_at IS NULL
           AND (s.category = 'done') <> (t.completed_at IS NOT NULL)
         ORDER BY t.id",
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    for (id, done) in mismatched {
        let value = if done { json!(now) } else { Value::Null };
        b.apply(Change::new(
            Entity::Task,
            &id,
            OpKind::Update,
            json!({ "completed_at": value }),
        ))?;
    }
    Ok(())
}

/// For each parent cycle among live rows, the member whose `parent_id` was written
/// earliest (ties: smallest id).
fn cycle_breaks(tx: &Transaction<'_>, entity: Entity, table: &str) -> Result<Vec<Id>> {
    let parents: BTreeMap<Id, Id> = rows(
        tx,
        &format!(
            "SELECT c.id, c.parent_id FROM {table} c JOIN {table} p ON p.id = c.parent_id
             WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL"
        ),
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?
    .into_iter()
    .collect();
    let mut seen: BTreeSet<Id> = BTreeSet::new();
    let mut breaks: Vec<Id> = Vec::new();
    for start in parents.keys() {
        if seen.contains(start) {
            continue;
        }
        // Walk up from `start`; a node met twice on this walk closes a cycle.
        let mut path: Vec<Id> = Vec::new();
        let mut on_path: BTreeSet<Id> = BTreeSet::new();
        let mut node = start.clone();
        loop {
            if seen.contains(&node) {
                break;
            }
            if !on_path.insert(node.clone()) {
                let from = path.iter().position(|n| n == &node).unwrap_or(0);
                let mut best: Option<(String, Id)> = None;
                for member in &path[from..] {
                    let clock =
                        ops::field_clock(tx, entity, member, "parent_id")?.unwrap_or_default();
                    let key = (clock, member.clone());
                    if best.as_ref().is_none_or(|b| key < *b) {
                        best = Some(key);
                    }
                }
                breaks.extend(best.map(|(_, id)| id));
                break;
            }
            path.push(node.clone());
            match parents.get(&node) {
                Some(parent) => node = parent.clone(),
                None => break,
            }
        }
        seen.extend(path);
    }
    Ok(breaks)
}

fn ids(tx: &Transaction<'_>, sql: &str) -> Result<Vec<Id>> {
    rows(tx, sql, |r| r.get(0))
}

fn rows<T>(
    tx: &Transaction<'_>,
    sql: &str,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = tx.prepare_cached(sql)?;
    let out = stmt.query_map([], map)?.collect::<rusqlite::Result<_>>()?;
    Ok(out)
}
