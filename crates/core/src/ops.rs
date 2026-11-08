//! The op engine: applies one change to a row and appends its `ops` entry (patch + inverse).
//!
//! Commands compile to [`Change`]s; undo and redo replay stored inverses through the same
//! path, so every write in the system is recorded the same way.

use std::collections::BTreeSet;

use rusqlite::types::{ToSql, ToSqlOutput, ValueRef};
use rusqlite::{OptionalExtension, Transaction, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::clock::{Hlc, new_id};
use crate::error::{Error, Result};
use crate::model::{Id, Timestamp};

/// JSON object of column -> value.
pub(crate) type Patch = Map<String, Value>;

/// Binds a JSON patch value as a plain SQL value. (rusqlite's own impl stores strings
/// JSON-encoded, quotes included, which would break equality and foreign keys.)
pub(crate) struct Sql<'a>(pub &'a Value);

impl ToSql for Sql<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self.0 {
            Value::Null => ToSqlOutput::Borrowed(ValueRef::Null),
            Value::Bool(b) => ToSqlOutput::from(i64::from(*b)),
            Value::Number(n) => match n.as_i64() {
                Some(i) => ToSqlOutput::from(i),
                None => ToSqlOutput::from(n.as_f64().unwrap_or(f64::NAN)),
            },
            Value::String(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
            other => ToSqlOutput::from(other.to_string()),
        })
    }
}

/// Kinds of entity front ends get back in [`crate::Changes`] and events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Task,
    Project,
    Epic,
    Tag,
    View,
    Status,
    Attachment,
    TimeBlock,
    AgentSession,
    AgentNote,
}

/// What an op targets. `TaskTag` rows are links: `entity_id` is the task, the patch holds
/// `tag_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Entity {
    Task,
    Project,
    Epic,
    Tag,
    View,
    Status,
    TaskTag,
    Attachment,
    TimeBlock,
    AgentSession,
    AgentNote,
}

impl Entity {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AgentSession => "agent_session",
            Self::AgentNote => "agent_note",
            Self::Task => "task",
            Self::Project => "project",
            Self::Epic => "epic",
            Self::Tag => "tag",
            Self::View => "view",
            Self::Status => "status",
            Self::TaskTag => "task_tag",
            Self::Attachment => "attachment",
            Self::TimeBlock => "time_block",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "task" => Self::Task,
            "project" => Self::Project,
            "epic" => Self::Epic,
            "tag" => Self::Tag,
            "view" => Self::View,
            "status" => Self::Status,
            "task_tag" => Self::TaskTag,
            "attachment" => Self::Attachment,
            "time_block" => Self::TimeBlock,
            "agent_session" => Self::AgentSession,
            "agent_note" => Self::AgentNote,
            other => return Err(Error::invalid(format!("unknown op entity '{other}'"))),
        })
    }

    pub(crate) fn table(self) -> &'static str {
        match self {
            Self::Task => "tasks",
            Self::Project => "projects",
            Self::Epic => "epics",
            Self::Tag => "tags",
            Self::View => "views",
            Self::Status => "statuses",
            Self::TaskTag => "task_tags",
            Self::Attachment => "attachments",
            Self::TimeBlock => "time_blocks",
            Self::AgentSession => "agent_sessions",
            Self::AgentNote => "agent_notes",
        }
    }

    /// Columns an op may write. Patch keys are checked against this before building SQL.
    pub(crate) fn columns(self) -> &'static [&'static str] {
        match self {
            Self::Task => &[
                "dependency_ids",
                "owner",
                "id",
                "project_id",
                "epic_id",
                "parent_id",
                "status_id",
                "title",
                "description",
                "priority",
                "due_date",
                "today_on",
                "estimate_min",
                "rank",
                "created_at",
                "updated_at",
                "completed_at",
                "deleted_at",
            ],
            Self::Project => &[
                "id",
                "parent_id",
                "name",
                "color",
                "icon",
                "rank",
                "archived_at",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::Epic => &[
                "color",
                "icon",
                "id",
                "project_id",
                "name",
                "description",
                "target_date",
                "state",
                "rank",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::Tag => &[
                "id",
                "name",
                "color",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::View => &[
                "id",
                "name",
                "spec",
                "rank",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::Status => &[
                "id",
                "name",
                "category",
                "color",
                "rank",
                "wip_limit",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::TaskTag => &["tag_id"],
            Self::Attachment => &[
                "id",
                "task_id",
                "hash",
                "name",
                "mime",
                "size",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::TimeBlock => &[
                "id",
                "task_id",
                "start_at",
                "end_at",
                "outcome",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::AgentSession => &[
                "id",
                "task_id",
                "device_id",
                "claude_session_id",
                "folder",
                "runtime",
                "permission_mode",
                "model",
                "prompt",
                "state",
                "started_at",
                "ended_at",
                "summary",
                "cost_usd_micros",
                "turns",
                "error",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            Self::AgentNote => &[
                "id",
                "session_id",
                "task_id",
                "body",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
        }
    }

    pub(crate) fn kind(self) -> EntityKind {
        match self {
            Self::Task | Self::TaskTag => EntityKind::Task,
            Self::Project => EntityKind::Project,
            Self::Epic => EntityKind::Epic,
            Self::Tag => EntityKind::Tag,
            Self::View => EntityKind::View,
            Self::Status => EntityKind::Status,
            Self::Attachment => EntityKind::Attachment,
            Self::TimeBlock => EntityKind::TimeBlock,
            Self::AgentSession => EntityKind::AgentSession,
            Self::AgentNote => EntityKind::AgentNote,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpKind {
    Create,
    Update,
    Delete,
    Restore,
    Link,
    Unlink,
}

impl OpKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Restore => "restore",
            Self::Link => "link",
            Self::Unlink => "unlink",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "create" => Self::Create,
            "update" => Self::Update,
            "delete" => Self::Delete,
            "restore" => Self::Restore,
            "link" => Self::Link,
            "unlink" => Self::Unlink,
            other => return Err(Error::invalid(format!("unknown op kind '{other}'"))),
        })
    }

    /// The kind of op that undoes this one.
    pub(crate) fn inverse(self) -> Self {
        match self {
            Self::Create | Self::Restore => Self::Delete,
            Self::Delete => Self::Restore,
            Self::Update => Self::Update,
            Self::Link => Self::Unlink,
            Self::Unlink => Self::Link,
        }
    }
}

/// One row-level change to apply.
#[derive(Debug, Clone)]
pub(crate) struct Change {
    pub entity: Entity,
    pub entity_id: Id,
    pub kind: OpKind,
    pub patch: Patch,
}

impl Change {
    pub(crate) fn new(entity: Entity, id: &str, kind: OpKind, patch: Value) -> Self {
        let Value::Object(patch) = patch else {
            unreachable!("patches are built with json!({{...}})")
        };
        Self {
            entity,
            entity_id: id.to_owned(),
            kind,
            patch,
        }
    }
}

/// A write batch in progress: every change applied through it shares one `batch_id` and
/// lands in the caller's transaction.
pub(crate) struct Batch<'t, 'c> {
    pub tx: &'t Transaction<'c>,
    pub now: Timestamp,
    pub batch_id: String,
    clock: &'t mut Hlc,
    device_id: &'t str,
    pub touched: BTreeSet<(EntityKind, Id)>,
    pub last_seq: Option<i64>,
}

impl<'t, 'c> Batch<'t, 'c> {
    pub(crate) fn new(
        tx: &'t Transaction<'c>,
        clock: &'t mut Hlc,
        device_id: &'t str,
        now: Timestamp,
    ) -> Self {
        Self {
            tx,
            now,
            batch_id: new_id(),
            clock,
            device_id,
            touched: BTreeSet::new(),
            last_seq: None,
        }
    }

    /// The device writing this batch.
    pub(crate) fn device_id(&self) -> &str {
        self.device_id
    }

    /// Applies a change and records it. Links that already exist (or unlinks of missing
    /// links) are no-ops and write no op.
    pub(crate) fn apply(&mut self, change: Change) -> Result<()> {
        let Change {
            entity,
            entity_id,
            kind,
            patch,
        } = change;
        let allowed = entity.columns();
        if let Some(bad) = patch.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(Error::invalid(format!(
                "column '{bad}' cannot be written on {}",
                entity.as_str()
            )));
        }
        let table = entity.table();

        let inverse = match (entity, kind) {
            (Entity::TaskTag, OpKind::Link | OpKind::Unlink) => {
                let tag_id = patch
                    .get("tag_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::invalid("link needs a tag_id"))?;
                let sql = if kind == OpKind::Link {
                    "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?1, ?2)"
                } else {
                    "DELETE FROM task_tags WHERE task_id = ?1 AND tag_id = ?2"
                };
                if self.tx.execute(sql, [&entity_id, tag_id])? == 0 {
                    return Ok(());
                }
                patch.clone()
            }
            (Entity::TaskTag, _) | (_, OpKind::Link | OpKind::Unlink) => {
                return Err(Error::invalid(format!(
                    "op '{}' does not apply to {}",
                    kind.as_str(),
                    entity.as_str()
                )));
            }
            (_, OpKind::Create) => {
                let mut row = patch.clone();
                row.insert("id".into(), Value::String(entity_id.clone()));
                let cols: Vec<&str> = row.keys().map(String::as_str).collect();
                let marks = vec!["?"; cols.len()].join(", ");
                let sql = format!("INSERT INTO {table} ({}) VALUES ({marks})", cols.join(", "));
                self.tx
                    .execute(&sql, params_from_iter(row.values().map(Sql)))
                    .map_err(|e| match e {
                        rusqlite::Error::SqliteFailure(f, _)
                            if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                        {
                            Error::invalid(format!(
                                "cannot create {} {entity_id}: {e}",
                                entity.as_str()
                            ))
                        }
                        other => other.into(),
                    })?;
                let mut inv = Patch::new();
                inv.insert("deleted_at".into(), json!(self.now));
                inv
            }
            (_, OpKind::Update | OpKind::Delete | OpKind::Restore) => {
                if patch.is_empty() {
                    return Ok(());
                }
                let previous = self.read_fields(entity, &entity_id, &patch)?;
                let sets: Vec<String> = patch.keys().map(|k| format!("{k} = ?")).collect();
                let sql = format!("UPDATE {table} SET {} WHERE id = ?", sets.join(", "));
                let id_value = Value::String(entity_id.clone());
                let values = patch.values().chain(std::iter::once(&id_value)).map(Sql);
                self.tx.execute(&sql, params_from_iter(values))?;
                previous
            }
        };

        let hlc = self.clock.tick(self.now);
        for field in clock_fields(entity, &patch) {
            bump_clock(self.tx, entity, &entity_id, field, &hlc)?;
        }
        self.tx.execute(
            "INSERT INTO ops (op_id, device_id, hlc, entity, entity_id, kind, patch, inverse, batch_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                new_id(),
                self.device_id,
                hlc,
                entity.as_str(),
                entity_id,
                kind.as_str(),
                Value::Object(patch).to_string(),
                Value::Object(inverse).to_string(),
                self.batch_id,
            ],
        )?;
        self.last_seq = Some(self.tx.last_insert_rowid());
        self.touched.insert((entity.kind(), entity_id));
        Ok(())
    }

    /// Current values of the patched columns: the op's inverse.
    fn read_fields(&self, entity: Entity, id: &str, patch: &Patch) -> Result<Patch> {
        let cols: Vec<&str> = patch.keys().map(String::as_str).collect();
        read_row(self.tx, entity, id, &cols)?.ok_or_else(|| Error::not_found(entity.as_str(), id))
    }
}

/// Values of `cols` in a row (an empty patch when `cols` is empty), or `None` when the row
/// does not exist.
pub(crate) fn read_row(
    tx: &Transaction<'_>,
    entity: Entity,
    id: &str,
    cols: &[&str],
) -> Result<Option<Patch>> {
    let list = if cols.is_empty() {
        "1".to_owned()
    } else {
        cols.join(", ")
    };
    let sql = format!("SELECT {list} FROM {} WHERE id = ?1", entity.table());
    let row = tx
        .query_row(&sql, [id], |r| {
            let mut out = Patch::new();
            for (i, col) in cols.iter().enumerate() {
                let value = match r.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) => json!(f),
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into()),
                    ValueRef::Blob(_) => Value::Null,
                };
                out.insert((*col).to_owned(), value);
            }
            Ok(out)
        })
        .optional()?;
    Ok(row)
}

/// The fields an op writes, as `field_clocks` names them: the patch keys, or the tag id
/// for a tag link (each task-tag pair is one field).
pub(crate) fn clock_fields(entity: Entity, patch: &Patch) -> Vec<&str> {
    if entity == Entity::TaskTag {
        patch
            .get("tag_id")
            .and_then(Value::as_str)
            .into_iter()
            .collect()
    } else {
        patch.keys().map(String::as_str).collect()
    }
}

/// HLC of the latest write to a field, if any.
pub(crate) fn field_clock(
    tx: &Transaction<'_>,
    entity: Entity,
    id: &str,
    field: &str,
) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached(
            "SELECT hlc FROM field_clocks WHERE entity = ?1 AND entity_id = ?2 AND field = ?3",
        )?
        .query_row([entity.as_str(), id, field], |r| r.get(0))
        .optional()?)
}

/// Records a write to a field, keeping the newest HLC.
pub(crate) fn bump_clock(
    tx: &Transaction<'_>,
    entity: Entity,
    id: &str,
    field: &str,
    hlc: &str,
) -> Result<()> {
    tx.prepare_cached(
        "INSERT INTO field_clocks (entity, entity_id, field, hlc) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (entity, entity_id, field) DO UPDATE SET hlc = excluded.hlc
         WHERE excluded.hlc > field_clocks.hlc",
    )?
    .execute([entity.as_str(), id, field, hlc])?;
    Ok(())
}

/// A stored op, read back for undo and redo.
pub(crate) struct StoredOp {
    pub entity: Entity,
    pub entity_id: Id,
    pub kind: OpKind,
    pub inverse: Patch,
}

/// Ops of a batch, newest first (the order to undo them in).
pub(crate) fn batch_ops(tx: &Transaction<'_>, batch_id: &str) -> Result<Vec<StoredOp>> {
    let mut stmt = tx.prepare(
        "SELECT entity, entity_id, kind, inverse FROM ops WHERE batch_id = ?1 ORDER BY seq DESC",
    )?;
    let rows = stmt.query_map([batch_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut ops = Vec::new();
    for row in rows {
        let (entity, entity_id, kind, inverse) = row?;
        ops.push(StoredOp {
            entity: Entity::parse(&entity)?,
            entity_id,
            kind: OpKind::parse(&kind)?,
            inverse: serde_json::from_str(&inverse)?,
        });
    }
    Ok(ops)
}
