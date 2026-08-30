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

## Static artifacts

The credential-free local and CI artifact build writes
the complete site, including `sitemap.xml` and `robots.txt`, to `out/`:

```sh
npm run build:local
```

`npm run build:ci` runs the same nondeployable build in CI. These artifacts
leave canonical Blob media keys root-relative for local fixtures and **must not
be deployed**. Recipe originals
are deliberately not included in the Static Web Apps artifact: their validated
canonical object keys are resolved to Blob Storage or a CDN at release time.
`build:static`, `build:local`, and `build:ci` reject any configured
`NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL`; a configured public media base is accepted
only by the explicit guarded release command.
`next/image` remains unoptimized for static export; when a media base is
configured, Next allows only that validated HTTPS host and the
`/recipes/media/wordpress/**`, `/editorial/media/wordpress/**`, and
`/gallery/media/wordpress-bwg/**` path prefixes.

When `NEXT_PUBLIC_CONTACT_FORM_ENDPOINT` is unset or invalid, local and CI
builds render an explicit localized unavailable-contact boundary instead of a
form. This lets credential-free artifacts remain useful without exposing an
unconfigured submission target.

## Azure release build

The only documented deployment build command is `npm run build:release`.
It fails closed unless both `NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL` and
`NEXT_PUBLIC_CONTACT_FORM_ENDPOINT` are valid, then runs guarded pre- and
post-build validation. It scans every bounded deployable text artifact in
`out/`, including HTML, CSS, JavaScript, React Flight/RSC `.txt` payloads,
JSON-LD, and inline `self.__next_f.push` payloads. It rejects a root-relative
Blob media URL, an unmanifested object, a different origin or base path, and
any manifest-backed URL that does not exactly resolve from the configured HTTPS
base:

```sh
export NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL="https://<storage-account>.blob.core.windows.net/<container>"
export NEXT_PUBLIC_CONTACT_FORM_ENDPOINT="https://<contact-provider-host>/<public-submit-path>"
npm run build:release
```

The value must be an absolute HTTPS Blob or CDN base URL with no credentials,
query string, or fragment. A custom-domain/CDN option is equally valid after
its TLS/DNS configuration is complete, for example
`https://<media-domain>/<container>`. Do not invent an account hostname in source or configuration; set the real
value only in the deployment environment. `npm run build:local` and
`npm run build:ci` intentionally remain credential-free, reject that variable,
and do not contact Azure.

## Contact form provider contract

The static contact pages submit standard `application/x-www-form-urlencoded`
POSTs directly to the public URL in `NEXT_PUBLIC_CONTACT_FORM_ENDPOINT`; they
need no JavaScript, API route, Server Action, CAPTCHA, third-party script,
analytics, or cookie. The value is public build configuration, not a secret:
do not put recipient addresses, credentials, access tokens, or private data in
it. It must be an external absolute HTTPS URL with no credentials or fragment.
The release build rejects malformed URLs, localhost/private and loopback-style
hosts, and the site's host (including its subdomains).

The provider adapter owns delivery and must accept only these bounded
application fields:

| Field | Contract |
| --- | --- |
| `name` | required text, at most 120 characters |
| `email` | required email text, at most 254 characters |
| `subject` | optional text, at most 200 characters |
| `message` | required text, at most 5,000 characters |
| `locale` | one of `en`, `fr`, or `ru` |
| `returnUrl` | one of the app-generated absolute canonical success URLs |

Production launch is blocked until the owner approves an accurate replacement
privacy notice for the selected contact provider and its actual data flow,
retention, deletion, and contact practices. The obsolete WordPress privacy page
is intentionally excluded rather than published with inaccurate descriptions
of retired comments, newsletters, analytics, advertising, and service
providers. The contact UI should also discourage sensitive or health
information unless the eventual provider and policy explicitly support it.

The form also sends a `website` honeypot. The adapter may reject a nonempty
value, but must not treat it as contact data. It must independently enforce all
field bounds and allow-list `returnUrl`; never trust a posted URL solely because
the static form emitted it. Only after successful acceptance, redirect to the
submitted allowed return URL: `/contact/success/`, `/fr/contact/success/`, or
`/ru/contact/success/`. These localized confirmation pages are canonical
noindex routes and are intentionally excluded from the sitemap.

The build validates each recipe and editorial page's `redirectFrom` paths, then writes the
deterministic `out/staticwebapp.config.json` Azure Static Web Apps route
configuration. Redirect sources target the matching canonical locale route with
its static-export trailing slash. Sources are root-relative local URL paths
without query strings or fragments; duplicates and canonical routes are
rejected. The generated file is ignored and must not be committed.

If unrelated Azure route, header, or fallback settings are needed, keep the
hand-authored JSON in `config/staticwebapp.config.json`. The build preserves
those settings and prepends generated redirect routes. Do not place a
hand-authored config in `public/`, because that would be copied into the
export without the generated redirect validation. Hand-authored exact
redirects participate in merged loop checks; wildcard redirect routes are
rejected because their possible cycles cannot be proven statically.

The migration resolver promises only exact recipe and editorial redirects:
published source permalinks, safe `_wp_old_slug` values on that same source
parent, and enabled exact Redirection URL/301 rows that terminate at promoted
content. It does not promise taxonomy, feed, attachment, print, shortlink, or
other historical WordPress routes.

To preview the completed static export locally:

```sh
npm run build:local
npm run preview
```

This uses Python 3's static file server; `npm run start` is intentionally not
provided because `next start` requires a server-rendered Next build.

## Validation

```sh
npm run check
npm run build:ci
```

`npm run check` runs credential-free linting, type checking, and tests.
`npm run build:ci` adds content validation and the nondeployable static export;
the CI workflow runs both. Deployments must use `npm run build:release`, never
either local or CI artifact command.

## Category browsing and pagination

The catalog uses 24 recipe cards per page: a practical eight desktop rows at
the current three-card density, while keeping static route and Flight payload
growth bounded. Locale catalog page one is canonical at `/`, `/fr/`, or `/ru/`;
later pages use `/page/<n>/`. Category page one is canonical at
`/category/<slug>/`, `/fr/category/<slug>/`, or `/ru/category/<slug>/`, with
later pages below `/page/<n>/`. Page-one pagination URLs are never generated.

Category archives are derived only from validated editorial WordPress
`category` memberships. Tags, ingredients, and WPRM taxonomies are not archive
sources. Category source slugs are validated through the same repeated
percent-encoding and path-safety checks as recipe routes; encoded Cyrillic
source slugs become raw-Unicode canonical route segments and collisions fail
validation.

The authorized source contains Polylang term translation evidence, but the
promoted recipe records retain individual source term IDs rather than a
category translation-group ID. Until that relationship is explicitly preserved
in the public content contract, category archives remain locale-independent and
intentionally emit no cross-language category `hreflang` links.

When JavaScript is available, landing-page search loads one bounded static
`/_search/<locale>.json` index on demand and searches every recipe in that
locale, including recipes beyond the visible page. The index is generated by
`npm run search:generate` before development and static builds, is ignored by
Git, and is copied into `out/`; page HTML and Flight payloads carry only the
visible page's cards. Without JavaScript, category links and pagination remain
ordinary server-rendered links.

## CMS-ready content

Canonical recipe records live in `content/recipes/{en,fr,ru}/` as independent
JSON files. Discovery is deterministic and validates each record with its
source path. The recipe tree is closed: its root permits only those locale
directories, and each locale permits only bounded regular files named exactly
`<slug>.json` with NFC-normalized raw Unicode. Bounded strict-JSON loading
rejects malformed UTF-8, excessive nesting, duplicate object keys, oversized
strings and arrays, and catalog overflow before rendering. Published record IDs
remain tied to their WordPress plugin/recipe identity, and source-backed
WordPress editorial URLs that identify one promoted recipe must remain in
`redirectFrom` even when an unpublished new-site recipe slug changes. Shared
parent URLs stay ambiguous rather than being assigned without source evidence.
Preserved raw WordPress editorial HTML remains source provenance within the
recipe record bounds.

Promoted WordPress media uses stable canonical object keys such as
`/recipes/media/wordpress/<attachmentId>.jpg`, never deployment-specific URLs.
`content/media-manifest.json` is a bounded, deterministic public inventory of
only those keys, byte counts, SHA-256 values, and numeric attachment IDs.
`npm run content:validate` requires every promoted reference exactly once in
that manifest and rejects unreferenced entries; local fixture/dev paths still
resolve to regular files below `public/`.
Editorial and gallery media use the separate
`content/editorial-gallery-media-manifest.json` only after authenticated
editorial promotion; it records their managed keys, byte counts, hashes, and
public source identifiers without copying source bytes into Git.

Validated editorial records publish from their source-backed `canonicalPath`
values (including nested and raw-Unicode paths), while the neutral gallery
publishes at `/gallery/`. The static App Router renders the bounded editorial
AST as semantic React elements, preserves available translation relationships
in canonical metadata and `hreflang`, and includes all published editorial and
gallery paths in the sitemap. Contact-form markers render a localized HTML form
only when its validated external endpoint is configured; otherwise they render
an explicit unavailable boundary.

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

The importer is a bounded WPRM bulk staging tool. It does not copy media, apply
records to the catalog, or write under `src/`, `content/`, or `public/`. Every
run requires a private regular key file containing at least 32 random bytes;
the key is used only for candidate HMAC-SHA256 fingerprints and is never
printed. Keep the key and all output under the Git-ignored `migration-output/`
tree (or another private session-state directory).

```sh
umask 077
openssl rand 32 > migration-output/wprm-fingerprint.key
npm run import:wprm-bulk -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --dry-run
```

Dry-run stdout is an aggregate privacy-safe manifest: it contains counts,
numeric IDs, locales, stable issue codes, the whole decompressed-source hash,
keyed candidate authentication values, and reconciliation counters only. It
never contains source wording, titles, bodies, slugs, URLs, filenames,
timestamps, metadata values, or serialized payloads. Redirect reporting is
aggregate-only: canonical, `_wp_old_slug`, and Redirection-plugin rows are
classified by accepted, unresolved, external/ambiguous, conflict, cycle, and
unsupported outcomes, with locale totals and recipe counts.

Before redirect resolution, the importer requires exactly one authoritative
options table with `home`, `permalink_structure`, and `polylang` rows. The
accepted contract is the approved HTTP/HTTPS origin, `/%postname%/`, and the
Polylang settings `force_lang=1`, `hide_default=true`, `rewrite=true`,
`redirect_lang=false`, and `default_lang=en`, with only `en`, `fr`, and `ru`
locales. The origin is retained privately only to normalize same-origin
absolute Redirection targets. Missing, duplicate, malformed, or unsupported
settings fail closed; they never produce redirects.

To create private schema-valid candidate files, use a staging-only path:

```sh
npm run import:wprm-bulk -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --write --staging-dir migration-output/wprm-bulk-v12
```

Candidate files are mode `0600` below numeric recipe-ID paths, and staging
directories are mode `0700`. WPRM and editorial use the same root-scoped
exclusive lock; an existing populated root must already carry the matching
format marker before either writer can modify it. Existing matching files can
be resumed with `--resume`; changed SQL, upload archives, entry metadata, or
artifacts fail with `staging-conflict`. `--apply`, `--copy-media`,
`--content-root`, and `--public-root` are rejected. The deprecated
`import:recipe` script is a compatibility alias for this bulk CLI and rejects
`--recipe-id`, `--slug`, and `--locale`.

The WPRM 10.7.1 reconciliation maps equipment (including explicit empty
lists), nutrition source text with safely parsed numeric values when available,
and advanced-serving dimensions into private schema-valid candidates. It
preserves source order and IDs for equipment, preserves zero-valued dimensions,
and records the independent advanced-serving enabled state. Sparse advanced
serving objects use only WPRM's documented structural defaults (`round`,
`inch`, and zero dimensions); disabled source data remains present but is not
treated as enabled. These fields are not promoted to the public catalog by
this tool.

Author names remain excluded pending an explicit content and privacy decision.
Pinterest image references, video identifiers, and food/default WPRM recipe
types are explicit non-launch exclusions: the importer neither looks up
Pinterest companion IDs as attachments nor copies excluded media. How-to,
other, unknown, and malformed WPRM types remain review outcomes with stable
issue codes. Privacy-safe manifests report only exclusion issue codes and
aggregate reference counts, never their values.
Published source content is the only promotion candidate. Known WordPress
non-public statuses remain errors and are never staged. They are still
structurally mapped: a translation peer is omitted only when source publication
status is its sole blocking condition and its parent/group/locale relation is
otherwise valid. Unknown statuses, malformed mappings or media, duplicate locales, and ambiguous
relations remain integrity blockers. An incomplete parent translation is
publishable only when it is the candidate's sole substantive review issue, its
validated record and source both retain an explicitly absent translation group,
and every other issue is an approved informational omission. The privacy-safe
aggregate distinguishes
publication-excluded from integrity-blocking candidates. A mapper contract
change cannot resume an older staging root, so start a new private staging root
when its marker rejects `--resume`.

For the current approved-source acceptance baseline, the privacy-safe dry run
accounts for 539 WPRM records: 521 ready candidates, 3 incomplete-translation
reviews, and 15 non-published errors. Its status-aware reconciliation classifies
4 candidates as publication-excluded and 14 as integrity-blocking without
emitting source statuses or record values.

The approved redirect pass is separately bounded and classified: 521 canonical
editorial candidates, 519 redirect-eligible records, 48 safe old-slug
candidates, and 185 Redirection rows (184 exact URL rows and one regex row).
It accepts 519 canonical sources and 48 old-slug sources (567 unique sources
and generated routes). The three intentional-partial additions do not bypass
the independently proven redirect-identity requirements. Of the 185 plugin
rows, 39 corroborate accepted
canonical, old-slug, or current terminals and are counted as accepted and
deduplicated evidence without adding routes; 145 remain unresolved, one is a
regex row, and none are conflicts, unsupported, external, or cyclic. Rows
terminating at excluded or unpromoted identities remain unresolved and are not
routes.

### Editorial pages and BWG gallery staging

`import:editorial` is a separate, staging-only foundation for authoritative
WordPress `page` records and the BWG gallery. It preserves page and gallery
source rows only in private candidate files. The authenticated promotion and
static runtime remain distinct: only a promoted, validated safe AST enters
public content, routes, metadata, and managed-media references.

It requires the authorized database, the complete upload-archive directory, and
a private regular HMAC key file. The default mode is dry run:

```sh
umask 077
openssl rand 32 > migration-output/editorial-fingerprint.key
npm run import:editorial -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/editorial-fingerprint.key \
  --dry-run
```

Dry-run stdout is a deterministic safe manifest. It contains source and
aggregate upload contract hashes, counts, locale/status/issue/media/translation
aggregates, and keyed HMAC candidate fingerprints only. It never prints page
or gallery IDs, titles, slugs, body text, form data, media paths, timestamps,
alt text, archive paths, ZIP entry names, or staged records. The upload
contract binds each archive's SHA-256 identity and canonical central-directory
entry metadata without exposing those values individually. The extractor validates the approved WordPress/Polylang options, the
source-designated `page_for_posts` page, and the bounded global WP Tiles
pagination setting. It streams SQL twice to detect a changing source,
inventories ZIP central directories without extraction, and validates
raw-Unicode slugs and local paths with the shared URL-path checks.

Use explicit private staging only after reviewing the safe manifest:

```sh
npm run import:editorial -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/editorial-fingerprint.key \
  --write --staging-dir migration-output/editorial-v4
```

The root and `candidates/` directories are owner-only `0700`; marker,
manifest, and candidate files are `0600`, written atomically through no-follow
handles under one root-scoped owner-only lock shared with WPRM staging. Before
any write, an existing root must be empty or carry this exact editorial marker;
populated WPRM, editorial, or unknown roots fail without modification.
`--resume` accepts only a matching source/hash/contract marker and
byte-equivalent private records; any changed source or artifact, concurrent
writer, or stale/crash lock fails closed with `staging-conflict`. Output, apply,
publish, content-root, public-root, destination, route-root, and media-copy
options are rejected.

Candidate source bodies are staged losslessly with a structural analysis rather
than silently transformed. `wp-tiles`, Contact Form 7, unknown shortcodes and
blocks, unresolved/unsafe/ambiguous internal links and inline media, malformed
image markup, and unlocalized BWG publication are review issues. Every `img`
and `source` `src`/`srcset` candidate is inspected and counted; a construct
that cannot be parsed losslessly is review-gated. Page paths are derived from
validated parent chains; malformed non-root IDs, missing, cyclic, non-page,
unsafe, locale-incompatible, translation-incompatible, or non-public parents
are never flattened.
Non-public and private pages are explicitly publication-excluded. A
source-designated `page_for_posts` record is also publication-excluded until a
real static posts archive is explicitly modeled; it is not published as an
empty editorial page. The tool does not infer locales, translations, author
names, alt text, or WP Tiles pagination.

### Authenticated editorial promotion

`promote:editorial` requires exactly one explicit mode: `--dry-run` or
`--write`. It reruns the authoritative editorial importer, verifies the private
staging marker, manifest, every candidate's keyed HMAC fingerprint, and the
exact operator-supplied candidate and selected-record counts. It then maps only
source-proven public values.

```sh
npm run promote:editorial -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/editorial-fingerprint.key \
  --staging-dir migration-output/editorial-v4 \
  --expected-ready 6 \
  --expected-review 49 \
  --expected-publication-excluded 2 \
  --expected-gallery-candidates 1 \
  --expected-galleries 1 \
  --expected-selected 27 \
  --dry-run
```

The preflight accepts only a successful safe-AST mapping and a specific,
source-proven policy combination. It reproduces WP Tiles' reviewed shortcode
behavior, including PHP string truthiness, the selected grid template's
row/adjacency `auto` traversal (including dots and disconnected regions), and
an omitted shortcode pagination value inherited only from the authenticated
global `ajax` setting, before mapping ordered recipe or editorial-page card
references. WP Tiles passes the `category` attribute to WordPress
`category_name`, so category selectors use only an exact normalized comparison
against authoritative source slugs. For multiple exact matches, authoritative
term-language relationships first retain the current-locale taxonomy: exactly
one maps, while same-locale duplicates block. Only when none is current-locale
may a unique, authoritative translation-group target map; no fuzzy, display-name,
or inferred match is allowed. A unique unlocalized exact taxonomy remains a
direct source match and is never treated as an inferred translation.

Under the owner-approved source-fidelity policy, a supported post tile query
whose non-empty category selector has zero exact authoritative category-term
matches maps to a strict `emptyCardGrid` carrying only
`source-category-missing`. It contains no selector values or card identifiers,
is audit-visible as a successful tile mapping, and preserves surrounding
source-backed content. A category that exists but selects zero posts remains
mapping-blocked as `empty-wp-tiles-selection`; unsupported, malformed, unsafe,
or otherwise unproven queries remain blocked. The preflight maps the single
approved `tw/bwg` block to the neutral gallery and Contact Form 7 markers to a
provider-neutral contact-form block without reading form settings or recipient
data. It permits the reviewed featured-image ambiguity only when one exact
featured attachment reference is archive-backed. Unknown markup, query
attributes, unresolved media, failed page/translation closure, and all other
issues remain blocked.
After reviewing a byte-identical dry run, repeat the command with `--write`.
The writer transactionally publishes only the selected validated
`EditorialRecord` records to `content/editorial/{en,fr,ru}/`, the one selected
neutral gallery to `content/galleries/`, and
`content/editorial-gallery-media-manifest.json`. It never writes source media
bytes under `content/` or `public/`.

The editorial/gallery manifest is a bounded deterministic public inventory of
managed object keys, byte sizes, SHA-256 hashes, public source identifiers, and
authoritative display dimensions from WordPress metadata, Photo Gallery
metadata, or bounded parsing of the authenticated image bytes.
It excludes archive paths, source filenames, candidate fingerprints, source
wording, and timestamps. Before writing it, promotion re-inventories the
authorized archives and CRC-checks and hashes every selected entry through
no-follow handles.

Promotion holds `migration-output/.editorial-promotion.lock` through source
authentication, recovery, planning, publication, validation, and cleanup. A
concurrent invocation fails with `promotion-locked`. A hard process death can
leave the lock behind; verify that the original process is dead and inspect the
exact owner-owned `0700` lock directory and its sole `0600` owner marker without
following links before removing it with operator tooling.

The writer uses an HMAC-authenticated bootstrap marker and bounded private
journal in `migration-output/`. Journals record setup, prepared, publishing,
rollback, and cleanup states; recovery accepts only the last complete
authenticated state, removes only authenticated orphan temporary journals, and
fails closed on malformed or symlinked artifacts. Interrupted writes are rolled
back before another dry run or write proceeds.

There is no general overwrite. Byte-equivalent already-published records,
gallery, and manifest entries are reused for idempotency. A record or gallery
change, a conflicting managed-media key, or a changed manifest entry fails
closed. Transactionally backed-up removals are limited to explicit publication
policy outcomes: a source-designated `page_for_posts` record when no archive is
modeled and the owner-excluded obsolete WordPress privacy page. Manifest entries
no longer referenced by retained public content are removed in the same
transaction.

Stdout is aggregate-only: it contains no titles, body text, source paths,
identifiers, timestamps, media filenames, staged records, or candidate
fingerprints. It includes lexically sorted coded block-reason counts for direct
policy, mapping, hierarchy, reference, and translation closure outcomes, plus
separate approved explicit-empty-grid reason counts. The returned media bindings
are used only to authenticate the safe manifest; promotion neither copies nor
publishes media bytes.

The editorial safety budgets count every recognized `posts`-table row toward
`evidence.maxPosts`. `evidence.maxEvidenceReferences` counts one gallery
shortcode occurrence, one distinct inline attachment identifier per page,
every `img`/`source` `src` and `srcset` candidate, one page `_thumbnail_id`
row, and each non-empty BWG original/thumbnail path. Both extraction and
mapping fail with a coded limit error before retaining an over-budget row or
reference.

For the current approved source, repeat dry runs must be byte-identical and
reconcile to 57 pages: 56 published and one private; EN/FR/RU counts of
22/18/17; 18 translation groups (17 triples and one EN/FR pair); and four
ungrouped EN pages. It reports 26 unique page attachments, all archive-backed,
30 featured references, eight inline references, and one unresolved media
reference after validating inherited attachment state. The current validated
status counts are six ready candidates, 49 review candidates, and two
publication-excluded candidates; 20 page candidates are review-gated by
ambiguous canonical attachment paths. Every extracted BWG gallery is staged as
own review candidate, including the unreferenced gallery (67 published images
and 134 original/thumbnail assets), which carries `gallery-reference-missing`.
Every BWG image row whose gallery ID is null, malformed, or missing from the
source is instead retained as its own unassigned-image review candidate; no
synthetic gallery is created. These are review gates, not publication approval.

The authenticated editorial promotion aggregate against the 522-recipe catalog
is 53 direct policy-eligible pages, 27 selected pages (EN/FR/RU: 10/9/8), one
selected neutral gallery, 27 approved explicit empty card grids, and 143
planned media bindings (nine editorial and 134 gallery). The explicit
empty-grid reason is `source-category-missing` (27), separate from mapping
failures. Two pages remain blocked by `unresolved-wp-tiles-recipe-target`;
publishing the three narrowly approved incomplete-translation recipes resolved
one earlier blocked page but did not make integrity-blocked source posts into
recipes. Closure then blocks eight translation peers, 14 descendants, and two
page references. The direct policy blocks remain `publication-excluded` (two)
`source-issues:unresolved-inline-media` (one), and
`owner-excluded-obsolete-privacy-policy` (one).

### Blob-backed editorial and gallery originals

The validated promotion plan contains 27 editorial records, one neutral gallery,
and 143 managed media objects (92,121,745 bytes; nine editorial and 134
gallery). Stage them only after editorial promotion has written the validated public records and
`content/editorial-gallery-media-manifest.json`. This command is
credential-free, makes no Azure request, and prints aggregate object, byte,
created, and reused counts only:

```sh
npm run media:editorial-upload-plan -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/editorial-fingerprint.key \
  --staging-dir migration-output/editorial-v4 \
  --upload-dir migration-output/editorial-media-azure-v4 \
  --expected-ready 6 --expected-review 49 --expected-publication-excluded 2 \
  --expected-gallery-candidates 1 --expected-galleries 1 --expected-selected 27 \
  --dry-run
```

After reviewing a byte-identical dry run, repeat with `--write`. It
re-authenticates the SQL source, upload central-directory contract, private
editorial staging marker, HMAC candidates, selected public records, manifest,
and every media-byte binding before streaming the exact objects to
`migration-output/editorial-media-azure-v4/objects/`. All created directories
are `0700`; objects and the private `upload-manifest.json` are `0600`. Any
existing object tree is recursively checked against the exact planned files and
directories during dry validation, write, and resume; extra files, directories,
or symlinks fail closed. To resume, use `--write --resume`; every existing
object and the manifest must be byte-identical after source re-authentication.

The command accepts no Azure credentials, account, container, destination,
overwrite, output, public-manifest, or media-copy options. Provision and upload
with Azure separately. Do not delete either private object tree until the
post-upload verifier has succeeded.

### Authenticated WPRM promotion

Promotion is a separate, explicit step. Before it can run, regenerate private
staging with the current importer so it writes keyed media bindings for every
ready candidate and every narrowly approved intentional-partial candidate's
selected upload bytes:

```sh
npm run import:wprm-bulk -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --write --staging-dir migration-output/wprm-bulk-v12
```

The prior `wprm-bulk-import-v3` staging format intentionally cannot be resumed
or promoted: it has no private media-byte bindings. The v12 mapper and staging
contract intentionally cannot resume v9 roots: it cryptographically binds the
canonical upload-archive and entry inventory as well as the SQL source, so a
same-count archive replacement fails closed. Keep prior roots for audit if
needed, then create a new private staging root as above rather than trusting or
overwriting it. The v12 `media-bindings.json` is mode
`0600`, contains only
numeric attachment IDs, byte counts, and keyed digests, and must remain outside
Git with the fingerprint key.

Run the authoritative promotion preflight before any write:

```sh
npm run promote:wprm -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --staging-dir migration-output/wprm-bulk-v12 \
  --expected-ready 521 --expected-review 3 --expected-error 15 \
  --dry-run
```

The preflight reimports and authenticates the candidates, fully decompresses
and CRC-checks every selected media entry through no-follow archive handles,
and compares keyed byte bindings before reporting aggregate record and media
counts. Its stdout is aggregate-only: it never prints source paths, media
digests, candidate wording, or private staging contents. `--write` remains a
separate deliberate action and uses a private journal to stage, validate, and
roll back recipe records plus the safe public media manifest. It never writes
original media bytes beneath `public/` or `content/`.

Promotion acquires an exclusive repository-domain
`migration-output/.wprm-promotion.lock` before inspecting recovery state and
keeps it through preflight, publication, validation, and cleanup. A concurrent
invocation exits with `promotion-locked`; it never guesses that a PID is stale
or takes over another transaction. A hard process death can deliberately leave
that lock behind. Before operator recovery, verify through the process
supervisor that the original promotion is dead, inspect the *exact* lock path
without following links, and require an owner-owned `0700` directory containing
only its `0600` owner marker (or no entry if acquisition itself was
interrupted). Then remove that exact verified lock with
no-follow operator tooling and rerun the dry run; do not remove a lock merely
because a PID appears old.

The promotion transaction writes an authenticated bootstrap marker before it
creates transaction directories, then uses bounded HMAC-authenticated journals
with explicit setup, prepared, publishing, rollback, and cleanup states.
Files and parent directories are synced at supported durability boundaries.
Journal temporary files are never used as a newer state: recovery accepts the
last complete journal and removes only same-transaction authenticated orphan
temps. If a crash leaves an ambiguous, tampered, or symlinked transaction
artifact, promotion fails closed without touching live files.
Ready members are excluded when their source translation group has an
integrity-blocking peer. A peer excluded solely by a known non-public source
status is intentionally unavailable instead, so the promoted group contains
only its published variants. The result reports aggregate selected/excluded,
publication-excluded-peer, integrity-blocking-peer, review-peer, and error-peer
counts without emitting source values. Review candidates are eligible only for
the narrow explicitly ungrouped incomplete-parent-translation policy described
above; the authoritative result contains three such candidates and 522 selected
records (EN/FR/RU: 162/172/188).
WPRM public display text is deterministically converted from bounded source
HTML to plain text before promotion. This includes titles, descriptions,
ingredient and instruction group headings, ingredient and equipment fields,
instruction text, custom time labels, rendered taxonomy names, media alt text,
and other rendered recipe text. Entities and block/line semantics are preserved;
malformed or excessive source markup is an explicit error. Source-faithful
editorial HTML remains in the separate `editorial` fields when the authoritative
editorial parent is available.

There is no general overwrite option. The sole historical prototype replacement
is allowlisted for `wordpress:wprm:21681` replacing the tracked
`wordpress:wprm:2980` English `meatballs-soup` seed; it verifies the tracked
seed and its two known placeholder paths before any replacement. The only
other replacement is a narrowly authenticated display-text-normalization
update: the existing record must have identical provenance and normalize
exactly to the freshly authenticated candidate. Slug, source, editorial,
non-text recipe data, and media differences still fail as collisions.

WordPress Recipe Maker and WP Ultimate Recipe identifiers are import-time
source concerns only; WP Ultimate Recipe signals remain unresolved and emit
zero records. Redirect and old-slug candidates are accepted only when their source identity
terminates at one of the 519 independently redirect-eligible recipes; comments, ratings,
and private data are excluded. Original-media handling is the separate
authenticated Blob staging workflow below.

### Blob-backed recipe originals

The 1,244 promoted originals (1,272,117,288 bytes) are staged from the
authorized database, private candidate staging, fingerprint key, and upload
ZIPs before any external upload.
This command is credential-free and makes no Azure request:

```sh
npm run media:upload-plan -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --staging-dir migration-output/wprm-bulk-v12 \
  --upload-dir migration-output/wprm-media-azure-v6 \
  --expected-ready 521 --expected-review 3 --expected-error 15 \
  --dry-run
```

It reruns the same source authentication as promotion, including ZIP CRC,
private keyed-byte bindings, and canonical media bindings, but prints only an
aggregate object and byte count. To stream verified bytes into the private,
Git-ignored staging tree and create the committed safe manifest on its first
run:

```sh
npm run media:upload-plan -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --staging-dir migration-output/wprm-bulk-v12 \
  --upload-dir migration-output/wprm-media-azure-v6 \
  --expected-ready 521 --expected-review 3 --expected-error 15 \
  --write --write-public-manifest
```

The upload source is
`migration-output/wprm-media-azure-v6/objects/`; its layout is exactly the
object-key layout without the leading slash. Directories are `0700`, files and
the private `upload-manifest.json` are `0600`, and dry validation, write, and
resume reject symlinks or any recursive object-tree entry outside the exact
plan. A resume accepts only byte-identical files:

```sh
# Reauthenticates the source and hashes every staged object before reuse.
npm run media:upload-plan -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --staging-dir migration-output/wprm-bulk-v12 \
  --upload-dir migration-output/wprm-media-azure-v6 \
  --expected-ready 521 --expected-review 3 --expected-error 15 \
  --write --resume --write-public-manifest
```

Provision Azure separately; neither plan command accepts Azure credentials,
account keys, connection strings, SAS tokens, or a destination. After
interactive authentication, use real account and container values only in the
operator shell:

```sh
az login
export AZURE_STORAGE_ACCOUNT="<storage-account-name>"
export AZURE_STORAGE_CONTAINER="<public-media-container>"

# Grant anonymous read of individual blobs, not container listing.
az storage container set-permission --auth-mode login \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --name "$AZURE_STORAGE_CONTAINER" --public-access blob

# Use the real Static Web Apps/custom-domain origins; do not use a wildcard.
az storage cors add --auth-mode login --services b \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --methods GET HEAD \
  --origins "https://<static-web-app-domain>" "https://<custom-site-domain>" \
  --allowed-headers "Content-Type" \
  --exposed-headers "Content-Length" "Content-Type" "x-ms-meta-sha256" \
  --max-age 86400

# Repeat per extension so every Blob has the correct MIME type and immutable cache policy.
az storage blob upload-batch --auth-mode login \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --destination "$AZURE_STORAGE_CONTAINER" \
  --source migration-output/wprm-media-azure-v6/objects \
  --pattern "*.jpg" --content-type image/jpeg \
  --content-cache-control "public, max-age=31536000, immutable" --overwrite false
az storage blob upload-batch --auth-mode login \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --destination "$AZURE_STORAGE_CONTAINER" \
  --source migration-output/wprm-media-azure-v6/objects \
  --pattern "*.png" --content-type image/png \
  --content-cache-control "public, max-age=31536000, immutable" --overwrite false
```

Use equivalent `upload-batch` invocations for `.avif`, `.gif`, `.jpeg`, and
`.webp` when present. Configure the container/CDN for public anonymous **blob**
read access (not list access), HTTPS-only delivery, the chosen cache policy,
and Blob CORS allowing the production Static Web Apps/custom-domain origins to
`GET` and `HEAD`; expose `Content-Length`, `Content-Type`, and
`x-ms-meta-sha256` if browser tooling needs them. Blob metadata may record
expected SHA-256 values for operations, but it is not authentication evidence.
Repeating the same commands with
`--overwrite false` never replaces an existing Blob; reconcile any skipped
objects with the verifier before treating the upload as resumed. The
post-upload verifier streams a bounded HTTPS `GET` for every expected object,
requires the exact requested origin/path with no redirect, a `200` response,
the upload plan's normalized `Content-Type`, expected `Content-Length`, exact
byte count, and the manifest SHA-256:

```sh
npm run media:verify-azure -- \
  --account-name "$AZURE_STORAGE_ACCOUNT" \
  --container "$AZURE_STORAGE_CONTAINER" \
  --upload-dir migration-output/wprm-media-azure-v6 \
  --upload-dir migration-output/editorial-media-azure-v4
```

`--upload-dir` may be repeated to verify the disjoint recipe and
editorial/gallery object plans together; duplicate object keys are rejected.
The verifier does not trust caller-supplied metadata or issue an Azure CLI
property lookup. It hashes streams without buffering the media set, prints only
aggregate counts, and fails on unavailable/status/stream, size, or digest
mismatches. Do not delete the private staged objects until it succeeds.

### Bounded source evidence probe

The evidence probe is a read-only, aggregate-only companion to the inventory. It
performs two bounded scans of an approved plain or gzip SQL dump, compares the
decompressed whole-SQL hash between passes, and reads upload ZIP central
directories without extracting files. It inspects only the allowlisted
WordPress structures needed to reconcile WPRM/WPUR signals, Polylang groups,
attachments, redirects, and Photo Gallery relationships. It never writes
recipes, content, or media and never emits source values, filenames, paths,
timestamps, personal data, or record-level entries. PHP and JSON inspection is
bounded by the command's safety limits. Its report is schema v3: its upload
contract cryptographically binds archive SHA-256 identities, canonical
central-directory entry metadata, and normalized upload-path multiplicity
without emitting archive paths or entry names. Recipe/editorial translation
derivation is parent-group authoritative, and Photo Gallery image and thumbnail
coverage reports strict root-normalized matches separately from generic
attachment normalization.

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
