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
final newline. Filenames must exactly match the raw-Unicode NFC slug:

```text
content/recipes/<locale>/<slug>.json
```

The only locales are `en`, `fr`, and `ru`.

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
locale folders. JSON Schema covers strict persisted structure. Repository-only
checks still enforce raw-Unicode path safety, cross-record uniqueness,
translation locale closure, redirect conflicts/cycles, category identity, and
media references.

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
