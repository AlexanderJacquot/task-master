//! Secrets in the OS keychain (ADR 037): macOS Keychain, Windows Credential Manager, the
//! Secret Service on Linux (GNOME Keyring, KWallet). Used for the CalDAV password; there
//! is no plain-text fallback.

const SERVICE: &str = "task-master";

/// The keychain entry name of a CalDAV account: `caldav:<user>@<host>`.
pub fn caldav_entry(server_url: &str, username: &str) -> String {
    let host = taskmaster_client::caldav::normalize_url(server_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_else(|| server_url.trim().to_owned());
    format!("caldav:{}@{host}", username.trim())
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| match e {
        keyring::Error::NoDefaultStore => {
            "this system has no keychain to keep the password in (on Linux, install and \
             unlock GNOME Keyring or KWallet)"
                .to_owned()
        }
        other => format!("cannot open the keychain: {other}"),
    })
}

pub fn set(name: &str, secret: &str) -> Result<(), String> {
    entry(name)?
        .set_password(secret)
        .map_err(|e| format!("cannot save the password in the keychain: {e}"))
}

/// `None` when there is no such entry.
pub fn get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("cannot read the password from the keychain: {e}")),
    }
}

/// Removing an entry that is not there succeeds.
pub fn delete(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("cannot remove the password from the keychain: {e}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn entries_are_named_by_user_and_host() {
        assert_eq!(
            super::caldav_entry("caldav.icloud.com", " me@icloud.com "),
            "caldav:me@icloud.com@caldav.icloud.com"
        );
        assert_eq!(
            super::caldav_entry("https://cloud.example.org/remote.php/dav", "alice"),
            "caldav:alice@cloud.example.org"
        );
    }
}
