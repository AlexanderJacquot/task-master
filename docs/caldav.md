# Connecting iCloud, Fastmail or Nextcloud (CalDAV)

task-master syncs with any CalDAV calendar: iCloud (the calendar on an iPhone, iPad and
Mac), Fastmail, Nextcloud, or another CalDAV server. It works like the Google
integration. Your time blocks, day plans and due dates go to a calendar named
**task-master** in your account, and moving or deleting them there comes back to the app.
Your other calendars can show in the Calendar view, read-only.
Design: `docs/adr/037-caldav-calendar.md`.

One calendar account at a time: disconnect Google or Outlook first.

## 1. Make an app password

- **iCloud:** sign in at <https://appleid.apple.com>, open **Sign-In and Security →
  App-Specific Passwords**, and create one named "task-master". Your Apple ID password
  does not work here (two-factor authentication blocks it). The user name is your Apple
  ID's email address.
- **Fastmail:** **Settings → Privacy & Security**, create an app password with access to
  **Calendars (CalDAV)**. The user name is your Fastmail address.
- **Nextcloud:** **Personal settings → Security → Devices & sessions**, create an app
  password. The server is `https://<your server>/remote.php/dav`.

## 2. Connect

**Settings → Calendar → iCloud & CalDAV**: pick the provider (it fills in the server),
enter the user name and the app password, then **Connect**. The app finds your calendars
first, so a wrong password or address is reported right away. On the first sync it
creates the **task-master** calendar and shows your first writable calendar. Tick the
others you want to see.

The password is kept in your system's keychain: the macOS Keychain, the Windows
Credential Manager, or the Secret Service on Linux (GNOME Keyring, KWallet). It is never
written to `config.json`. On a Linux desktop without a Secret Service, connecting stops
with a message.

## On the sync server

With a sync server joined (docs/server.md), **Runs on → Server** moves the account to the
server, as for Google: the app sends the server URL, user name and password once, over
the authenticated API, and the server keeps them in its `calendar.json` (readable by its
user only). **This device** brings them back to the keychain.

## Good to know

- Edits made on the phone arrive at the next sync (every 5 minutes, or **Sync now**).
- If an item changed in both places since the last sync, the app's version wins.
- Floating times (an event with no time zone) are read in this device's zone; on the
  server, in the server's zone.
- Disconnecting removes the password from the keychain. The events stay in your calendar.
- To revoke access, delete the app password where you made it.
