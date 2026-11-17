# Backups

## Local

Every day the app writes `daily-YYYY-MM-DD.sqlite` (UTC date) into `<data folder>/backups/`
and keeps the newest 14. Before an import it also writes `pre-import-<ms>.sqlite`. Each
file is a complete SQLite database: to restore one, quit the app and copy it over
`<data folder>/task-master.sqlite` (the current file can be renamed first), or open it as
the data folder's database by choosing that folder in Settings.

## Remote (any S3-compatible bucket)

The app uploads each daily backup to an S3-compatible bucket whenever it can reach it, and
retries every 15 minutes otherwise. Objects land at `<prefix>/<device id>/<file>`. Any
S3-compatible storage works: AWS S3, Backblaze B2, Cloudflare R2, Wasabi, or a
self-hosted MinIO or Garage. The app uses path-style requests
(`<endpoint>/<bucket>/<key>`).

1. Create a bucket, e.g. `task-master`, and an access key that may read and write it
   (and nothing else). For example, with Garage:

   ```sh
   garage bucket create task-master
   garage key create task-master-desktop          # prints the key id and secret
   garage bucket allow --read --write task-master --key task-master-desktop
   ```

2. In task-master, Settings → Remote backup:

   | Field | Value |
   | --- | --- |
   | Endpoint | Your provider's S3 endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or `https://s3.example.com` |
   | Bucket | `task-master` |
   | Region | Your provider's region (`garage` for Garage, `us-east-1` for MinIO by default) |
   | Prefix | `backups` |
   | Access key / Secret key | The key from step 1 |

"Test connection" writes `<prefix>/<device>/probe.txt`; "Save" stores the settings in
`<app config>/config.json` (user-readable only). When the endpoint is only reachable from
your home network or a VPN, uploads wait until the device is back on it.

Old uploads are kept until removed. To expire them automatically, add a lifecycle rule to
the bucket (most providers support expiration rules), for example keep 90 days.

If you run a [sync server](server.md), it can back up its own database to a bucket
too (`TM_BACKUP_S3_*`).
