# My Cafe Gourmand agent instructions

These instructions apply to the entire repository and are shared by Copilot and Codex agents.

## Mission

Replace the family's WordPress site at `mycafegourmand.com` with a maintainable, low-cost, self-hosted recipe website.

The new design may differ from WordPress, but the migration must preserve:

- all approved recipes, editorial pages, and galleries;
- English, French, and Russian content and translation relationships;
- recipe search, category browsing, serving scaling, and print views;
- contact functionality;
- SEO metadata, structured recipe data, and old-URL redirects.

Comments, ratings, newsletters, advertisements, analytics, and social integrations are not launch requirements unless a task explicitly adds them.

## Current state

This repository is an early Next.js App Router, React, and TypeScript prototype. The single recipe and landing page demonstrate a direction; they are not a complete content model or final architecture.

Key paths:

- `src/app/` - routes, layouts, metadata, and UI
- `src/content/recipes/` - prototype recipe data
- `public/recipes/` - local recipe images
- `scripts/import-wordpress-recipe.mjs` - prototype WordPress recipe importer

Do not assume a CMS, database, hosting platform, URL scheme, or deployment model has been finalized. Prefer decisions that keep Azure and other low-cost managed hosting options viable until an architecture is explicitly selected.

## Source fidelity

Treat an owner-authorized WordPress database/files backup or export as the migration source of truth. Public pages, sitemaps, feeds, REST responses, and web archives may help discover or validate content, but must not silently override source records.

- Preserve original wording, language, IDs, slugs, timestamps, taxonomy membership, media, and translation links.
- Do not invent missing fields, recipes, translations, image descriptions, ratings, or author data.
- Do not automatically translate content.
- Preserve intentionally missing translations.
- Keep old canonical and public URLs in migration metadata so redirects can be generated and audited.
- Support both current WP Recipe Maker data and legacy WP Ultimate Recipe data; do not treat their schemas as interchangeable.
- Keep post/editorial content separate from normalized recipe fields.
- Make import operations deterministic, idempotent, resumable, and safe to run in dry-run mode.
- Produce explicit errors for unsupported or malformed source records. Never omit content silently.

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
- Handle percent-encoded Cyrillic and other Unicode URLs safely.
- Avoid changing a known public URL without adding and testing a permanent redirect.
- Maintain a redirect manifest for root recipe slugs, legacy `/recipe/` routes, language-prefixed routes, print routes, page-style and taxonomy archives, feeds, attachment URLs, and WordPress shortlinks when present in source data.
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
npm run build
```

- The current lockfile requires Node.js 20.9 or newer.
- Run the smallest relevant checks while iterating, then run lint and a production build before reporting an implementation complete.
- There is currently no test command or CI workflow. Do not claim tests or CI passed when they do not exist.
- Add focused automated tests when implementing importers, schema transformations, URL mapping, serving scaling, search, or other behavior with meaningful edge cases.
- Validate migrated counts by content type and language, media existence, translation relationships, structured data, internal links, and redirect coverage.
- Manually check representative current and legacy recipes in English, French, and Russian.
- Report pre-existing validation failures accurately; do not weaken checks or hide errors to produce a passing result.

## Repository hygiene

- Do not edit or commit `.next/`, `next-env.d.ts`, dependency directories, build output, local logs, exports, or temporary migration artifacts.
- Do not make unrelated changes or rewrite source content while performing infrastructure or importer work.
- Update documentation when commands, architecture, content schemas, deployment, or migration procedures change.
- Prefer small, reviewable commits grouped by migration phase.
- When requirements or source data are ambiguous, surface the ambiguity and request a decision instead of choosing a destructive or irreversible interpretation.
