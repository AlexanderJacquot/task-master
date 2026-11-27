//! Signing in to an OpenID server, attachments, and the app's life cycle (going to the
//! background and back).

use std::sync::Arc;

use taskmaster_client::{Client, oidc};
use taskmaster_core::{Attachment, Command, NewAttachment, Store, clean_file_name, mime_for};

use crate::{AppError, AppResult, Core, Inner, SyncStatus, lock, not_found};

/// A sign-in in progress (ADR 040): show [`SignIn::page`] in the system's sign-in sheet
/// (`ASWebAuthenticationSession`), which comes back to the app's redirect URL; hand that
/// URL to [`SignIn::finish`].
#[derive(uniffi::Object)]
pub struct SignIn {
    inner: Arc<Inner>,
    server: String,
    flow: oidc::Flow,
}

#[uniffi::export]
impl SignIn {
    /// The provider's sign-in page.
    pub fn page(&self) -> String {
        self.flow.auth_url.clone()
    }

    /// Ends the sign-in with the URL the sheet came back with: trades it for this phone's
    /// server token and saves it. Uses the network.
    pub fn finish(&self, redirect_url: String) -> AppResult<SyncStatus> {
        let code = self
            .flow
            .code_from_redirect(&redirect_url)
            .map_err(|message| AppError::Invalid { message })?;
        let id_token = self
            .flow
            .finish(&code)
            .map_err(|message| AppError::Invalid { message })?;
        let status = self
            .inner
            .engine
            .finish_sign_in(&*self.inner, &self.server, &id_token)?;
        Ok(self.inner.status(status))
    }
}

/// Where an attachment's content is on this phone.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AttachmentFile {
    /// Absolute path of the content (named by its hash; give Quick Look `name`).
    pub path: String,
    pub name: String,
    pub mime: String,
    /// The content is there; otherwise call `fetch_attachment` first.
    pub on_device: bool,
}

#[uniffi::export]
impl Core {
    /// Starts signing in to the connected server's identity provider. `redirect` is the
    /// app's registered callback (`taskmaster://oidc/callback`). Uses the network.
    pub fn sign_in(&self, redirect: String) -> AppResult<Arc<SignIn>> {
        let (server, issuer, client_id) = self.inner.engine.sign_in_target(&*self.inner)?;
        let flow = oidc::begin(&issuer, &client_id, &redirect)
            .map_err(|message| AppError::Invalid { message })?;
        Ok(Arc::new(SignIn {
            inner: self.inner.clone(),
            server,
            flow,
        }))
    }

    /// Where an attachment's content is.
    pub fn attachment(&self, id: String) -> AppResult<AttachmentFile> {
        let (attachment, team) = self.inner.find_attachment(&id)?;
        let files = self
            .inner
            .files(team)
            .ok_or_else(|| AppError::internal("this phone has no folder for attachments"))?;
        Ok(AttachmentFile {
            path: files.path(&attachment.hash)?.to_string_lossy().into_owned(),
            on_device: files.contains(&attachment.hash),
            name: attachment.name,
            mime: attachment.mime,
        })
    }

    /// Downloads an attachment's content from the server when it is not on the phone yet.
    /// False when the server does not have it (yet). Uses the network.
    pub fn fetch_attachment(&self, id: String) -> AppResult<bool> {
        let (attachment, team) = self.inner.find_attachment(&id)?;
        if !team {
            return Ok(self
                .inner
                .engine
                .fetch_file(&*self.inner, &attachment.hash)?);
        }
        // A team attachment comes from the team space's routes, with the same token.
        let account = taskmaster_client::engine::Host::account(&*self.inner)
            .filter(|a| a.joined)
            .ok_or_else(|| AppError::Invalid {
                message: "join a sync server first".into(),
            })?;
        let client = Client::new(&account.url, account.token).team();
        taskmaster_client::fetch_file(&client, &self.inner.team, &attachment.hash)
            .map_err(|e| AppError::internal(e.to_string()))
    }

    /// Attaches a file (a photo, a shared document) to a task: its content is copied into
    /// the app's store, so the original can go. `name` is shown; empty takes the file's
    /// own name. Returns the attachment's id.
    pub fn attach_file(&self, task_id: String, path: String, name: String) -> AppResult<String> {
        // Stored in the personal folder first; for a team task the spaces layer copies it
        // into the team's.
        let stored = lock(&self.inner.store).files()?.put_file(&path)?;
        let name = file_name(&path, &name);
        let id = taskmaster_core::new_id();
        let command = Command::CreateAttachment {
            attachment: NewAttachment {
                id: Some(id.clone()),
                task_id: Some(task_id),
                meeting_id: None,
                note_id: None,
                hash: stored.hash,
                mime: Some(mime_for(&name).to_owned()),
                name,
                size: stored.size,
            },
        };
        self.inner.execute(vec![command], None)?;
        Ok(id)
    }

    /// Removes an attachment from its task (the content stays until purged).
    pub fn remove_attachment(&self, id: String) -> AppResult<()> {
        self.inner
            .execute(vec![Command::DeleteAttachment { id }], None)?;
        Ok(())
    }

    /// The app is going to the background: everything written is moved into the database
    /// file, so iOS can suspend the app without part of it left in the log.
    pub fn suspend(&self) -> AppResult<()> {
        lock(&self.inner.store).checkpoint()?;
        if let Some(team) = lock(&self.inner.team).as_mut() {
            team.checkpoint()?;
        }
        Ok(())
    }

    /// The app is back: picks up what a widget or the share extension wrote meanwhile
    /// (screens reload through the listener) and asks for a sync round.
    pub fn resume(&self) -> AppResult<()> {
        lock(&self.inner.store).refresh_external_changes()?;
        if let Some(team) = lock(&self.inner.team).as_mut() {
            team.refresh_external_changes()?;
        }
        self.inner.engine.kick();
        Ok(())
    }
}

impl Inner {
    /// An attachment and whether it lives in the team space.
    fn find_attachment(&self, id: &str) -> AppResult<(Attachment, bool)> {
        let find = |store: &Store| store.attachment(id).ok();
        if let Some(a) = find(&lock(&self.store)) {
            return Ok((a, false));
        }
        lock(&self.team)
            .as_ref()
            .and_then(find)
            .map(|a| (a, true))
            .ok_or_else(|| not_found("attachment"))
    }
}

/// The name an attached file shows: `name`, or the file's own when empty, cleaned.
pub(crate) fn file_name(path: &str, name: &str) -> String {
    if name.trim().is_empty() {
        let own = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        clean_file_name(&own)
    } else {
        clean_file_name(name)
    }
}
