# My Cafe Gourmand agent instructions

These instructions apply to the entire repository and are shared by Copilot and Codex agents.

## Mission

Replace the family's WordPress site at `mycafegourmand.com` with a maintainable, low-cost static recipe website.

The new design may differ from WordPress, but the migration must preserve:

- all approved recipes, editorial pages, and galleries;
- English, French, and Russian content and translation relationships;
- recipe search, category browsing, serving scaling, and print views;
- contact functionality;
- SEO metadata, structured recipe data, and permanent redirects from old
  URLs that identified specific recipes.

Comments, ratings, newsletters, advertisements, analytics, and social integrations are not launch requirements unless a task explicitly adds them.

## Current state

This repository is a Next.js App Router, React, and TypeScript static-export
application deployed to Azure Static Web Apps. The catalog is still small and
the importer is a migration foundation, not a complete site migration tool.

Key paths:

- `src/app/` - routes, layouts, metadata, and UI
- `content/recipes/{en,fr,ru}/` - validated recipe JSON records
- `public/recipes/` - local recipe images
- `src/content/url-path.ts` - shared slug and local URL-path validation
- `src/content/staticwebapp.ts` - generated Azure redirects and route checks
- `scripts/import-wordpress-recipe.ts` - WordPress recipe importer foundation
- `scripts/url-inventory/` - bounded public URL discovery and comparison
- `test/` - focused Node test-runner coverage
- `.github/workflows/ci.yml` - lint, typecheck, test, and build validation

Azure Static Web Apps and the static export are the chosen deployment model.
Do not introduce Next.js runtime dependencies such as API routes, Server
Actions, request-time rendering, or `next start`. Features must work in the
generated `out/` artifact or use an explicitly approved external service.

The browser editor is intentionally deferred until a candidate is proven in a
disposable private repository to round-trip nested arrays, optional values, and
`null` in the validated JSON records without lossy rewrites.

## Source fidelity

Treat an owner-authorized WordPress database/files backup or export as the migration source of truth. Public pages, sitemaps, feeds, REST responses, and web archives may help discover or validate content, but must not silently override source records.

- The minimum authoritative handoff is a complete database export and the
  entire `wp-content/uploads/` tree. A WordPress "All content" WXR export is a
  useful independent cross-check; plugin-specific exports are optional.
- Preserve original wording, language, IDs, slugs, timestamps, taxonomy membership, media, and translation links.
- Do not invent missing fields, recipes, translations, image descriptions, ratings, or author data.
- Do not automatically translate content.
- Preserve intentionally missing translations.
- Record old URLs that identified specific recipes in each record's
  `redirectFrom` field so permanent redirects can be generated and audited.
- WP Recipe Maker and WP Ultimate Recipe identification and parsing are
  import-time concerns only; WP Ultimate Recipe is not a runtime feature or a
  promise of broad WordPress URL compatibility, even though historical recipe
  records may be stored there. Do not treat their schemas as interchangeable.
- Keep post/editorial content separate from normalized recipe fields.
- Make import operations deterministic, idempotent, resumable, and safe to run in dry-run mode.
- Produce explicit errors for unsupported or malformed source records. Never omit content silently.
- Treat sitemap, Wayback, and crawl inventories as discovery reports only.
  Reconcile them against authoritative exports and human decisions; never turn
  discovered URLs directly into content records or redirects.

Before bulk importing, fix and validate the prototype importer. It currently does not cover the full site and must not be presented as a complete migration tool.

## Sensitive migration data

- Never commit database dumps, WordPress configuration, credentials, tokens, private backups, form submissions, subscriber lists, private email addresses, or other personal data.
- Store raw exports outside public application directories and outside Git unless a task establishes an approved encrypted storage process.
- Use only small, sanitized fixtures in tests.
- Do not download or publish media until ownership and migration authorization are confirmed.
- Preserve comment and rating data only if their scope and privacy treatment are explicitly approved.

## Implementation standards

- Keep TypeScript strict and avoid `any`, unsafe casts, and silent fallback values.
- Reuse shared schemas, types, parsing helpers, and UI components rather than duplicating recipe-specific logic.
- Validate external and imported data at its boundary before application code consumes it.
- Reuse `src/content/url-path.ts` when validating or canonicalizing slugs and
  local URL paths. Do not replace its layered checks with one-pass decoding or
  ad hoc normalization: validation must account for repeated percent encoding,
  encoded separators, malformed escapes, dot segments, raw Unicode slugs, and
  literal percent encodings. Route lookup may still decode one route segment
  once before matching a validated canonical slug.
- Keep content independent from presentation so recipes can be rendered in normal, print, search, and structured-data contexts.
- Prefer server-rendered output and progressive enhancement. Core recipe content and navigation must remain usable without client-side JavaScript.
- Use `next/image` for site-controlled images unless a documented technical constraint requires otherwise.
- Provide meaningful alt text only when supported by source data or human review; do not fabricate it from filenames.
- Preserve the existing `@/*` path alias.
- Follow the existing style: double quotes, semicolons, and two-space indentation.
- Add comments only where intent or migration-specific behavior is not evident from the code.

## URL, language, and SEO requirements

- Model locales explicitly as `en`, `fr`, and `ru`.
- Preserve translation groups independently of matching titles or slugs.
- Keep canonical slugs as raw Unicode and handle percent-encoded Cyrillic and
  other Unicode safely at URL and redirect-path boundaries.
- Avoid changing a known public URL without adding and testing a permanent redirect.
- Maintain validated per-recipe `redirectFrom` paths for permanent redirects
  from old recipe URLs. Do not promise taxonomy, feed, attachment, print, or
  shortlink URL compatibility.
- Generated recipe redirect destinations must use canonical static-export
  recipe paths, including their trailing slash. Validate generated and
  hand-authored Azure redirects together for conflicts and cycles; do not
  bypass these checks with wildcard redirects.
- Generate canonical URLs and `hreflang` links from validated content relationships.
- Emit valid Recipe JSON-LD on recipe pages and appropriate WebPage, Article, and breadcrumb metadata where applicable.
- Prevent duplicate canonical URLs, redirect loops, and accidental indexing of staging or internal migration pages.

## User experience and accessibility

- Preserve recipe ingredient groups, instruction groups, quantities, units, notes, servings, times, and step images.
- Serving scaling must retain the original values and scale only quantities that can be parsed safely.
- Print views must include the complete recipe without navigation-only or decorative content.
- Search and category pages must work across all supported languages.
- Use semantic HTML, keyboard-operable controls, visible focus styles, sufficient contrast, and responsive layouts.
- Keep important text as text rather than embedding it in images.

## Validation

Use the repository's existing commands:

```sh
npm ci
npm run lint
npm run check
npm run build:ci
```

- The current lockfile requires Node.js 22.13.0 or newer; `.nvmrc` is the
  source for the CI runtime.
- Run the smallest relevant checks while iterating, then run `npm run check` and
  `npm run build:ci` before reporting an implementation complete. `build:ci`
  and `build:local` artifacts are nondeployable when Blob media is present;
  deployment must use the guarded `npm run build:release` command with a
  validated HTTPS `NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL`.
- `npm test` runs the focused Node test suite, and CI runs `npm run check`.
- Declare Node test-runner tests at module scope. Do not dynamically register a
  test inside another test; the outer test can finish before the nested test and
  CI may cancel it even when local output appears successful.
- Add focused automated tests when implementing importers, schema transformations, URL mapping, serving scaling, search, or other behavior with meaningful edge cases.
- Validate migrated counts by content type and language, media existence, translation relationships, structured data, internal links, and redirect coverage.
- Manually check representative recipes and recipe redirect sources in
  English, French, and Russian.
- Report pre-existing validation failures accurately; do not weaken checks or hide errors to produce a passing result.

## Milestone workflow

For each migration milestone:

1. Inspect the complete diff for unrelated changes, generated files, secrets,
   source-content rewrites, and architectural drift.
2. Run focused checks while iterating, then run `npm run check`.
3. Review correctness, security boundaries, and technical debt. Judge large
   files by cohesion and responsibility rather than line count alone.
4. Address review findings and rerun affected checks before committing.
5. Keep the milestone on a topic branch in a small, coherent commit. Merge to
   `main` only after the pull request is reviewed and CI is green.

## Repository hygiene

- Do not edit or commit `.next/`, `next-env.d.ts`, dependency directories, build output, local logs, exports, or temporary migration artifacts.
- Do not make unrelated changes or rewrite source content while performing infrastructure or importer work.
- Update documentation when commands, architecture, content schemas, deployment, or migration procedures change.
- Prefer small, reviewable commits grouped by migration phase.
- When requirements or source data are ambiguous, surface the ambiguity and request a decision instead of choosing a destructive or irreversible interpretation.
