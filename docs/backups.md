# Backups

## Local

Every day the app writes `daily-YYYY-MM-DD.sqlite` (UTC date) into `<data folder>/backups/`
and keeps the newest 14. Before an import it also writes `pre-import-<ms>.sqlite`. Each
file is a complete SQLite database: to restore one, quit the app and copy it over
`<data folder>/task-master.sqlite` (the current file can be renamed first), or open it as
the data folder's database by choosing that folder in Settings.

## Remote (Garage in the homelab)

The app uploads each daily backup to an S3-compatible bucket whenever it can reach it, and
retries every 15 minutes otherwise. Objects land at `<prefix>/<device id>/<file>`.

One-time setup on the Garage host (the `garage` stack in the homelab repo; run the CLI
inside its container):

```sh
garage bucket create task-master
garage key create task-master-desktop          # prints the key id and secret
garage bucket allow --read --write task-master --key task-master-desktop
```

Then in task-master, Settings → Remote backup:

| Field | Value |
| --- | --- |
| Endpoint | `https://s3.solarnexus.space` |
| Bucket | `task-master` |
| Region | `garage` |
| Prefix | `backups` |
| Access key / Secret key | from `garage key create` |

"Test connection" writes `<prefix>/<device>/probe.txt`; "Save" stores the settings in
`<app config>/config.json` (user-readable only). `s3.solarnexus.space` is private, so
uploads happen on the home network (or VPN) and wait otherwise.

Old uploads are kept until removed. To expire them automatically, add a lifecycle rule to
the bucket (Garage supports expiration rules through the S3 API), for example keep 90 days.
