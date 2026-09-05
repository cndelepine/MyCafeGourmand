# My Cafe Gourmand

A multilingual recipe site replacing the family's WordPress website at
`mycafegourmand.com`.

The application is a Next.js App Router static export for Azure Static Web
Apps. It preserves the approved English, French, and Russian recipe catalog,
editorial pages, gallery, media relationships, SEO metadata, and permanent
redirects from old content URLs. Root `AGENTS.md` is the canonical engineering
and migration contract.

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
Production release is blocked until a checked-in edge adapter deploys all
historical redirects. See [`docs/deployment.md`](docs/deployment.md) for the
artifact contract and remaining launch gates, and
[`docs/release-operations.md`](docs/release-operations.md) for media and contact
requirements.

## Validation

```sh
npm run check
npm run build:ci
```

`npm run check` runs the tracked migration-input guard, linting, strict type
checking, and focused Node tests. `npm run build:ci` adds content validation and
the static export. CI runs both on Linux and validates the Windows launcher.

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
route collisions. Validated recipe and editorial `redirectFrom` paths generate
the provider-neutral `.deployment/redirect-manifest.json`, outside public
`out/`. The separate `out/staticwebapp.config.json` contains bounded origin
configuration and baseline headers, not the historical redirect catalog.

The current approved publication baseline is 522 recipes (EN/FR/RU:
162/172/188), 27 editorial pages (10/9/8), one neutral gallery, 1,244 recipe
media objects, and 143 editorial/gallery media objects. Revalidate these
operational counts against the current content and authenticated source before
using them in a migration command.

## Working on the repository

| Task | Canonical guidance |
| --- | --- |
| Engineering and migration invariants | [`AGENTS.md`](AGENTS.md) |
| Contribution and pull request workflow | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Authenticated WordPress operations | [`docs/migration-operations.md`](docs/migration-operations.md) |
| Release builds, contact, redirects, and media verification | [`docs/release-operations.md`](docs/release-operations.md) |
| Deployment artifacts, edge redirects, and launch gates | [`docs/deployment.md`](docs/deployment.md) |
| CI, security automation, and GitHub launch gates | [`docs/repository-operations.md`](docs/repository-operations.md) |

The browser editor remains deferred until a disposable private-repository test
proves lossless round-tripping for nested records, optional values, and explicit
`null`. Azure resources and the external contact provider are not provisioned
by this repository.
