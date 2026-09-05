# WordPress migration operations

These commands are source-specific operations for the owner-authorized My Cafe
Gourmand WordPress snapshot. They are not a general-purpose WordPress migration
tool. Read root `AGENTS.md` before running them.

## Source and privacy boundary

The authoritative handoff is a complete database export and the entire
`wp-content/uploads/` tree. A WordPress "All content" WXR export is an
independent cross-check; plugin exports are optional. Public pages, feeds, REST
responses, sitemaps, and web archives are discovery evidence only and must not
replace or silently override the authorized source.

Keep all of these outside Git and public application directories:

- SQL, WXR, WordPress configuration, raw uploads, and backup archives;
- fingerprint keys and HMAC candidate authentication values;
- private staging records, markers, manifests, locks, and journals;
- generated upload object trees and source-specific reports;
- credentials, form submissions, users, comments, subscribers, private email
  addresses, and other personal data.

The tracked-input guard permits SQL only directly under
`test/fixtures/wordpress/`. Those files must be deliberately sanitized test
data, never copied source records.

Use owner-only permissions for private operations. Initialize keys once;
`set -C` refuses to truncate an existing key. Retain the original keys for
authenticated resumes and recovery:

```sh
(
  umask 077
  set -C
  mkdir -p migration-output &&
  openssl rand 32 > migration-output/wprm-fingerprint.key &&
  openssl rand 32 > migration-output/editorial-fingerprint.key
)
```

The repository ignores `migration-output/`, but ignore rules are not an
authorization to store it in a shared or public location. The tracked-input
guard checks path names, not file contents, and does not prove sanitization.

## Authorization and reporting

Use only the exact inputs supplied by the owner; do not search unrelated
directories for possible backups. Before a private write, public promotion,
network request, upload, permission change, or cleanup, ensure the operator has
explicitly authorized that operation and its exact paths or destinations.
Approval for one phase does not authorize subsequent phases or blanket shell
access. A requested read-only review does not require running these commands.

Keep source wording, private paths and filenames, fingerprint/HMAC values,
credentials, and personal data out of chat and public logs. Report aggregate
results and coded failures; keep detailed artifacts private. Never delete
source, keys, staging, journals, or media objects as routine success cleanup.

## Changing migration implementation

These contracts are tied to the authorized snapshot and reviewed plugin
behavior, not arbitrary WordPress compatibility:

- Identify and parse WP Recipe Maker and WP Ultimate Recipe independently at
  import time; their schemas are not interchangeable and WP Ultimate Recipe
  is not a runtime feature.
- Derive shortcode/plugin behavior from authorized plugin source and
  authenticated WordPress options. Preserve PHP truthiness, global option
  inheritance, traversal order, and case sensitivity where they affect output.
- Keep import operations deterministic, idempotent, resumable, and safe in
  dry-run mode. Unsupported or malformed records need explicit errors, not
  silent omission.
- When source interpretation changes, version the authenticated staging
  contract, reject incompatible resumes, regenerate private staging, and
  compare repeated byte-identical dry runs before writing.
- Validate every live publication destination before recording it in a
  transaction journal. Authentication and rollback cannot repair an invalid
  or differently parsed destination after a crash.
- Require exact closure for upload trees: every planned object must have the
  authenticated bytes and MIME type; reject missing/extra files, directories,
  or symlinks. Remote verification must check exact HTTPS origin/path,
  redirect behavior, status, byte count, hash, and content type.

Keep aggregate baselines and source-specific decisions reviewable. After changes,
validate counts by type and locale, media existence, translations, structured
data, internal links, and redirect coverage in addition to the repository checks.

## Privacy-safe source inventory

The inventory streams a plain or gzip SQL dump and inspects one or more upload
ZIP central directories without extracting them. Its deterministic report
contains aggregate counts and numeric IDs/relationships needed for
reconciliation; it excludes source wording, slugs, bodies, serialized values,
URLs, media filenames, users, comments, contacts, subscribers, and credentials.

Dry-run to stdout:

```sh
npm run inventory:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --dry-run
```

Write an explicit private report:

```sh
npm run inventory:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --write --output migration-output/wordpress-source-inventory.json
```

Malformed or over-limit SQL/ZIP input fails closed. WP Ultimate Recipe's
generic historical `recipe` post type remains ambiguous evidence and is not
silently treated as a normalized recipe.

## Recipe staging

The WPRM importer stages private candidates only. It does not copy media, apply
records to the catalog, or write under `src/`, `content/`, or `public/`.

Run and retain the aggregate-only dry run:

```sh
npm run import:wprm-bulk -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --dry-run
```

After review, write the current private staging contract:

```sh
npm run import:wprm-bulk -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --write --staging-dir migration-output/wprm-bulk-v12
```

Directories are owner-only `0700`; files are `0600`. A populated root must
carry the exact matching format marker. `--resume` accepts only unchanged SQL,
archives, central-directory metadata, and byte-equivalent artifacts. A mapper
or staging contract change requires a new versioned root.

The importer rejects apply, copy-media, content-root, and public-root options.
`import:recipe` is only a deprecated compatibility alias and rejects single
recipe/slug/locale options.

The current approved-source dry run accounts for 539 WPRM records:

- 521 ready candidates;
- three incomplete-translation reviews;
- 15 non-published errors;
- four publication-excluded candidates and 14 integrity-blocking candidates
  in the status-aware reconciliation.

Counts are release evidence, not constants. Stop if the authenticated current
source does not reproduce the reviewed baseline exactly.

## Recipe promotion

Promotion reimports the source, authenticates the staging marker and candidates,
decompresses/CRC-checks selected media entries, and checks keyed media-byte
bindings. Run preflight before every write:

```sh
npm run promote:wprm -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/wprm-fingerprint.key \
  --staging-dir migration-output/wprm-bulk-v12 \
  --expected-ready 521 --expected-review 3 --expected-error 15 \
  --dry-run
```

Require a byte-identical successful dry run, then repeat the exact command with
`--write` only after an explicit publication decision. There is no general
overwrite option.

The transaction holds `migration-output/.wprm-promotion.lock`, writes an
HMAC-authenticated bootstrap marker, and uses bounded authenticated journals
through setup, prepared, publishing, rollback, and cleanup states. It publishes
validated recipe records and the safe public media manifest, never original
media bytes.

The reviewed promotion selects 522 recipes (EN/FR/RU: 162/172/188). Review
candidates are eligible only under the narrow authenticated
incomplete-parent-translation policy. Non-public and integrity-blocking peers
remain excluded.

## Editorial and gallery staging

Editorial import separately stages authoritative WordPress pages and BWG
gallery evidence. Candidate source bodies remain private; only a promoted,
validated safe AST enters public content.

Dry-run:

```sh
npm run import:editorial -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/editorial-fingerprint.key \
  --dry-run
```

Write the current private staging contract:

```sh
npm run import:editorial -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --fingerprint-key-file migration-output/editorial-fingerprint.key \
  --write --staging-dir migration-output/editorial-v4
```

The importer validates authoritative WordPress/Polylang options, the
`page_for_posts` record, parent chains, links, all image candidates, archive
coverage, gallery references, and bounded WP Tiles settings. It does not infer
locales, translations, author names, alt text, or pagination. Unknown markup,
unsafe/unresolved links or media, unsupported tiles, hierarchy failures, and
unlocalized gallery publication remain explicit review gates.

The current source baseline is 57 pages: 56 published and one private
(EN/FR/RU: 22/18/17), with 18 translation groups and four ungrouped English
pages. It stages one referenced gallery with 67 images and 134 original/
thumbnail assets. Current status counts are six ready, 49 review, and two
publication-excluded page candidates.

## Editorial and gallery promotion

Promotion requires exactly one mode, `--dry-run` or `--write`, and exact
operator-supplied counts:

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

After reviewing a byte-identical result, repeat the exact command with
`--write`. The transaction publishes only the selected
`content/editorial/{en,fr,ru}/` records, selected neutral gallery, and
`content/editorial-gallery-media-manifest.json`. It never publishes source
media bytes.

The authenticated current aggregate is 27 editorial pages (10/9/8), one
neutral gallery, 27 approved explicit empty grids with reason
`source-category-missing`, and 143 planned media bindings (nine editorial and
134 gallery). Every other mapping, reference, hierarchy, translation-closure,
or publication-policy blocker remains closed.

Editorial promotion uses
`migration-output/.editorial-promotion.lock` and the same authenticated
transaction/recovery principles as recipe promotion.

## Media upload plans

The plan commands are credential-free. They authenticate source, candidates,
public records/manifests, and exact source bytes, then create private object
trees. They accept no Azure credentials, account, container, destination, or
overwrite option.

### Recipe media

Dry-run:

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

After review:

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

The current plan is 1,244 objects totaling 1,272,117,288 bytes.

### Editorial and gallery media

Dry-run:

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

After review, repeat with `--write`. The current plan is 143 objects totaling
92,121,745 bytes.

Every object directory must contain exactly the planned regular files and
directories. Extra, missing, changed, or symlinked entries fail dry validation,
write, and resume. Resume only with the documented `--write --resume` mode and
byte-identical existing objects/manifests.

Provision/upload externally, then perform the combined exact remote check in
[`release-operations.md`](release-operations.md). Keep both private object
trees until it succeeds.

## Bounded source evidence

The evidence probe is read-only and aggregate-only. It scans approved SQL
twice, checks the whole decompressed hash, and authenticates the upload archive
contract without extracting or exposing paths:

```sh
npm run probe:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --baseline /path/to/wordpress-source-inventory-v3.json \
  --dry-run
```

`--baseline` accepts only the sanitized
`kind: "wordpress-source-inventory"` schema-v3 report. An explicit private
report may use:

```sh
npm run probe:wordpress-source -- \
  --database /path/to/approved/wordpress.sql.gz \
  --uploads-dir /path/to/approved/upload-archives \
  --baseline /path/to/wordpress-source-inventory-v3.json \
  --write --output migration-output/wordpress-source-evidence.json --overwrite
```

Evidence is reconciliation input, never recipe/content/media extraction.

## Archived URL inventory

The URL inventory follows bounded XML sitemap indexes/urlsets only. It does not
crawl content pages or create redirects:

```sh
npm run inventory:urls -- \
  --sitemap https://web.archive.org/web/20240101000000id_/https://mycafegourmand.com/sitemap_index.xml
```

To write an explicit private report:

```sh
npm run inventory:urls -- \
  --sitemap /path/to/sitemap_index.xml \
  --write --output migration-output/url-inventory.json
```

Existing output requires `--overwrite`. Remote hosts and redirects are bounded
to My Cafe Gourmand and its Wayback captures. Discovered paths are classified
against validated current routes and redirects; they never become content or
redirect decisions automatically.

## Failure and recovery rules

- Stop on any source/archive/hash/count/contract drift, unsupported record,
  validation error, unexpected object-tree entry, symlink, or lock conflict.
- Never guess that a lock is stale. Verify through the process supervisor that
  the original process is dead, then inspect the exact owner-owned `0700` lock
  directory and its sole `0600` marker without following links. Removal is a
  separate explicit operator action.
- Never edit markers or journals. Recovery accepts only authenticated complete
  states and fails closed on malformed, ambiguous, or symlinked artifacts.
- Do not use stale staging after a mapper or contract version change.
- Do not delete source, keys, staging, journals, or media objects as part of a
  successful promotion or verification run.
- Never add a general overwrite, apply, media-copy, public-root, content-root,
  or destination escape hatch.

After any public promotion, run:

```sh
npm run check
npm run build:ci
```

Then inspect representative English, French, and Russian recipes, editorial
pages, translation relationships, media, structured data, internal links, and
redirect sources before review.
