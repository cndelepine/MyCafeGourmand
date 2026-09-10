# My Cafe Gourmand

A multilingual recipe site replacing the family's WordPress website at
`mycafegourmand.com`.

The application is a Next.js App Router static export for Azure Static Web
Apps. It preserves the approved English, French, and Russian recipe catalog,
editorial pages, gallery, media relationships, SEO metadata, and navigation
from known old content URLs. Root `AGENTS.md` is the canonical engineering and
migration contract.

## Requirements

- Node.js 24.20.0 or newer (the exact CI version is in `.nvmrc`)
- npm
- Python 3, only for `npm run preview`

## Windows quick start

These steps assume the project has already been downloaded or cloned. Node.js
only needs to be installed once.

### 1. Install Node.js

1. Go to [nodejs.org](https://nodejs.org/en/download).
2. Download Node.js 24.20.0 or a newer supported version.
3. Run the installer with its default options.
4. Restart the computer after installation.

### 2. Open the project in Command Prompt

1. Open the folder containing this `README.md` in File Explorer.
2. Select the address bar, type `cmd`, and press **Enter**.

### 3. Install and start the site

Double-click `start-windows.cmd`. The launcher verifies Node.js, installs the
exact dependencies in `package-lock.json`, and starts the site. Keep its window
open.

The equivalent commands are:

```bat
npm ci
npm run dev
```

When the output says `Ready`, open
[http://localhost:3000](http://localhost:3000). Stop the server with
**Ctrl+C**.

To start the site later, run `start-windows.cmd` again or run `npm run dev`.
The launcher intentionally repeats `npm ci` so copied or stale dependencies
cannot silently break the site.

If Windows says `npm` is not recognized, restart Windows and retry, then
reinstall Node.js 24.20.0 or newer if needed. If the output mentions a missing
`pages` directory or `ERR_OSSL_EVP_UNSUPPORTED`, the project copy is obsolete:
clone the latest `main` branch into a clean folder instead of adding a `pages`
folder or enabling `--openssl-legacy-provider`.

## Local development

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`.

The static preview path is:

```sh
npm run build:local
npm run preview
```

`build:local` and `build:ci` create credential-free, nondeployable artifacts.
Production release is blocked until checked-in generation and output validation
prove complete static legacy-page coverage. See
[`docs/deployment.md`](docs/deployment.md) for the artifact contract and
remaining launch gates, and
[`docs/release-operations.md`](docs/release-operations.md) for media
requirements.

## Validation

```sh
npm run check
npm run build:ci
```

`npm run check` runs the tracked migration-input guard, linting, strict type
checking, focused Node tests, and recipe/schema checks. `npm run build:ci` adds
content validation and the static export. CI runs both on Linux and validates
the Windows launcher.

## Architecture

- `src/app/` contains static App Router routes, layouts, metadata, and UI.
- `content/recipes/{en,fr,ru}/` contains validated recipe JSON records.
- `content/editorial/{en,fr,ru}/` contains validated editorial records.
- `content/galleries/` contains language-neutral gallery records.
- `content/*media-manifest.json` contains public metadata for Blob-backed media.
- `scripts/` contains bounded import, promotion, inventory, build, and
  validation commands.
- `test/` contains focused tests and the only approved sanitized WordPress SQL
  fixture boundary.

The catalog renders core content and navigation without client-side JavaScript.
Progressive enhancement adds locale-wide recipe search and safe serving
scaling. Category archives and pagination are static routes, and print views
retain complete recipe content.

Canonical recipe slugs remain raw Unicode. Shared URL validation protects
encoded separators, malformed or repeated percent encodings, dot segments, and
route collisions. Validated recipe and editorial `redirectFrom` paths form the
exact legacy mapping. The approved Azure-only release design emits one static
HTTP 200 page for each source with an immediate meta refresh, canonical URL,
visible fallback link, and no JavaScript dependency. Its guarded release must
prove complete coverage and reject encoding, route, file, and canonical
collisions. The separate `out/staticwebapp.config.json` contains bounded origin
configuration and baseline headers.

The current approved publication baseline is 522 recipes (EN/FR/RU:
162/172/188), 27 editorial pages (10/9/8), one neutral gallery, 1,244 recipe
media objects, and 143 editorial/gallery media objects. Revalidate these
operational counts against the current content and authenticated source before
using them in a migration command.

## Recipe maintenance

New image-free recipes use a strict source-neutral v2 JSON document while the
522 promoted WordPress v1 files remain frozen migration output. The guarded
`recipes` commands create one authored record, report catalog/translation
semantics, generate IDE JSON Schema, and perform read-only checks. See
[`content/README.md`](content/README.md) for the author input contract,
timestamp semantics, direct-edit rules, catalog boundaries, and deferred
maintenance layers.

## Maintain the site with an AI agent

Start with [`docs/family-maintenance.md`](docs/family-maintenance.md). It gives
plain-language requests for proposing or adding one image-free recipe, changing
currently supported content, previewing locally, preparing a change for review,
creating a pull request, and reporting release readiness.

Agents can select the `family-site-maintainer` skill automatically. To request
it directly, mention `/family-site-maintainer` in Copilot CLI or
`$family-site-maintainer` in Codex.

The guide keeps important approvals separate: a dry run does not authorize a
file write; a local write does not authorize a commit or push; preparing an
update for review does not authorize a pull request; and a pull request does
not authorize a merge, provider action, billing change, deployment, traffic, or
DNS change.

## Working on the repository

| Task | Canonical guidance |
| --- | --- |
| Family-friendly maintenance entry point | [`docs/family-maintenance.md`](docs/family-maintenance.md) |
| Engineering and migration invariants | [`AGENTS.md`](AGENTS.md) |
| Contribution and pull request workflow | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Recipe authoring and catalog maintenance | [`content/README.md`](content/README.md) |
| Authenticated WordPress operations | [`docs/migration-operations.md`](docs/migration-operations.md) |
| Release builds, legacy URLs, and media verification | [`docs/release-operations.md`](docs/release-operations.md) |
| Deployment artifacts, legacy navigation pages, and launch gates | [`docs/deployment.md`](docs/deployment.md) |
| CI, security automation, and GitHub launch gates | [`docs/repository-operations.md`](docs/repository-operations.md) |

The browser editor remains deferred until a disposable private-repository test
proves lossless round-tripping for nested records, optional values, and explicit
`null`. Contact functionality is intentionally deferred; the site does not
offer a form, backend, provider integration, or email-link substitute. Historical
contact routes may remain only to explain in each locale that the service is
unavailable; they must not imply that messages can be sent.
