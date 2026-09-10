# Family maintenance

This is the plain-language starting point for maintaining My Cafe Gourmand with
an AI coding agent. The agent must also follow root
[`AGENTS.md`](../AGENTS.md) and the specialist guide linked for the task. Those
guides remain authoritative when this overview is shorter.

The browser editor is not available. Work happens in a checked-out copy of the
repository on a topic branch, and a human reviews a pull request before it
reaches `main`.

## Say what should happen

These requests have deliberately different boundaries:

| Request | What it authorizes |
| --- | --- |
| "Show me the proposed change; do not write files." | Read files and run read-only or documented dry-run commands. |
| "Apply this change locally." | Write only the described files in the current topic branch, then validate them. |
| "Prepare this update for review." | Inspect and validate the local diff and explain it in plain language. It does not authorize a commit, push, or pull request. |
| "Create a pull request for this update." | Commit the reviewed local change, push its topic branch, and open a pull request. It does not authorize merging. |
| "Report release readiness." | Report repository checks and known gates as verified, unverified, or blocked. It does not authorize a provider or production action. |

Permission at one row never implies permission for a later row. Accounts or
billing, an external upload, any future live contact test, a staging deployment,
production traffic or DNS, and private-artifact cleanup each require separate
owner approval of the exact action and target. Work credit or an available
credential is not approval.

Never paste credentials, private recipe sources, upload plans, form-message
contents, or personal data into agent chat. Give the agent only an explicitly
authorized private path when a specialist operation needs one. A missing input
is a blocker, not permission to search other folders.

If a command fails, the agent should quote the first actionable error, explain
what it means in plain language, and identify the file or owner decision needed
next. It must not weaken a check, invent a value, overwrite a record, or turn a
blocked release into a success-shaped status.

Contact functionality is intentionally deferred. Do not choose a provider,
build a form or backend, or add an email link as a substitute. The absence of a
contact feature is not a release blocker. Preserve frozen source records;
historical contact routes may show only a localized no-service notice, not
promotional navigation or a submission-success claim. If the owner revisits
contact later, its real data flow and privacy obligations require a separately
approved design.

## Add one recipe

Current authoring supports one genuinely new, image-free recipe at a time.
Provide the recipe's real wording in a source-neutral JSON input. The agent must
not invent translations, dates, categories, SEO text, or image descriptions.

Ask first for a proposal. The agent follows
[`content/README.md`](../content/README.md) and runs:

```sh
npm run recipes -- new --input <path-to-input.json>
```

This dry run prints the exact destination and complete proposed v2 record.
Review it before authorizing a local write. The agent then replays the displayed
ID and creation time exactly:

```sh
npm run recipes -- new --input <path-to-input.json> \
  --id <reviewed-id> \
  --created-at <reviewed-created-at> \
  --write
```

It finishes with the recipe and repository checks required by
[`content/README.md`](../content/README.md). `--write` creates a local file; it
does not publish the recipe.

Do not use this workflow to add images, rename or move a URL, create or alter a
translation group, or edit migrated WordPress provenance. The existing v1
records remain frozen.

## Change supported content

Tell the agent the exact factual change and the affected page or recipe. It
must identify the persisted document version before editing:

- A v2 authored recipe may be changed only within the current schema and
  validation rules. Explicit `null` values, groups, quantities, times, notes,
  and filenames retain their documented meaning.
- A v1 migrated recipe and other migrated source-backed content are frozen. Do
  not casually correct or reformat them in place.
- Media ingest, URL moves, translation mutation, and provenance correction are
  deferred workflows. The agent reports that boundary instead of approximating
  it with direct JSON edits.

The full content contract and required checks are in
[`content/README.md`](../content/README.md). Private WordPress source work uses
[`migration-operations.md`](migration-operations.md) only with explicit owner
authorization.

## Preview the site

For a quick local preview while editing:

```sh
npm run dev
```

For the same credential-free static artifact shape used by CI:

```sh
npm run build:local
npm run preview
```

Open `http://localhost:3000`. Both previews are local. `out/` from
`build:local` or `build:ci` is intentionally nondeployable, even when it looks
correct.

## Test with invited family on Azure

The separate [Azure family-test guide](azure-family-test.md) describes the
owner-operated shared test site. Only the specifically invited account and
sign-in provider receive the `family` role; simply signing in does not grant
access. Do not paste invitation links, family identities, or session cookies
into chat. The Azure test is not the live WordPress site, and its test-only
artifact cannot be promoted to production. Recipe images on Blob storage
remain publicly readable by URL.

The latest owner decision is to **keep test resources running** for family
feedback. Deleting resources, removing invitations, uploading media, or
changing GitHub/Azure settings are separate authorized operator actions.

## Prepare an update for review

The agent should:

1. inspect the complete local diff and exclude unrelated, generated, private,
   or credential-bearing files;
2. run the focused check for the change and the full checks required by
   [`CONTRIBUTING.md`](../CONTRIBUTING.md);
3. summarize changed behavior, unchanged boundaries, and each check as passed,
   failed, blocked, or not run;
4. stop with the validated local diff unless asked explicitly to create a pull
   request.

Creating a pull request authorizes a commit and branch push, not a merge.
Repository rules and human review remain separate controls.

## Report release status

A useful status separates evidence into four groups:

| Group | Truthful evidence |
| --- | --- |
| Local | The exact commit checked and the actual result of `npm run check` and `npm run build:ci`. These produce no deployable release. |
| Repository | Pull-request checks plus a live administrator verification of branch protection, required checks, and security settings. Instructions or CI files do not prove those settings are enabled. |
| External services | Owner-approved provider decisions and verified staging evidence for media, static legacy navigation pages, hosting, TLS, rollback, and artifact identity. Missing evidence is blocked or unverified. Contact is deferred and is not a launch gate. |
| Production | Explicit approval and observed results for the exact production deployment, traffic, and DNS actions. Staging success is not production success. |

Production release is currently blocked. `npm run build:release` intentionally
fails until checked-in generation and output validation prove that every
validated historical source has a static HTTP 200 page with an immediate meta
refresh, canonical URL, and visible fallback link that works without
JavaScript. These pages preserve navigation but are not HTTP 301 redirects. Do
not pass invented environment values or add a bypass to make the command green.

Use [`release-operations.md`](release-operations.md) for release artifacts and
media boundaries; [`deployment.md`](deployment.md) for hosting, legacy
navigation pages, staging, rollback, and production gates; and
[`repository-operations.md`](repository-operations.md) for the one-time GitHub
administrator checklist. A status report must never infer provider readiness
from a plan or repository readiness from documentation alone.
