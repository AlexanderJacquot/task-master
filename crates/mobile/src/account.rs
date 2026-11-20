//! Signing in to an OpenID server, attachments, and the app's life cycle (going to the
//! background and back).

use std::sync::Arc;

use taskmaster_client::oidc;
use taskmaster_core::{Command, NewAttachment, clean_file_name, mime_for};

use crate::{AppError, AppResult, Core, Inner, SyncStatus, lock, not_found};

/// A sign-in in progress (ADR 030): show [`SignIn::page`] in the system's sign-in sheet
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
        let store = lock(&self.inner.store);
        let attachment = store.attachment(&id).map_err(|_| not_found("attachment"))?;
        let files = store.files()?;
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
        let hash = lock(&self.inner.store)
            .attachment(&id)
            .map_err(|_| not_found("attachment"))?
            .hash;
        Ok(self.inner.engine.fetch_file(&*self.inner, &hash)?)
    }

    /// Attaches a file (a photo, a shared document) to a task: its content is copied into
    /// the app's store, so the original can go. `name` is shown; empty takes the file's
    /// own name. Returns the attachment's id.
    pub fn attach_file(&self, task_id: String, path: String, name: String) -> AppResult<String> {
        let mut store = lock(&self.inner.store);
        let stored = store.files()?.put_file(&path)?;
        let name = if name.trim().is_empty() {
            std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            name
        };
        let name = clean_file_name(&name);
        let id = taskmaster_core::new_id();
        store.execute(Command::CreateAttachment {
            attachment: NewAttachment {
                id: Some(id.clone()),
                task_id: Some(task_id),
                meeting_id: None,
                hash: stored.hash,
                mime: Some(mime_for(&name).to_owned()),
                name,
                size: stored.size,
            },
        })?;
        Ok(id)
    }

    /// Removes an attachment from its task (the content stays until purged).
    pub fn remove_attachment(&self, id: String) -> AppResult<()> {
        lock(&self.inner.store).execute(Command::DeleteAttachment { id })?;
        Ok(())
    }

    /// The app is going to the background: everything written is moved into the database
    /// file, so iOS can suspend the app without part of it left in the log.
    pub fn suspend(&self) -> AppResult<()> {
        lock(&self.inner.store).checkpoint()?;
        Ok(())
    }

    /// The app is back: picks up what a widget or the share extension wrote meanwhile
    /// (screens reload through the listener) and asks for a sync round.
    pub fn resume(&self) -> AppResult<()> {
        lock(&self.inner.store).refresh_external_changes()?;
        self.inner.engine.kick();
        Ok(())
    }
}
