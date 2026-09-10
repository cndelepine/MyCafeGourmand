# Release operations

This document defines artifact, historical URL, and media verification
boundaries for the existing Azure Static Web Apps static-export architecture.
Azure resource state must be established from current operator evidence, not
this document. Contact messaging is deferred entirely.
The owner-approved hosting design uses Azure Static Web Apps Free and generated
HTTP 200 legacy HTML navigation pages, not an edge provider or historical
HTTP 301 responses. Production remains blocked until the required content,
media, hosting and live acceptance gates pass. The authoritative
deployment sequence and artifact separation are in [`deployment.md`](deployment.md).

## Artifact classes

### Invited-family test artifacts

`npm run build:family-test` is a separate, explicitly **NONPROMOTABLE**
dev/test build. It requires the approved `FAMILY_TEST_SITE_ORIGIN` and public
`NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL`, retains production canonical metadata,
and uses test-only same-origin legacy navigation plus invitation-based access.
It writes `.deployment/family-test-artifact.json`, never release metadata or
staging/production acceptance receipts. Existing production validators reject
it. Follow [Azure family testing](azure-family-test.md), not the release
deployment workflow. A successful family test is not production acceptance
and requires no WordPress DNS cutover.

### Local and CI artifacts

`npm run build:local` and `npm run build:ci` run the same credential-free static
build and write `out/`. They include sitemap, robots, localized routes, search
indexes, and generated Static Web Apps configuration, but they leave canonical
Blob media keys root-relative. They are useful for validation and preview and
must not be deployed.

Both commands reject `NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL`. Contact routes render
localized no-service notices in every artifact; no endpoint can enable a form.

Preview a completed local artifact with:

```sh
npm run build:local
npm run preview
```

This uses Python's static file server. The project intentionally has no
`next start` command.

### Release artifacts

The only production artifact command is:

```sh
export NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL="https://<approved-media-host>/<container>"
npm run build:release
```

`build:release` rejects invalid public values and performs pre-build and output
validation, including complete generated legacy-page coverage. A successful
local release build is not approval to deploy and does not prove live Azure
path behavior. The canonical site origin must remain
`https://mycafegourmand.com`. The media base must be absolute HTTPS with no
credentials, query, or fragment. It may be a validated Blob or CDN/custom-domain
base after that external infrastructure exists.

The media output validator scans bounded deployable artifacts, including
HTML, CSS, JavaScript, React Flight/RSC text, and JSON-LD. It rejects:

- root-relative manifest-backed media;
- media keys absent from the appropriate public manifest;
- a different origin or base path;
- managed-media URLs that do not resolve exactly from the configured HTTPS base.

The same command checks static route/file coverage and output size limits.
These validators do not prove media-provider approval or correct live deployment.

Never deploy the output of `build`, `build:static`, `build:local`, or
`build:ci`.

## Contact deferred

The owner deferred contact messaging for launch. There is no submission form,
contact provider, backend or email-link replacement. Builds do not require or
use `NEXT_PUBLIC_CONTACT_FORM_ENDPOINT`; remove obsolete values from operator
configuration. No contact account, delivery test or subscription is a launch gate.

The historical canonical pages `/contact/`, `/fr/contact-2/` and `/ru/kontact/`
remain available with localized no-service notices and recipe navigation.
Their frozen editorial records, translation relationships and URLs are unchanged;
presentation suppresses obsolete source invitations to send messages or comments.
Primary and mobile navigation no longer promote contact.

The previously generated `/contact/success/`, `/fr/contact/success/` and
`/ru/contact/success/` paths remain reserved compatibility pages, with the same
no-service notices rather than message-received claims. They retain canonical
URLs and noindex metadata and stay excluded from the sitemap.

Privacy approval must still reflect actual hosting, media and any other approved
services and their real data flows. Contact deferral is not a claim that no data
is processed and does not approve a privacy notice. Do not restore the obsolete
WordPress privacy text. Reintroducing contact requires a separate owner decision.

## Historical URL navigation

Builds validate every recipe and editorial `redirectFrom` path, generate a
static HTML navigation page at its supported output path, and write
`.deployment/redirect-manifest.json`. The version-2 metadata explicitly records
`mechanism: "html-refresh"` and source/destination pairs, not HTTP 301 statuses.
It stays outside the public `out/` artifact. Sources are root-relative local
paths without queries or fragments. Destinations are matching canonical locale
paths with static-export trailing slashes.

Each legacy page has an immediate meta refresh, matching canonical URL and
localized fallback link, with no JavaScript requirement. It returns HTTP 200.
Google recognizes immediate refresh as a permanent signal, but server-side
redirects are preferable when available and non-browser clients may not follow
HTML refresh. The owner accepted this tradeoff for simpler Azure-only hosting.
Do not silently substitute JavaScript-only redirects or claim HTTP 301 behavior.

The separate `out/staticwebapp.config.json` is limited to 20,000 UTF-8 bytes and
contains the origin trailing-slash policy and baseline headers, not the
historical navigation catalog. See [`deployment.md`](deployment.md) for the
manifest shape, safe legacy output generation, stale-output handling and
staging-only submission policy.

Keep unrelated hand-authored Azure routes, headers, and fallback settings in
`config/staticwebapp.config.json`. Never place a hand-authored copy in
`public/`. The generator merges both sources and rejects:

- duplicate redirect sources;
- canonical-route sources;
- conflicts between generated and hand-authored routes;
- redirect cycles;
- wildcard redirect routes whose cycles cannot be proven statically.

The migration preserves old-link navigation only for published source permalinks,
safe `_wp_old_slug` values on the same source parent, and enabled exact
Redirection URL/301 rows that terminate at promoted content. The latter describes
the source evidence, not the new site's HTTP response status. It does not
promise taxonomy, feed, attachment, print, shortlink, or arbitrary WordPress
compatibility.

## Media upload boundary

The authenticated media-plan commands in
[`migration-operations.md`](migration-operations.md) create private exact
object trees. They do not contact Azure and accept no Azure credentials,
account, container, or destination.

External provisioning and upload are separate, interactively authenticated
operator actions. Use only real, approved values in the operator shell. The
storage/CDN configuration must provide:

- HTTPS-only delivery;
- public anonymous read of individual objects, not container listing;
- production-origin `GET` and `HEAD` CORS rather than a wildcard;
- the manifest-normalized MIME type for every object;
- the approved immutable cache policy;
- no overwrite of an existing object during a resumed upload.

Do not infer success from an upload command or provider metadata. Skipped
objects and retries must be reconciled with the repository verifier.

## Post-upload verification

Verify recipe and editorial/gallery plans together so duplicate object keys are
also rejected:

```sh
npm run media:verify-azure -- \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --container "$AZURE_STORAGE_CONTAINER" \
  --upload-dir migration-output/wprm-media-azure-v6 \
  --upload-dir migration-output/editorial-media-azure-v4
```

The verifier constructs the bounded HTTPS URL and streams every expected
object. It requires:

- the exact requested origin and path with no redirect;
- status `200`;
- the upload plan's normalized `Content-Type`;
- expected `Content-Length` and exact streamed byte count;
- exact manifest SHA-256.

It does not trust caller-supplied object metadata or an Azure CLI property
lookup. It prints aggregate results only. Do not delete either private object
tree until combined verification succeeds.

## Release gate

Before a production artifact can be considered deployable:

1. `npm run check` and `npm run build:ci` pass on the reviewed commit.
2. Both media upload plans match their authenticated source and public
   manifests.
3. Combined remote media verification succeeds.
4. The owner approves the real media origin and accurate privacy information
   for the actual services.
5. Every historical mapping has a validated generated HTML navigation page;
   `npm run build:release` succeeds with those exact public values.
6. The production `out/` passes the release output validator. Its staged variant
   passes every live old-path/encoding/navigation check with noindex and
   technically blocked ordinary form submissions. Promote the retained
   production artifact without rebuilding or copying staging-only response
   restrictions. Never copy `.deployment/` into the public upload tree.
7. Inspect historical contact and former success URLs in all locales: no
   submission controls, email-link replacement, obsolete invitations or receipt
   claims; compatibility noindex boundaries remain intact.

No repository document or credential-free CI run proves that external Azure,
DNS, TLS, CORS or GitHub settings are configured.
