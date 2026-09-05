# Recipe content maintenance

Recipe JSON remains the canonical source for the static site. This directory
supports two strict persisted document versions:

- **v1** is frozen WordPress migration output. Do not clean up its IDs, source
  indexes, taxonomy metadata, raw editorial HTML, historical slugs, or media
  provenance.
- **v2** is the smaller format for genuinely new recipes authored in this
  repository. The catalog derives runtime indexes and category bookkeeping when
  it loads v2.

The browser editor, URL moves, translation mutation, provenance locks, format
rewrites, and authored media ingest are not part of this foundation.

## Requirements

Run commands from the repository root with the Node.js version in `.nvmrc`:

```sh
npm ci
npm run recipes -- --help
```

Every recipe file must be strict UTF-8 JSON with two-space indentation and a
final newline. Git attributes pin recipe and generated schema JSON to LF line
endings, including on Windows, so checkout does not change canonical bytes.
Filenames must exactly match the raw-Unicode NFC slug:

```text
content/recipes/<locale>/<slug>.json
```

The only locales are `en`, `fr`, and `ru`.

Recipe slugs must also be portable across the supported Windows/macOS/Linux
workspaces. They cannot contain Windows-illegal filename characters, end in a
dot or space, or use a reserved basename such as `CON`, `AUX`, `NUL`, `COM1`,
or `LPT1` (including case variants and names with extensions). Each locale is
bounded to 512 records, matching discovery and prospective creation checks.
The complete `<slug>.json` component is bounded for both UTF-8 bytes and UTF-16
units, and same-locale filenames cannot differ only by case.

## Create an authored recipe

Prepare a source-neutral input file outside `content/recipes/`. The input must
contain real recipe wording; the command never invents placeholders,
translations, dates, categories, SEO text, or image descriptions.

```json
{
  "locale": "en",
  "slug": "baked-apples",
  "title": "Baked apples",
  "description": null,
  "publishedAt": null,
  "modifiedAt": null,
  "categories": [],
  "recipe": {
    "notes": null,
    "servings": {
      "raw": "2 servings",
      "value": 2,
      "unit": "servings",
      "scalable": true
    },
    "times": {
      "prep": {
        "raw": "10 minutes",
        "minutes": 10
      },
      "cook": {
        "raw": "30 minutes",
        "minutes": 30
      },
      "rest": null,
      "total": {
        "raw": "40 minutes",
        "minutes": 40
      },
      "custom": null
    },
    "ingredientGroups": [
      {
        "name": null,
        "items": [
          {
            "raw": "2 apples",
            "quantity": {
              "raw": "2",
              "value": 2,
              "unit": null,
              "scalable": true
            },
            "name": "apple",
            "pluralName": "apples",
            "notes": null
          }
        ]
      }
    ],
    "instructionGroups": [
      {
        "name": null,
        "steps": [
          {
            "text": "Bake the apples until tender."
          }
        ]
      }
    ]
  },
  "seo": null
}
```

`recipe.equipment` and an ingredient's `pluralName` are optional. Other
nullable values shown above are required and must remain explicit when their
meaning is "known to be absent." Omitting a field is not equivalent to writing
`null`.

First run a dry run:

```sh
npm run recipes -- new --input ../baked-apples.input.json
```

The output shows the exact destination and complete v2 document, including its
generated stable UUID and source-record creation timestamp. Review it, then
replay those two values with `--write` so the written document is exactly the
reviewed proposal:

```sh
npm run recipes -- new --input ../baked-apples.input.json \
  --id <reviewed-source-record-uuid> \
  --created-at <reviewed-source-created-at> \
  --write
```

`--write` validates the complete prospective catalog and exclusively creates
one file while holding the repository recipe-authoring lock. It never
overwrites an existing destination. If a process dies while holding
`.recipe-authoring.lock`, confirm that process is no longer running before
removing the exact stale lock and repeating the dry run.

The command reports `mode: "write"` only after the target is installed and
post-link finalization succeeds. If a post-link failure can be rolled back, the
command fails with no target. If the recipe is committed but only lock cleanup
fails, the CLI reports `mode: "committed-with-cleanup-error"` and identifies the
cleanup problem; inspect the committed target and named cleanup artifact before
retrying.

On POSIX systems, successful installation and rollback sync both the recipe
destination and staging directories. A rollback durability failure is reported
as `INDETERMINATE`, not as an ordinary uncommitted failure. A combined committed
write and lock-cleanup failure remains a `COMMITTED` error so automation cannot
mistake it for a safe retry.

On Windows, Node does not expose `openat`/directory-handle operations that can
make a staged pathname race-proof. The command therefore avoids hard-linking a
staged path: it opens the final destination with `O_EXCL`, writes the already
validated in-memory bytes through that handle, syncs and verifies those bytes,
and rejects a reparse/non-file destination immediately around creation.
Synchronous failures use identity-bound cleanup. A process or machine crash
during the direct write can leave a partial destination and is indeterminate;
inspect that exact file before removing or retrying it. As elsewhere in the
content boundary, malicious concurrent local filesystem mutation is outside
the guarantee: run authoring commands only in a trusted local workspace.

## Authored timestamp semantics

Authored dates are never guessed:

- `source.createdAt` records when the repository document was created. It is
  provenance only.
- `publishedAt` is emitted as Recipe JSON-LD `datePublished` only when a
  maintainer supplies a factual publication timestamp.
- `modifiedAt` is emitted as Recipe JSON-LD `dateModified` and sitemap
  `lastModified` only when supplied.
- When `modifiedAt` is absent, the sitemap may use `publishedAt`.
- If both are present, `modifiedAt` cannot precede `publishedAt`.

## Categories, translations, and media

An authored category has only a reviewed `name` and canonical `slug`. When that
locale/slug already belongs to a WordPress category, the display name must
match and the recipe joins the existing archive. A conflicting name or route
fails validation.

New recipes begin ungrouped. Do not casually edit `translationGroupId`, a slug,
or a filename: translation link/unlink and URL-preserving move commands are the
next stacked maintenance layer. Existing partial groups remain valid, and the
report labels their absent locales as review gaps rather than claiming the
absence is intentional.

Authored v2 is deliberately image-free. It has no media array, hero image, or
step image fields. Do not add an ad hoc public path or WordPress attachment ID.
A later reviewed layer must define authenticated authored-media ingest, stable
Blob keys, manifest closure, rollback, and remote verification.

Recipe `notes` and optional `equipment` are rendered in normal and print views
and included in search. Equipment is also emitted through Recipe/HowTo JSON-LD
`tool`; notes have no dedicated Recipe structured-data property and remain
rendered/searchable text only.

Recipe details also render every provided preparation, cooking, rest, total,
and custom duration in normal and print views. Original duration text and custom
labels are preserved; missing durations are not calculated or invented, and
serving scaling does not change cooking times.

## Inspect and validate

Print the human-readable catalog report:

```sh
npm run recipes -- report
```

Use `--json` for deterministic machine-readable output. The report includes
exact filenames, canonical paths, schema versions, provenance, translation
groups/gaps, ungrouped records, and a field-usage classification:

- `published` affects rendered pages, navigation, routes, or search;
- `structured-data` affects Recipe JSON-LD or sitemap metadata;
- `provenance-only` preserves origin or migration interpretation.

Regenerate the checked-in IDE schema only after changing the persisted schema:

```sh
npm run recipes -- schema --write
```

VS Code associates `content/schemas/recipe.schema.json` with all three recipe
locale folders. JSON Schema provides strict structural assistance, not complete
standalone publication validation. Its machine-readable
`x-runtime-invariants` array enumerates checks that require repository runtime
logic:

- `recipe-slug-path-and-filename-safety`;
- `category-slug-path-safety`;
- `quantity-range-order`;
- `redirect-route-closure`;
- `recipe-media-path-safety`;
- `wordpress-managed-media-identity`;
- `recipe-media-reference-closure`;
- `authored-id-source-match`;
- `authored-timestamp-order`;
- `catalog-record-and-file-closure`;
- `wordpress-source-identity-and-route`;
- `normalized-display-text`.

The schema structurally distinguishes exact, range, and unparsed quantities and
rejects lossy combinations. `recipes check` additionally enforces the runtime
invariants above, cross-record uniqueness, translation locale closure,
redirect conflicts/cycles, category identity, and media references.

Before committing any direct content edit:

```sh
npm run recipes -- check
npm run check
npm run build:ci
```

`recipes check` is read-only. It rejects malformed or unknown fields,
noncanonical formatting, invalid runtime behavior, and stale generated schema;
it does not rewrite a record.

## Deferred maintenance commands

The next stacked layer should add reviewable, URL-safe commands for:

- move/rename with automatic preservation of the old canonical URL;
- translation link/unlink plus durable intentional-missing metadata;
- provenance locks and explicit acceptance of source corrections;
- generalized lossless formatting writes and any required multi-file rollback.

Raw WordPress HTML sidecars and a Git-backed browser editor remain separate
decisions. No CMS has been selected.
