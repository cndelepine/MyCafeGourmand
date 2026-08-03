# My Cafe Gourmand

A multilingual recipe site replacing the family's WordPress website at
`mycafegourmand.com`.

The application is a Next.js static export for Azure Static Web Apps. Migration
work must preserve the source recipes, English/French/Russian relationships,
media, metadata, and permanent redirects from old URLs that identified
specific recipes. See `AGENTS.md` for the shared Copilot and Codex working
agreement.

## Requirements

- Node.js 22.13.0 or newer (the exact CI version is in `.nvmrc`)
- npm
- Python 3 (only for `npm run preview`)

## Quick start (beginner-friendly)

1. Open a terminal.
2. Go to this project folder:
   ```sh
   cd /home/runner/work/MyCafeGourmand/MyCafeGourmand
   ```
3. Install everything the app needs:
   ```sh
   npm ci
   ```
4. Start the app:
   ```sh
   npm run dev
   ```
5. Open your browser and visit `http://localhost:3000`.

To preview the production build locally:

```sh
npm run build
npm run preview
```

## Local development

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Static build

The production build is a static export for Azure Static Web Apps. It writes
the complete site, including `sitemap.xml` and `robots.txt`, to `out/`:

```sh
npm run build
```

Deploy `out/` as the Azure Static Web Apps output directory. Local images are
served without Next's image optimization service so the export remains
self-contained.

The build validates each recipe's `redirectFrom` paths, then writes the
deterministic `out/staticwebapp.config.json` Azure Static Web Apps route
configuration. Recipe redirect sources target that recipe's canonical locale
route with its static-export trailing slash. Sources are root-relative local
URL paths without query strings or fragments; duplicates and canonical recipe
paths are rejected. The generated file is ignored and must not be committed.

If unrelated Azure route, header, or fallback settings are needed, keep the
hand-authored JSON in `config/staticwebapp.config.json`. The build preserves
those settings and prepends generated redirect routes. Do not place a
hand-authored config in `public/`, because that would be copied into the
export without the generated redirect validation. Hand-authored exact
redirects participate in merged loop checks; wildcard redirect routes are
rejected because their possible cycles cannot be proven statically.

To preview the completed static export locally:

```sh
npm run build
npm run preview
```

This uses Python 3's static file server; `npm run start` is intentionally not
provided because `next start` requires a server-rendered Next build.

## Validation

```sh
npm run check
```

This runs linting, type checking, tests, content validation, and a production
build.

## CMS-ready content

Canonical recipe records live in `content/recipes/{en,fr,ru}/` as independent
JSON files. Discovery is deterministic and validates each record with its
source path; `npm run content:validate` also checks that every local media path
resolves to a regular file below `public/`.

The browser editor is intentionally deferred. Decap's standard object/list
widgets do not yet provide a proven round-trip for this schema's explicit
`null` values and nested records, and stock Decap has no read-only mode that
would make an incomplete mapping safe. No editor runtime, local proxy, or
production OAuth configuration is shipped until a complete mapping can be
tested without losing data.

## WordPress migration

The repository does not yet contain an authoritative WordPress export. Never
commit database dumps, credentials, subscriber data, private backups, or raw
uploads. Use only sanitized fixtures in automated tests.

The importer is a foundation for approved exports, not yet a complete site
migration tool. Run it in dry-run mode before writing output:

```sh
npm run import:recipe -- \
  --database /path/to/sanitized-or-approved.sql \
  --recipe-id 2980 \
  --slug meatballs-soup \
  --locale en \
  --dry-run
```

WordPress Recipe Maker and WP Ultimate Recipe identifiers are import-time
source concerns only; WP Ultimate Recipe is not a runtime or URL-compatibility
feature, even though historical recipe records may be stored there. The
product promises permanent redirects only for old URLs that identified
specific recipes, not taxonomy, feed, attachment, print, or shortlink URL
compatibility. Historical recipe content must still be retained when it is
imported.

Azure Static Web Apps is the chosen deployment target for the static export.
The browser editor remains deferred until a lossless content-editing workflow
is proven.

### Archived URL inventory

The read-only URL inventory follows only XML sitemap indexes and urlsets. It
does not crawl content pages or generate redirects. It accepts local XML or
`.xml.gz` files and HTTP(S) sitemap sources, including Wayback sitemap indexes.
Gzip input is streamed within the configured compressed-input limit and is
decompressed with `--max-document-bytes` enforced on the decompressed bytes:

```sh
npm run inventory:urls -- \
  --sitemap https://web.archive.org/web/20240101000000id_/https://mycafegourmand.com/sitemap_index.xml
```

The command prints deterministic JSON to stdout by default. To save a report,
use a migration-only path and opt in explicitly:

```sh
npm run inventory:urls -- \
  --sitemap /path/to/sitemap_index.xml \
  --write --output migration-output/url-inventory.json
```

Existing files require `--overwrite`; output under `public/`, `src/`, or
`content/` is rejected. Limits can be adjusted with `--max-depth`,
`--max-documents`, `--max-urls`, `--max-document-bytes`, and
`--request-timeout-ms` (30 seconds by default). Remote roots, sitemap
children, and redirects are restricted to `mycafegourmand.com`,
`www.mycafegourmand.com`, and Wayback captures of those hosts; redirects are
followed manually with a three-hop bound, and local sitemap children must
remain under the root sitemap's directory tree. The report is a discovery aid
only, not source truth or a redirect decision. Its comparison section
classifies discovered paths as `discovered-only`, `current-covered`, or
`redirect-covered` against the validated catalog without creating redirects.
The report uses `knownRedirectPaths` for the recipe redirect sources. Use
`--recipes-root` to compare against another validated catalog directory.
