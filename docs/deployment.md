# Deployment contract

## Hosting decision

Host the static site directly on **Azure Static Web Apps Free**. No Cloudflare,
Front Door, application server, or paid redirect service is required.
The owner chose generated legacy navigation pages rather than a requirement
for HTTP 301 responses at every historical URL.

The hosting base is **$0 within Free quotas**, without employer credits.
Media storage/delivery, domain registration, taxes and any
separately approved services are additional. Free has no SLA or bandwidth
overage; exceeding a quota requires an explicit capacity decision, not an
automatic paid upgrade.

Contact is deferred entirely: no form provider, backend, replacement email
link or contact-delivery acceptance is required. Privacy obligations for the
actual hosting and media services remain.

The contact-deferral application change is integrated: no contact endpoint is
supplied or required. This does not waive the remaining release gates below.

Official [plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)
and [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas),
reviewed September 5, 2026, document 100 GB/app-month bandwidth, 250 MB per
environment, three preview environments and two custom domains for Free.
The repository additionally enforces 15,000 files and 250 MiB total output.
Recheck the provider's per-environment and aggregate limits against the actual
artifact before provisioning.

Use one family-owned SWA app, its production environment, and a named preview
environment for staging. Keep the existing registrar and DNS provider if they
support SWA domain validation and routing. SWA supplies managed HTTPS after
domain verification. Do not change nameservers merely to host this site.

The previously considered Cloudflare Worker would have cost $5/month paid to
Cloudflare, not Azure. Its HTTP redirect capability is unnecessary under the
owner-approved HTML navigation contract. Azure Front Door would add a paid
service and partitioned rules, also unnecessary.

## Historical URL navigation

The validated `redirectFrom` map generates a small `index.html` document at
each supported historical path. It contains:

- an immediate zero-second HTML meta refresh to the canonical destination;
- a matching canonical link;
- a visible, localized fallback link without a JavaScript dependency.

These pages return **HTTP 200, not HTTP 301**. Google documents immediate
[meta refresh as a permanent redirect signal](https://developers.google.com/search/docs/crawling-indexing/301-redirects),
but prefers server-side redirects when available. Non-browser clients may not
follow HTML refresh, and indexing outcomes are not guaranteed.

The Next.js application is a
[static export](https://nextjs.org/docs/app/guides/static-exports), not a
request-time server. Generating an old-to-new HTML page at build time keeps the
map in the application without depending on a runtime redirect handler.
The historical catalog therefore does not consume SWA's 20,000-byte
configuration allowance.

Source content, IDs, slugs and `redirectFrom` spelling remain unchanged.
Generation validates path safety before decoding each filename segment once.
Ambiguous percent encodings, unsafe or unrepresentable paths, Unicode/portable
filename collisions, source collisions and conflicts with existing output are
errors, not reasons to omit a legacy URL. Canonical route conflicts and cycles
remain checked together with hand-authored SWA routes.

Legacy pages are compatibility outputs, not new recipes or canonical pages.
They are excluded from sitemap, search and normal navigation. Their destination
is the approved canonical URL; arbitrary incoming query strings and fragments
are not interpolated into it. This is not arbitrary WordPress URL compatibility.

Actual SWA decoding of encoded Cyrillic/accented paths must pass staging
acceptance. A local file alone does not prove that a requested historical URL
will be served correctly. Any unsupported published source blocks launch.

## Prebuilt artifacts and release guard

The build owns two sibling outputs:

- `out/` contains public static site files, including generated legacy pages
  and the bounded `staticwebapp.config.json`.
- `.deployment/` contains ignored audit/deployment metadata. Never copy it
  into or upload it with the public site.

The generated `.deployment/redirect-manifest.json` now describes navigation
truthfully with this versioned shape:

```json
{
  "schemaVersion": 2,
  "mechanism": "html-refresh",
  "redirects": [
    {
      "source": "/historical-path/",
      "destination": "/recipes/canonical-path/"
    }
  ]
}
```

Version 1's HTTP 301 status entries are not accepted as proof of static legacy
page coverage. The map remains deterministic and derived from validated
content, not a second manually maintained catalog.

`build:ci` and `build:local` generate pages for local inspection but remain
nondeployable because their media configuration is not a production
configuration. Never relabel those outputs as a release.

`build:release` validates the real public configuration, canonical origin,
media closure, canonical route coverage, every expected legacy document and
output limits. Only then does it record the release artifact identity.
The former unconditional absent-edge blocker is replaced by concrete generated
output validation, not an operator bypass or a variable claiming success.

Builds clear prior metadata before validation, and failures invalidate it.
`deployment:generate` requires fresh output: it refuses to overwrite existing
legacy pages. Run a new static build instead of editing generated files or
regenerating over a prior export. A successful Next export replaces old output,
and final validation rejects missing, modified or stale legacy pages.

## Staging is public-content-only

SWA Free staging is not confidential hosting. Only content already approved for
public disclosure may be staged. Noindex is crawler guidance, not access
control.

This section describes the **release staging profile**, not an inherent lack
of authentication on SWA Free. The separate
[invited-family test profile](azure-family-test.md) uses built-in sign-in and
the invitation-only `family` role on a dedicated dev/test app. Its noindex,
access rules, same-origin test navigation and NONPROMOTABLE artifacts must
never enter this staging/production promotion flow. Its directly served Blob
media is still public; only already-approved public media is permitted.

Keep production canonical URLs and approved production media URLs in the
candidate's site bytes. There is no contact endpoint to configure or rehearse.

The staging-only SWA configuration applies these response policies at the
direct preview origin:

- `X-Robots-Tag: noindex`;
- `Content-Security-Policy: form-action 'none'`.

The form policy remains defense in depth against accidental browser submissions,
including without JavaScript. It does not introduce a form, provider or contact
rehearsal requirement, and it is not access control.

Only `staticwebapp.config.json` differs between staging and production trees.
Validate and digest the two configurations separately while proving the site
content bytes are unchanged. Never edit the retained production archive in
place, and never promote staging noindex or form blocking. Intrinsic noindex
on any retained noindex page must remain in production. The verifier checks
every retained file and its intrinsic policy without requiring contact routes.

## Deployment sequence and rollback

Use protected manual staging and production operations, not automatic
production deployment on push:

1. Select a reviewed commit and run required repository checks.
2. Build once with `npm run build:release` using the approved public
   configuration. Retain the exact production artifact and its metadata.
3. Prepare a separate staging tree with only the reviewed response-header
   differences. After staging approval, upload its `out/` to the named preview.
4. Verify every historical source, HTML navigation target, canonical response,
   Unicode/encoding case, direct-origin policy and artifact identity. A partial
   result is a failed acceptance.
5. After production approval, upload the retained original production artifact
   without rebuilding. Verify canonical host, TLS, legacy navigation and
   absence of staging-only response restrictions.
6. Retain the previous accepted production artifact. Rollback redeploys that
   exact artifact without rebuilding and verifies it again.

For `Azure/static-web-apps-deploy`, upload inputs are `app_location: "out"`,
`output_location: ""`, `skip_app_build: true` and `skip_api_build: true`.
`.deployment/` is never part of that upload.

Serialize mutations and refuse mismatched artifact identities. This is a
single-origin rollout; rollback takes a deployment and is not instantaneous.
Retaining an artifact is necessary for rollback but does not prove the recovery
procedure works. Drill restoration before cutover.

### Workflow controls

The checked-in [Azure deployment workflow](../.github/workflows/deploy.yml)
runs only by manual dispatch from protected `main`. Its `prepare` operation
builds once, waits for staging approval, verifies staging, then waits for a
separate production approval. A `rollback` operation restores a retained
accepted artifact without rebuilding.

| Dispatch input | Value |
| --- | --- |
| `operation` | `prepare` or `rollback` |
| `source_run` | `0` for prepare; the run ID carrying the desired `accepted-production` archive for rollback |
| `expected_production_run` | Latest accepted production run ID, or `0` before first production |

Use the public repository variable `NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL` for the
release build. No contact endpoint variable is supplied.
Set `STAGING_SITE_ORIGIN` to the exact approved generated preview HTTPS origin
in both the `staging` and `production` environments. Set
`PRODUCTION_SITE_ORIGIN` to the exact generated Azure production HTTPS origin
in the `production` environment. These are origin URLs only, with no trailing
slash, path, query, credentials or custom preview return URLs. They do not
change the site's production canonical origin.

Configure `AZURE_STATIC_WEB_APPS_API_TOKEN` separately in each protected
environment. Never place it in a public variable. The workflow checks actual
independent-review requirements and branch restrictions before mutation.
Administrator bypass settings, identity ownership and token scope still need
human review.

The Azure action is pinned to the official maintained `v1` release-branch
commit, not the older `v1` tag, which lacks the needed named-environment inputs.
The [pinned action declaration](https://github.com/Azure/static-web-apps-deploy/blob/4d27395796ac319302594769cfe812bd207490b1/action.yml)
documents `deployment_environment`, `skip_app_build` and `skip_api_build`.

Archives are retained for 90 days, subject to repository retention settings.
The stale-operation check searches 30 recent workflow runs and uses immutable
acceptance-artifact creation time, not a run's mutable rerun status. An older
run rerun cannot supersede a newer acceptance. Dispatch a new operation rather
than rerunning an already accepted run. If acceptance cannot be established in
the bounded history, stop and reconcile the deployment history; do not guess
`0` or weaken the guard.

This check is not a lock against direct out-of-band Azure changes. Keep routine
uploads in this workflow and reconcile any emergency manual intervention before
the next operation.

### Initial cutover

Production upload first checks the action's returned Azure origin against
`PRODUCTION_SITE_ORIGIN`, then verifies its retained files, navigation and
production response policy directly. This produces an origin-readiness report
in the job log, not canonical production acceptance.

While WordPress still serves `mycafegourmand.com`, the following canonical-host
check is expected to fail and no `accepted-production` archive is issued.
After successful direct-origin readiness, obtain the separate DNS/cutover
approval, establish SWA domain validation/TLS and change traffic through the
approved operator procedure. Then rerun **only the failed production job**:
it reuses the retained production artifact and staging receipt without rebuilding.
Do not rerun a previously accepted operation.

This requires unexpired artifacts, availability of GitHub's rerun operation,
unchanged approved preview-origin configuration and no intervening accepted
deployment. If those conditions no longer hold, prepare and accept a new
candidate. Never claim launch success until canonical HTTPS acceptance succeeds.
Do not configure an origin-to-canonical domain redirect that prevents the
required direct-origin readiness check; all site canonicals already use the
approved public host.

### Operator diagnostics

Use these local commands on a retained artifact root containing `out/` and
`.deployment/`; they do not deploy:

```sh
npx --no-install tsx scripts/release-artifact.ts validate candidate production
npx --no-install tsx scripts/release-artifact.ts prepare-staging candidate staging-output
npx --no-install tsx scripts/release-artifact.ts validate staging-output staging
```

The workflow invokes `scripts/verify-deployed-site.ts` for authorized live
verification and fixed metadata receipt paths. It checks retained file bytes,
reviewed browser MIME types, all historical source spellings, intrinsic
noindex pages and environment response policies. Canonical pages and assets
must respond directly with HTTP 200. Only a slashless historical source may
have one same-origin permanent slash-adding redirect before its HTTP 200 page.
Origin readiness cannot be substituted for canonical production acceptance.

## Accounts, credentials and launch approvals

Use family-owned billing and identities, MFA and recoverable administrators.
Do not depend on a work subscription or assume its credit permits family
production hosting. The exact employer offer and its eligibility are unknown;
the Free hosting decision does not require that credit.

Before external operations, an administrator must establish real staging and
production GitHub environments with required reviewers, restricted deployment
branches, reviewed bypass policy and environment-scoped credentials. YAML
environment names alone do not configure protection.

Use a resource-specific SWA deployment token for uploads where required, with
documented rotation. Use resource-scoped OIDC for approved infrastructure
operations where supported. Do not grant subscription Owner, unrelated DNS
permissions or deployment authority to PR CI or agent setup. Keep secrets out
of public configuration, logs and artifact metadata.

Separate owner/coordinator approvals are required for:

- account creation, billing and provisioning;
- credentials/environment administration and staging publication;
- production traffic and DNS changes.

Code approval is not permission for any of these external actions. Keep
WordPress operational until staging acceptance and cutover approval. Inventory
existing DNS, mail, verification and DNSSEC records; document domain/TLS setup
and a recovery path before changing traffic.

Production remains blocked until approved media verification, an accurate privacy
notice for the actual hosting/media data flows, all legacy URL tests, representative English/French/Russian
navigation/search/media/print/metadata checks and rollback acceptance succeed.
See [release-operations.md](release-operations.md) and
[repository-operations.md](repository-operations.md). No credential-free CI
run proves external settings or successful live publication.

## Full Content Security Policy

The staging `form-action 'none'` policy is a narrow submission guard, not a
claim of full CSP protection. A production CSP remains a separate reviewed
change: inventory the exact media origins and inline Next/JSON-LD
blocks, generate static-compatible hashes, exercise a report-only policy, then
enforce it after resolving expected violations.

Do not use broad `https:`, `unsafe-inline`, or a nonce the static host cannot
issue per response as substitutes for that work. Preserve same-origin search
fetches and the approved media origin. Contact remains outside launch scope.
