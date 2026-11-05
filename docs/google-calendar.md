# Connecting Google Calendar

task-master syncs with Google Calendar through your own OAuth client. Setting it up takes
about ten minutes, once. It is free: the Calendar API has no charge and needs no billing
account. Design: `docs/adr/014-google-calendar-sync.md`.

## 1. Create the OAuth client

1. Open <https://console.cloud.google.com/> and create a project (e.g. "task-master").
2. **APIs & Services → Library**: search for "Google Calendar API" and click **Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type **External**; app name "task-master"; your email as support and developer
     contact.
   - Scopes: you can skip this step (the app asks for its scopes at sign-in).
   - Test users: add your Google address.
   - **Publishing status: click "Publish app" → In production.** In "Testing", Google
     ends the sign-in after 7 days. You don't need to submit for verification: Google
     shows an "unverified app" warning at sign-in, which is fine for your own use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type
   **Desktop app**. Copy the **client ID** and **client secret**.

## 2. Connect in task-master

Settings → Calendar: paste the client ID and secret, then **Connect Google Calendar**.
Your browser opens Google's sign-in. On the "Google hasn't verified this app" warning,
choose **Advanced → Go to task-master (unsafe)**, then allow access. The tab then says
"Connected" and the first sync starts a few seconds later.

What the app may do, and nothing more:

- create a calendar named **task-master** and manage the events in it,
- see the list of your calendars and read their events.

## 3. Using it

- Time blocks appear in the **task-master** calendar as events. Done ones get a ✓.
  Planned days appear as all-day events, which do not mark you as busy.
- Due dates appear as separate all-day **Due: Task name** events, also marked as free.
  A task planned for Monday and due Friday has a plan on Monday and a deadline on Friday,
  even if it also has time blocks. Completed tasks' deadlines get a ✓.
  Changing or clearing a due date updates or removes its deadline event.
- Moving, resizing or deleting those events in Google Calendar changes the block or plan
  in the app. Moving a deadline changes the due date; deleting it clears the due date.
  These changes can be undone in the app. If both sides changed since the last sync,
  the app's version wins.
- New events are created for dates from the last 30 days onward. Events already synced
  stay in sync regardless of their date.
- In Settings → Calendar, tick the calendars whose events should show in the Calendar view
  (your primary calendar is ticked at first). They are read-only in the app.
- Sync runs every 5 minutes, a few seconds after you change something, and on **Sync now**.

## Run Calendar on your server

After joining a task-master sync server, Settings → Calendar offers **Runs on: This
device / Server**. Choosing Server transfers your OAuth client and refresh token and
keeps syncing when the desktop is closed. Choosing This device waits for the server
worker to finish and transfers ownership back. Existing events are relinked, not copied.
See [server setup](server.md#6-connect-the-desktop-m13) for credential storage, leases
and recovery. To disconnect Google, first move it back to This device.

## Troubleshooting

- **"calendar sign-in needed: invalid_grant"**: the sign-in expired or was revoked (or the
  consent screen is still in "Testing"). Disconnect and connect again.
- **"access_denied"** at sign-in: your address is not a test user, or you declined.
- The secret lives in `config.json` in the app's config folder, readable only by you.
  Disconnecting removes the token (the client ID and secret are kept for reconnecting).
