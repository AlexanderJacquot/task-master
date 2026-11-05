# Public project pages

`site/` contains the static project homepage, privacy policy, terms of service, shared
stylesheet and app icon. They provide the public URLs requested in Google's OAuth
Branding configuration. There is no JavaScript, external font service, analytics, form
submission or build dependency.

The pages describe the current implementation: local tasks, the three Calendar scopes,
optional server credential transfers, backups, retention, revocation and third-party
hosting. Keep them consistent when those behaviors change. They identify Alexander
Jacquot as maintainer and link to the GitHub profile and project issues for contact;
no private email address has been inferred or published. The support email selected in
Google Cloud still needs to be a real address you monitor.

## Publish on the GitHub mirror

1. In [the GitHub repository settings](https://github.com/AlexanderJacquot/task-master/settings/pages),
   open **Pages → Build and deployment → Source** and select **GitHub Actions**.
2. Commit the `site/` directory and `.github/workflows/pages.yml` to `main` in the
   source repository and push normally. The existing Forgejo-to-GitHub mirror carries
   the files across. The **pages** workflow runs when those files change on `main`.
3. In GitHub **Actions → pages**, wait for the deployment to complete. If the workflow
   ran before Pages was enabled, rerun it or use **Run workflow** on `main`.
4. Open all three URLs below without logging in, and check the policy links on the homepage.

| Resource | Expected published URL |
| --- | --- |
| Homepage | `https://alexanderjacquot.github.io/task-master/` |
| Privacy policy | `https://alexanderjacquot.github.io/task-master/privacy.html` |
| Terms of service | `https://alexanderjacquot.github.io/task-master/terms.html` |
| App icon | `https://alexanderjacquot.github.io/task-master/assets/app-icon.png` |

The workflow uploads **only `site/`**. It uses the standard `github-pages` environment
and GitHub's Pages token permissions; no new secrets are needed. It is restricted to
`AlexanderJacquot/task-master` on `main` to avoid publishing from forks or other branches.
If you fork the project, update that restriction, the canonical URLs in the HTML and
the project/contact links before publishing your own copy.

The icon is the existing 128×128 PNG app artwork, also usable as an optional OAuth logo
upload. Its source is `apps/desktop/src-tauri/icons/128x128.png`.

See [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Configure Google Branding

After the pages are live, copy the first three URLs into Google's corresponding
homepage, privacy-policy and terms fields. Add **`alexanderjacquot.github.io`** under
**Authorized domains**, without a scheme or path. Set app name **task-master** and your
support/developer email, save, then return to **Audience → Publish app**.

Completing those fields and switching to **In production** is separate from requesting
Google's verification. Personal-use clients can qualify for Google's review exemption.
The [rclone OAuth setup guide](https://rclone.org/drive/#making-your-own-client-id)
documents GitHub Pages as an option for the same personal-client publishing blocker.

**A `github.io` site does not guarantee formal brand verification.** Google's
[domain-verification instructions](https://support.google.com/cloud/answer/13804266)
require DNS-level ownership verification, which you cannot do for GitHub's domain. For
that route, use a domain you own, verify its DNS in Search Console, configure it in
GitHub Pages, and update the canonical URLs, Google Branding URLs and authorized domain.
The HTML and relative asset links work with a custom domain too.

## Preview locally

No app server or Google credentials are needed:

```sh
python3 -m http.server 8080 --directory site --bind 127.0.0.1
```

Open `http://127.0.0.1:8080/`, `/privacy.html` and `/terms.html`. Check both your browser's
light and dark appearance and a narrow window. The public pages require no cookies or
authentication; GitHub Pages itself logs visitor IP addresses for security, as disclosed
in the privacy policy.
