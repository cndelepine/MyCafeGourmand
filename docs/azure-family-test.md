# Retained Azure family test

This is an invited-family **TEST** site, not a production launch or the
public-content release staging profile in [deployment.md](deployment.md).
Use one dedicated Azure Static Web Apps **Free** app, its stable default
`https://<assigned-host>.azurestaticapps.net` origin, and its primary slot.
Azure labels that slot **production**; this does not make it the family's
production website. Extra preview environments are disabled. Do not connect a
repository in Azure, configure custom domains, change DNS, or touch WordPress.

**Leave the test resources running.** This supersedes the earlier shutdown
request. There is no expiry job, automatic deletion, paid upgrade or production
promotion. Future teardown needs a new, explicit, resource-specific approval.

## What is and is not private

- All site content and site-hosted assets require the custom role `family`.
  Only the standalone multilingual `/_family-test/login.html` and
  `/_family-test/denied.html` pages, plus Azure's `/.auth/*` endpoints, are
  anonymous. Ordinary provider sign-in grants `authenticated`, **not**
  `family`. No role-assignment function, SAS, backend or custom identity-provider
  registration is used.
- **Blob media is public**, including to anonymous nonbrowser clients with an
  object URL. Container listing is not anonymous. CORS is a browser policy,
  **not access control**. Upload only media already authorized for public
  disclosure; private photos need a separately approved design.
- This repository is public. Invitation gating controls access to the running
  test site, not the confidentiality of checked-in content.
- Keep subscription details, invitations, identities, cookies, upload plans and
  live evidence out of Git, Actions logs, chat, screenshots and public artifacts.
  Existing private migration staging follows
  [migration-operations.md](migration-operations.md); do not relocate or clean
  up that staging as part of this procedure.

## Approval and prerequisites

Code review, local compilation, cloud inspection, resource creation, role
grants, public media upload, GitHub secret writes, site upload, invitations,
billing changes and deletion are distinct authorization boundaries. The
commands below are an **operator runbook**, not permission for an agent to
execute them. Stop if any prerequisite is unresolved.
Before **each external mutation**, privately recheck the selected subscription,
its `Enabled` state, and spending limit `On` in the portal, alongside the exact
approved operation/resource scope. An earlier successful check is not permission
to assume the subscription or limit is unchanged.

1. Privately select the exact owner-authorized Azure subscription. In the
   Azure portal's **Subscriptions → selected subscription → Overview** and
   **Cost Management + Billing**, verify the actual offer and entitlement.
   Confirm Visual Studio Enterprise's **$150/month** credit and dev/test-only
   use apply to this subscription. Do not infer the offer from its display name.
   Confirm the **spending limit is enabled and remains enabled indefinitely**.
   Never choose “remove spending limit”, PAYG conversion, paid SWA capacity or
   Marketplace purchases to get past a blocker.
2. Verify West Europe availability, Azure policy and provider registration for
   `Microsoft.Web` and `Microsoft.Storage`. Proposed location is `westeurope`,
   parameterized for replication; region/offer restrictions are blockers.
   Provider registration is subscription-scoped: request separate approval if
   registration is missing; do not implicitly register unrelated providers.
3. Obtain an approved dedicated test resource-group name and unused resource
   names. No real subscription IDs, emails or tokens belong in parameter files.
4. Use Node from `.nvmrc`, locked dependencies and current official Azure CLI
   and Bicep tooling. Local checks do not require Azure login:

   ```sh
   az version
   az bicep version
   az bicep build --file infra/azure/main.bicep --stdout > /dev/null
   npx --no-install tsx --test test/azure-infrastructure.test.ts
   ```

   If Bicep is missing, stop and coordinate the official compiler installation
   with the owner (`az bicep install` is the documented installer). Do not run
   concurrent Homebrew/Azure installations. A skipped compiler test is not
   proof of compilation or Azure readiness.
5. An administrator must establish GitHub's `family-test` environment and
   protect `main` before any deployment secret or workflow execution. The
   implementation-time read-only audit found the current token lacked
   administrator permission and `family-test` did not exist. Treat these
   gates as blocked until independently verified, not as settings code creates.

### Least privilege

An administrator can create the dedicated RG and give the provisioning operator
temporary **Contributor at that RG only** for incremental deployments and
what-if. What-if requires deployment permissions; it is not simply Reader.
Do not give CI subscription Owner or an Azure subscription credential.

Separate data-plane upload access: grant an approved human
**Storage Blob Data Contributor scoped to the one container**, only after
explicit role-grant approval. Contributor on the RG is not Blob data access.
An authorized RBAC administrator, not this template, grants that role; allow
time for propagation. Portal browsing may additionally need Reader on the
storage account, but CLI upload does not require account-key permission.

Use an SWA-scoped management role with the necessary operations for the
operator managing invitations/deployment tokens, rather than retaining RG
Contributor indefinitely. The workflow receives only this dedicated test
app's deployment token. Bicep creates **no role assignments or identities**.

## Provision the dedicated test group

Use a private operator shell with tracing disabled. Assign variables privately;
angle-bracket values below are placeholders, never actual subscription data.
Store the reviewed parameter copy and deployment evidence in an
owner-controlled private location outside Git and public build directories.

```sh
set +x
set -euo pipefail
az login --output none
az account set --subscription "$PRIVATE_SUBSCRIPTION"
az account show --query '{name:name,state:state}' --output table
az provider show --namespace Microsoft.Web --query registrationState --output tsv
az provider show --namespace Microsoft.Storage --query registrationState --output tsv
```

Privately set `RG`, `SWA`, `STORAGE`, `CONTAINER`, `PARAMETERS` and `LOCATION`
to the exact approved values. `PARAMETERS` names a private copy of
[`family-test.parameters.example.json`](../infra/azure/family-test.parameters.example.json).
Replace the illustrative SWA/storage names: storage names must be globally
unique, 3–24 lowercase letters/digits; container names follow Azure's lowercase
3–63 character rules. Use the same parameters and deployment name on retries.
The example has no account binding; `az account set` and `--resource-group`
select it at runtime.

**After exact RG-creation approval**, create the group once (or inspect and reuse
that exact dedicated group). `az group create` is idempotent for the same
approved name/location, but is still a mutation:

```sh
az group create --name "$RG" --location "$LOCATION" \
  --tags environment=family-test retention=retain-until-explicit-owner-approval \
  --output none
az resource list --resource-group "$RG" --output table
az deployment group what-if --resource-group "$RG" --name family-test \
  --template-file infra/azure/main.bicep --parameters "@$PARAMETERS" \
  --mode Incremental
```

Review the full what-if privately before authorizing the matching apply. Expect
exactly these managed resource types (children may appear nested in portal views):

| Type | Intended state |
| --- | --- |
| `Microsoft.Web/staticSites` | Free; primary slot only; no repo, enterprise CDN or domain integration |
| `Microsoft.Storage/storageAccounts` | StorageV2, Standard_LRS, Hot; HTTPS/TLS 1.2; shared key off; OAuth preferred; cross-tenant replication off |
| `Microsoft.Storage/storageAccounts/blobServices` | `default`; exact-origin GET/HEAD CORS |
| `Microsoft.Storage/storageAccounts/blobServices/containers` | One container; `publicAccess: Blob`, never `Container` |

No VM, App Service plan, function, API, database, CDN, diagnostic workspace,
role grant, budget, DNS resource or storage static website is needed. Stop for
deletes, replacements, unexpected resources, SKU changes or unrelated
modifications. Incremental mode is not a safety substitute for inspecting the
diff and existing resources.

The normal Bicep path obtains the actual SWA `defaultHostname` with an ARM
reference; it never guesses or accepts an arbitrary CORS test origin. ARM
what-if can leave new-resource references unresolved. **Do not describe that
as a fully evaluated CORS change.** If necessary:

1. Review/apply the same template with `includeTestOrigin=false`, creating
   only the empty resources and production-origin CORS. No media upload yet.
2. Discover the generated SWA origin using the command below.
3. Review a second what-if with `includeTestOrigin=true` (the default), then
   explicitly approve/apply the exact two-origin CORS state.
4. Inspect the live CORS rule; do not proceed if the actual origin is absent.

Keep the chosen override identical between each what-if and its approved apply.
For the normal/default or final pass:

```sh
az deployment group create --resource-group "$RG" --name family-test \
  --template-file infra/azure/main.bicep --parameters "@$PARAMETERS" \
  --mode Incremental --output none

HOST="$(az staticwebapp show --resource-group "$RG" --name "$SWA" \
  --query defaultHostname --output tsv)"
export FAMILY_TEST_SITE_ORIGIN="https://$HOST"
export NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL="$(az deployment group show \
  --resource-group "$RG" --name family-test \
  --query properties.outputs.recipeMediaBaseUrl.value --output tsv)"
az storage account blob-service-properties show \
  --resource-group "$RG" --account-name "$STORAGE" --query cors --output json
az staticwebapp show --resource-group "$RG" --name "$SWA" \
  --query '{host:defaultHostname,sku:sku.name,previews:stagingEnvironmentPolicy,repository:repositoryUrl}' \
  --output json
```

The first-pass override is `--parameters "@$PARAMETERS" includeTestOrigin=false`;
the second is `--parameters "@$PARAMETERS" includeTestOrigin=true`. Add the same
override to both commands for that pass. Confirm no automatic Azure repository
integration: if using the portal rather than Bicep to inspect setup, choose
deployment source **Other**, never authorize a GitHub repository connection.
Use Bicep for the reviewed resource state; do not create a duplicate app in the
portal. Confirm previews disabled, no custom domains, and Free SKU.

Only HTTPS site/media URLs are Bicep outputs; no keys, deployment tokens,
subscription IDs or resource IDs are emitted. Retain the actual URLs privately
with the approved configuration and compare the workflow's returned hostname.

## Protect GitHub, then bind only the test app

An independent administrator follows
[repository-operations.md](repository-operations.md#administrator-owned-launch-gates):

1. Protect `main` with PR review, stale-review dismissal, required CI/CodeQL,
   resolved conversations and no force push/deletion.
2. In **Repository Settings → Environments**, create **family-test**. Configure
   a real independent required reviewer, **prevent self-review**, and disable
   administrator bypass. Require **selected branches/tags → branch `main`**
   only, not all protected branches or wildcard/tag patterns. Confirm the
   repository plan actually supports these protections.
3. Add environment variables `FAMILY_TEST_SITE_ORIGIN` (exact discovered HTTPS
   origin, no trailing slash) and `NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL` (exact
   deployed HTTPS container base, no trailing slash).
4. Only after approval to read the SWA token and write the GitHub secret, pipe it
   directly from Azure into the environment secret. Set `REPO` to the reviewed
   repository; never print the token, use `tee`, put it in arguments, save it
   to a file or enable debug/trace output:

   ```sh
   set +x
   set -euo pipefail
   az staticwebapp secrets list --resource-group "$RG" --name "$SWA" \
     --query properties.apiKey --output tsv --only-show-errors \
     | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN \
         --env family-test --repo "$REPO"
   gh variable set FAMILY_TEST_SITE_ORIGIN \
     --env family-test --repo "$REPO" --body "$FAMILY_TEST_SITE_ORIGIN"
   gh variable set NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL \
     --env family-test --repo "$REPO" --body "$NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL"
   ```

   These are external mutations. Do not bind a production/staging token,
   repository-wide token or subscription credential. Rotate this app's token
   and rebind the secret after suspected exposure. Rotation needs separate
   approval and can invalidate in-flight deployments.

The manual workflow is [family-test.yml](../.github/workflows/family-test.yml).
It must be reviewed and present on protected `main`; do not bypass its live
environment checks when permissions or administrator settings are missing.

## Bootstrap access before uploading recipes

For local bootstrap inspection only, use a fresh checkout with locked
dependencies and the approved `FAMILY_TEST_SITE_ORIGIN`, then run
`npm run family-test:bootstrap`. Do not reuse a full-site output directory.

With explicit site-deployment approval, use **Actions → Azure family test →
Run workflow → branch main → operation bootstrap**, or:

```sh
gh workflow run family-test.yml --repo "$REPO" --ref main -f operation=bootstrap
```

The independent reviewer approves the `family-test` environment. Bootstrap
contains only the multilingual content-free login/denied pages plus the harmless
role-protected `/_family-test/probe.html`, not recipes or media. It deploys to
the test app's primary slot, never a named preview. Compare the upload action's returned URL to the
ARM-discovered origin. An anonymous probe is not authenticated acceptance.
If the app is accidentally public or the hostname differs, stop sharing it
and investigate; do not proceed to a full-content upload.

### Invite exact family identities

In **Azure portal → this Static Web App → Role management → Invite**:

1. Select Microsoft (`aad`) or GitHub (`github`).
2. Enter the exact Microsoft account email **or** GitHub username corresponding
   to that provider, privately. An identity on one provider is not an invitation
   for the same-looking identity on the other.
3. Enter role **family**, select the exact default test domain, and choose a
   short invitation validity period (Azure's maximum is 168 hours).
4. Generate the invitation and send the link through the family's approved
   private channel. Never commit, post to an issue or paste the link into chat.
5. The invitee opens the link before expiry and signs into the exact invited
   provider/account. Confirm role membership in the portal and in a fresh
   session. A normal login, verified email or possessing the URL alone does
   not grant `family`.

Free supports invitation-based custom roles (currently up to 25 invited users).
Built-in Microsoft/GitHub sign-in does not require a custom app registration
or Standard plan. Review provider consent privately. Use **Role management**
to remove `family` or the user when revoking access; then sign out, create a
fresh session and repeat negative tests. Do not assume a preexisting session
has immediately refreshed roles; investigate any retained access before sharing.

## Publish only approved public media

First use the authenticated, plan-bound recipe/editorial workflows in
[migration-operations.md](migration-operations.md#media-upload-plans).
The private `upload-manifest.json` defines each exact key, byte count, SHA-256
and normalized MIME; the `objects/` tree must match it. Re-run the authorized
plan's local resume/validation step before external publication. Reject
symlinks, changed/unplanned objects or duplicate keys across both plans.
These plan commands do not upload anything and do not authorize public upload.

After approval of the exact account, container and plans, upload each reviewed
entry with Azure CLI **OAuth** (`--auth-mode login`). This is a per-object
method, not `upload-batch` with guessed/global MIME types:

1. In the private shell, set `UPLOAD_DIR` to the reviewed plan directory,
   `OBJECT_KEY` to the entry's exact leading-slash key, `CONTENT_TYPE` to its
   manifest `contentType`, and `EXPECTED_SHA256` to its manifest `sha256`.
   Select entries from the plan, never from recursive filesystem discovery.
2. Check this exact selection and its bytes before upload:

   ```sh
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { createHash } from "node:crypto";
   import { lstatSync, readFileSync } from "node:fs";
   import path from "node:path";
   const { UPLOAD_DIR, OBJECT_KEY, CONTENT_TYPE, EXPECTED_SHA256 } = process.env;
   assert(UPLOAD_DIR && OBJECT_KEY && CONTENT_TYPE && EXPECTED_SHA256);
   assert(OBJECT_KEY.startsWith("/") && !OBJECT_KEY.includes("\\"));
   const parts = OBJECT_KEY.slice(1).split("/");
   assert(parts.every(p => p && p !== "." && p !== ".."));
   const plan = JSON.parse(readFileSync(path.join(UPLOAD_DIR, "upload-manifest.json"), "utf8"));
   const entries = plan.entries.filter(e => e.key === OBJECT_KEY);
   assert.equal(entries.length, 1);
   const entry = entries[0];
   assert.equal(entry.contentType, CONTENT_TYPE);
   assert.equal(entry.sha256, EXPECTED_SHA256);
   assert(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(CONTENT_TYPE));
   let file = path.resolve(UPLOAD_DIR, "objects");
   assert(lstatSync(file).isDirectory() && !lstatSync(file).isSymbolicLink());
   for (const part of parts) {
     file = path.join(file, part);
     assert(!lstatSync(file).isSymbolicLink());
   }
   assert(lstatSync(file).isFile());
   const bytes = readFileSync(file);
   assert.equal(bytes.length, entry.bytes);
   assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPECTED_SHA256);
   NODE
   ```

   Export those four variables before the check. Keep the approved staging
   tree immutable while checking/uploading; stop on any failure.
3. Upload exactly that object, omitting the key's initial slash in Azure:

   ```sh
   az storage blob upload --auth-mode login \
     --account-name "$STORAGE" --container-name "$CONTAINER" \
     --name "${OBJECT_KEY#/}" --file "$UPLOAD_DIR/objects/${OBJECT_KEY#/}" \
     --type block --content-type "$CONTENT_TYPE" \
     --content-cache-control 'public, max-age=31536000, immutable' \
     --metadata "sha256=$EXPECTED_SHA256" \
     --overwrite false --if-none-match '*' --only-show-errors --output none
   ```

   SHA-256 metadata is an aid, **not byte-integrity proof**. An existing object
   or failed conditional write must never be overwritten/deleted to “resume”.
   Investigate it and reconcile bytes with the verifier before continuing.
   Do not silently ignore all command failures. Repeat only for remaining
   approved plan entries; request a separate reviewed plan-aware uploader if
   manual execution is impractical rather than improvising a bulk script.
4. Verify recipe and editorial plans **together**, including preexisting keys:

   ```sh
   npm run media:verify-azure -- \
     --account-name "$STORAGE" --container "$CONTAINER" \
     --upload-dir migration-output/wprm-media-azure-v6 \
     --upload-dir migration-output/editorial-media-azure-v4
   ```

   Use actual approved private staging paths. The existing verifier checks
   remote response bytes/hash, MIME, size and exact URL/no redirects, not merely
   Azure metadata. Follow [release-operations.md](release-operations.md#post-upload-verification).
   Also inspect the immutable cache header and browser GET/HEAD CORS from both
   `https://mycafegourmand.com` and the discovered test origin, and confirm an
   anonymous container-list request fails. Do not add wildcard CORS or SAS.

## Upload and verify the nonpromotable family site

After bootstrap invitation checks and approved public-media verification:

```sh
# Local build only; the environment values must be the approved actual URLs.
npm run build:family-test

# Separately approved cloud upload of the protected-main workflow build.
gh workflow run family-test.yml --repo "$REPO" --ref main -f operation=site
```

This is not `build:release`. It retains production canonical metadata but
keeps historical refresh/fallback navigation on the test origin. The artifact
and evidence are explicitly **NONPROMOTABLE**; never relabel them as release,
staging acceptance or production acceptance. `.deployment/` metadata stays
outside uploaded `out/`. The workflow performs anonymous checks only.
Sign-in returns to the home page; after signing in, reopen an original deep
link to test its historical navigation. Bootstrap sign-in returns to its
protected probe instead.

Download the exact retained `family-test-NONPROMOTABLE` workflow artifact into a
private local artifact root containing `out/` and `.deployment/`; verify its
commit and origin. Use this artifact, not a later local rebuild, for live
byte-level acceptance. Retained GitHub artifacts currently expire after 14 days;
this is artifact retention, **not Azure resource expiry**.

### Private local sessions and evidence

Use distinct real browser profiles: an invited `family` member and an
authenticated **nonmember**. Privately copy the site's authentication cookie
from each profile's browser developer tools to separate regular files outside
the checkout **and** artifact root. Do not export cookies for unrelated sites.
Each file is JSON with exactly `origin` and `cookie`: the former is the exact
test origin; the latter is the site's Cookie request-header value (`name=value`,
or multiple pairs separated by `; `), not a `Set-Cookie` response or a HAR.
Create with owner-only access (0600; owner-only ACL on Windows), no symlinks or
hardlinks. Do not type cookie values into CLI arguments, shell history or chat.
Use a private editor; do not put them into GitHub secrets or Actions.

```sh
npm run family-test:verify -- "$ARTIFACT_ROOT" \
  --member-cookie-file "$PRIVATE_MEMBER_COOKIE_FILE" \
  --nonmember-cookie-file "$PRIVATE_NONMEMBER_COOKIE_FILE" \
  --report "$PRIVATE_NEW_REPORT_FILE"
```

The report path must be new and outside the checkout/artifact; retain it as
private family-test evidence. No cookie/identity is written to the report.
The verifier checks actual roles via `/.auth/me`, exact retained bytes,
anonymous and nonmember denial, site assets, canonical/index aliases, every
legacy source and encoded spelling, response MIME, noindex and cache policy.
It never forwards a cookie to another origin. A 200 login page or redirect is
not successful content acceptance. Without a real authenticated nonmember,
the negative gate is **blocked**, not simulated.

Before sharing the family link, manually verify:

- Microsoft and GitHub invitation redemption; wrong identity/provider,
  expired and tampered invitations cannot confer `family`.
- Uninvited self-sign-in remains denied; removal of `family`, logout and fresh
  sessions restore denial. Test anonymous repeated requests after an invited
  read to detect cached content disclosure.
- English, French and Russian login/denied paths and site navigation; known
  Unicode/percent-encoded historical paths stay on the test host.
- Recipe browsing, categories, translations, print and basic no-JavaScript
  navigation work; enhanced search/scaling works with JavaScript. Contact
  remains a localized no-service notice, not a submission route.
- Direct requests to HTML/index aliases, JS/CSS/RSC, search JSON, images,
  sitemap, robots and unknown paths cannot bypass `family`.

Platform auth endpoints and session invalidation are Azure-owned behavior;
local tests cannot establish it. Any discrepancy blocks sharing/full acceptance.
Record commit, actual origin, artifact identity, verifier result and manual
outcomes privately, without identity/cookie screenshots. Do not automatically
delete evidence or private inputs when done.

## Cost and retained operation

SWA Free is $0 **within its quotas**, not a promise of unlimited capacity or an
SLA. Recheck current limits before upload (including invitation counts,
per-environment/total storage, file count and bandwidth).

An **illustrative small-test allowance below $10/month** assumes at most
**10 GiB Hot LRS Blob storage**, **20 GiB monthly Blob egress** and modest
transactions. It is neither a current regional quote nor a cap. Storage/media
requests, internet transfer, currency, tax, offer eligibility and future usage
can change the total; obtain a current West Europe estimate in Azure's pricing
calculator before provisioning. Public Blob traffic is not limited by family
invitations. No domains, CDN or unrelated services are included.

Suggest owner-operated budget alerts around **$5 and $10**, if this exact offer
supports budgets. Configure them privately in **Cost Management → Budgets**;
notification addresses do not belong in Bicep or Git. Cost data and alerts are
delayed; **budgets are not hard spending caps**. They neither replace the
Visual Studio spending limit nor justify disabling it. Exhausted credits can
disable service until renewal. Retaining resources consumes credit and does
not guarantee uptime. Keep the dev/test spending limit enabled permanently;
do not silently convert to PAYG or add automatic shutdown to avoid a bill.

Periodically review actual costs, quota use, public-media traffic, invitation
membership, independent reviewers and deployment-token access. Owner approval
is required before expanding the workload or changing billing.

## Replication and separately approved teardown

For a later personal subscription, obtain separate billing/service approval,
select that subscription privately, create a dedicated RG, copy the sanitized
parameters with new globally unique names/approved location, and repeat the
what-if/apply flow. Rediscover origins, verify exact CORS, rebind environment
variables and that app's secret, republish only authorized media, and **reinvite
users**. Roles/tokens/hostnames do not transfer automatically. Rebuild and
reverify new nonpromotable artifacts. Production still requires its own billing
decision, artifact, workflow, acceptance and explicit DNS/launch approval.

**Do not tear down these retained resources now.** For a future explicitly
approved deletion, first inspect the selected subscription, exact dedicated
RG contents, resource IDs, locks, deployment records, app/media consumers and
all cross-environment dependencies. Child containers/media may not appear in
the generic RG list; inspect Storage and SWA separately. Preserve approved
evidence and media needed elsewhere:

```sh
az resource list --resource-group "$RG" --output table
az lock list --resource-group "$RG" --output table
az deployment group list --resource-group "$RG" --output table
az storage container list --account-name "$STORAGE" --auth-mode login --output table
az staticwebapp show --resource-group "$RG" --name "$SWA" --output json
```

Container listing requires suitably scoped data-plane inspection permission;
do not widen upload credentials silently. If unrelated/shared resources or
dependencies exist, stop: do not delete the RG. Only after the owner reviews
that exact inventory and authorizes deletion may an operator run
`az group delete --name "$RG"` and confirm the exact group interactively.
There is deliberately no `--yes`, automatic job or private-file cleanup.
Remove obsolete GitHub credentials only under separate approval.

## Official references

Reviewed for this design; recheck live offer, provider and repository behavior:

- [SWA Bicep API 2024-11-01](https://learn.microsoft.com/en-us/azure/templates/microsoft.web/2024-11-01/staticsites),
  [Storage API 2025-01-01](https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2025-01-01/storageaccounts),
  [Blob service](https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2025-01-01/storageaccounts/blobservices),
  [container](https://learn.microsoft.com/en-us/azure/templates/microsoft.storage/2025-01-01/storageaccounts/blobservices/containers).
- [Bicep installation](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/install),
  [RG deployments](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-to-resource-group),
  [what-if limitations and permissions](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-what-if).
- [SWA authentication and role invitations](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-authorization),
  [routing configuration](https://learn.microsoft.com/en-us/azure/static-web-apps/configuration),
  [quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas),
  [plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans).
- [Anonymous Blob access](https://learn.microsoft.com/en-us/azure/storage/blobs/anonymous-read-access-configure),
  [CORS semantics](https://learn.microsoft.com/en-us/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services),
  [Blob RBAC](https://learn.microsoft.com/en-us/azure/storage/blobs/assign-azure-role-data-access),
  [CLI blob upload](https://learn.microsoft.com/en-us/cli/azure/storage/blob#az-storage-blob-upload),
  [SWA deployment tokens](https://learn.microsoft.com/en-us/azure/static-web-apps/deployment-token-management).
- [GitHub environment protections](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
  [GitHub CLI secrets from stdin](https://cli.github.com/manual/gh_secret_set).
- [Visual Studio Enterprise $150 credit terms](https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0063p/),
  [spending limits](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/spending-limit),
  [budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets),
  [Blob pricing](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/),
  [pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/).
