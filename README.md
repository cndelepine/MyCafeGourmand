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

## Windows quick start (beginner-friendly)

These steps assume the current project has already been downloaded or cloned
to your computer. You only need to install Node.js once.

### 1. Install Node.js

1. Go to [nodejs.org](https://nodejs.org/en/download).
2. Download a version that satisfies the requirement above. Node.js 22.13.0,
   the version used by this project's CI, is the safest choice.
3. Open the downloaded installer and keep the default options.
4. Restart your computer when the installation finishes.

### 2. Open the project in Command Prompt

1. Open the project folder in File Explorer. It is the folder that contains
   this `README.md` file.
2. Select the address bar at the top of File Explorer.
3. Type `cmd` and press **Enter**. A black Command Prompt window will open in
   the correct folder.

### 3. Install and start the site

Double-click `start-windows.cmd` in the project folder. The launcher installs
the exact dependencies in `package-lock.json` and starts the site. Keep the
black window open while using the site.

Alternatively, in the black Command Prompt window, type this command and press
**Enter**:

```bat
npm ci
```

Wait until it finishes. This can take a few minutes. Then type:

```bat
npm run dev
```

Keep the black window open while using the site. When it says `Ready`, open
[http://localhost:3000](http://localhost:3000) in your web browser. If Windows
Firewall asks for permission, select **Allow access**.

To stop the site, return to the black window, press **Ctrl+C**, and type `Y` if
asked to confirm.

### Start the site again later

Double-click `start-windows.cmd` again. If using Command Prompt instead, open
the project folder, repeat step 2, and run:

```bat
npm run dev
```

The launcher intentionally runs `npm ci` each time so copied or outdated
dependencies cannot silently break the site. When starting manually, you do
not need to run `npm ci` again unless the project has been updated.

### If a command does not work

- If Windows says that `npm` is not recognized, restart the computer and try
  again. If that does not help, reinstall Node.js 22.13.0 or newer.
- Make sure you opened the folder containing `README.md` before typing `cmd`.
- The first `npm ci` requires an internet connection.

If the output says that a `pages` directory is missing or reports
`ERR_OSSL_EVP_UNSUPPORTED`, the project copy is obsolete. Those errors come
from the original Next.js/Webpack setup and are not fixed by creating a
`pages` folder or setting `NODE_OPTIONS=--openssl-legacy-provider`. Download or
clone the latest `main` branch into a new folder, then use
`start-windows.cmd`. Do not copy the old `node_modules`, `.next`, or manually
created `pages` folders into the new project.

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

Authoritative WordPress backups are read-only migration inputs and remain
Git-ignored. Never commit database dumps, credentials, subscriber data, private
backups, or raw uploads. Use only sanitized fixtures in automated tests.

### Privacy-safe source inventory

The source inventory accepts a plain SQL dump or a gzip-compressed SQL dump and
one or more upload ZIP archives. It streams and bounds the database input and
reads ZIP central directories without extracting files. Its deterministic JSON
contains aggregate counts plus numeric WordPress IDs and relationships needed
for reconciliation; it does not emit titles, slugs, post bodies, serialized
values, URLs, media filenames, users, comments, contacts, subscribers, or
credentials.

Run a dry run to stdout:

```sh
npm run inventory:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/uploads \
  --dry-run
```

Write a migration-only report explicitly:

```sh
npm run inventory:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/uploads \
  --write --output migration-output/wordpress-source-inventory.json
```

The report covers posts and pages, WP Recipe Maker and WP Ultimate Recipe
signals, taxonomies, redirect records, gallery tables and references, attachment
references, and upload archive coverage, including generated image-derivative
counts. Polylang post relationships (`language` and `post_translations`) and
term relationships (`term_language` and `term_translations`) are reported
separately with stable numeric IDs; term-language aliases never become post
links. Translation-group membership comes from term relationships, without
emitting term names, slugs, descriptions, or serialized values. Empty
translation groups are retained and counted rather than silently discarded.
Relevant SQL tables report both INSERT-statement counts and parsed row counts,
so multi-row INSERTs are not mistaken for one record. Input is rejected when
SQL or ZIP structure is malformed or exceeds safety limits. WP Ultimate
Recipe's historical generic `recipe` post type can be ambiguous; that evidence
is retained as a count and an issue rather than being silently treated as a
normalized recipe. Adjust bounded-input options with the `--max-*` flags shown
by the command's option names.

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

### Bounded source evidence probe

The evidence probe is a read-only, aggregate-only companion to the inventory. It
performs two bounded scans of an approved plain or gzip SQL dump, compares the
decompressed whole-SQL hash between passes, and reads upload ZIP central
directories without extracting files. It inspects only the allowlisted
WordPress structures needed to reconcile WPRM/WPUR signals, Polylang groups,
attachments, redirects, and Photo Gallery relationships. It never writes
recipes, content, or media and never emits source values, filenames, paths,
timestamps, personal data, or record-level entries. PHP and JSON inspection is
bounded by the command's safety limits. Its report is schema v2: recipe/editorial
translation derivation is parent-group authoritative, and Photo Gallery image
and thumbnail coverage reports strict root-normalized matches separately from
generic attachment normalization.

Run a dry probe to stdout:

```sh
npm run probe:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/uploads \
  --baseline /path/to/wordpress-source-inventory-v3.json \
  --dry-run
```

`--baseline` accepts only the documented sanitized
`kind: "wordpress-source-inventory"` schema-v3 report. It extracts the
allowlisted aggregate metrics rather than accepting a custom flat map.
Reconciliation compares `redirects.redirectionItems` as
`redirectionPluginRecords`; `redirects.oldSlugMetadata` is retained as
`legacyOldSlugRecords` with status `not-probed` and is never compared to plugin
evidence. The inventory's combined redirect total is therefore not a probe
expectation.

The approved-source acceptance baseline is 539 WPRM records, 436 WPUR
metadata-signal posts, 548 posts, 57 pages, 269 post translation groups, 5,005
term translation groups, 185 plugin redirect rows, 1,715 matched attachments,
and 67 BWG image records. Safe post/page aggregates are included in the
serialized evidence report for repeatable baseline comparison. Legacy old-slug
metadata remains informational. The approved source derives 186 parent groups
(184 one-to-one: 145 three-language, 37 two-language, and 2 one-language),
with 20 valid-parent recipes ungrouped. Photo Gallery root normalization matches
all 67 images and 67 persisted thumbnails; thumbnails are never synthesized.

Use `--write --output migration-output/wordpress-source-evidence.json
--overwrite` only when an explicit migration-only report is wanted. The report
is evidence for reconciliation, not an importer, and must not be treated as
recipe/content/media extraction.

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
