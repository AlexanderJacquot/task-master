# Connecting Google Calendar

task-master currently syncs with Google Calendar through an OAuth desktop client you
configure in Google Cloud. Google may require public homepage and policy URLs before
letting you leave Testing, even for personal use. The pages in this repository provide
those resources; see [publishing the project pages](github-pages.md).
Design: `docs/adr/014-google-calendar-sync.md`.

## 1. Create the OAuth client

1. Open <https://console.cloud.google.com/> and create a project (e.g. "task-master").
2. **APIs & Services → Library**: search for "Google Calendar API" and click **Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - **Branding:** app name "task-master"; your Google account email as support and
     developer contact. Use the homepage, privacy policy and terms URLs below, after
     publishing those pages. Add `alexanderjacquot.github.io` to **Authorized domains**.
     A logo is optional; `site/assets/app-icon.png` is available if you want one.
   - **Audience:** user type **External**. While Testing, add your Google address as
     a test user.
   - **Data Access:** declare the scopes below. The app requests these at sign-in too.
   - **Audience → Publishing status → Publish app → In production.** If Publish app
     is disabled with "complete your configuration on the Branding page", save the
     required homepage, policy links and authorized domain in Branding first.
   - **Production status and verification are separate.** Google documents a personal-use
     exemption from review, so a personal client can remain unverified and display an
     "unverified app" warning. Displaying verified branding or making the integration
     publicly available may require Google's branding and sensitive-scope review.
     A GitHub Pages site is not a guarantee of approval for formal verification.
     In Testing, Calendar authorizations and refresh tokens expire after seven days.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type
   **Desktop app**. Copy the **client ID** and **client secret**.

Branding values for this repository's GitHub Pages site:

| Google field | Value |
| --- | --- |
| Application home page | `https://alexanderjacquot.github.io/task-master/` |
| Application privacy policy link | `https://alexanderjacquot.github.io/task-master/privacy.html` |
| Application terms of service link | `https://alexanderjacquot.github.io/task-master/terms.html` |
| Authorized domain | `alexanderjacquot.github.io` |

These URLs become available after [the Pages deployment](github-pages.md). If you use
another account, repository or custom domain, update the URLs and domain accordingly.

Scopes to add under **Data Access**:

- `https://www.googleapis.com/auth/calendar.app.created`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly`

References: [Google's Branding requirements](https://support.google.com/cloud/answer/15549049),
[personal-use verification exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#personal-use),
and [publishing status and token expiry](https://support.google.com/cloud/answer/15549945).

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

- **"To publish your app, you must complete your configuration on the Branding page"**:
  complete and save the public homepage and policy URLs and authorized domain, along
  with the app name, support email and developer contact. Return to Audience to publish.
- **Brand verification rejects domain ownership**: a repository URL on `github.com`
  cannot establish your ownership of that domain. Google's formal OAuth domain
  verification requires a domain you can verify through DNS. See [project pages](github-pages.md).
- **"calendar sign-in needed: invalid_grant"**: the sign-in expired or was revoked (or the
  consent screen is still in "Testing"). Disconnect and connect again.
- **"access_denied"** at sign-in: your address is not a test user, or you declined.
- The secret lives in `config.json` in the app's config folder, readable only by you.
  Disconnecting removes the token (the client ID and secret are kept for reconnecting).
