# My Cafe Gourmand agent instructions

This is the shared repository contract for Copilot and Codex. Keep durable
invariants here and task-specific procedures in the linked documents.

## Purpose and architecture

Replace the family's WordPress site at `mycafegourmand.com` with a maintainable,
low-cost static recipe site. Preserve approved English, French, and Russian
recipes, editorial pages, galleries, translations, search, categories, serving
scaling, print views, SEO, and historical URL compatibility. Contact
functionality is deferred: do not add a form provider, backend, or email-link
substitute. Preserve frozen source contact records; historical contact routes
may show a localized no-service notice, but must not advertise contact
availability or claim submission success. Comments, ratings, newsletters, ads,
analytics, and social integrations are also outside launch scope unless
explicitly requested.

- Use Next.js App Router, React, and strict TypeScript with static export for
  Azure Static Web Apps. No API routes, Server Actions, request-time rendering,
  or `next start`; features must work in `out/` or use an approved external service.
- Keep content in validated JSON under `content/`, independent of presentation.
  Reuse shared schemas, types, parsing helpers, and UI components.
- Prefer static server-rendered content and progressive enhancement. Core
  content and navigation must remain usable without client-side JavaScript.
- Do not provision services or choose a CMS as an incidental code change. The
  browser editor remains deferred pending a demonstrated lossless round trip
  of nested arrays, optional fields, and explicit `null` in a private test repo.

## Read by task

| Task | Guidance |
| --- | --- |
| Family-friendly recipe, preview, review, or release-status requests | [docs/family-maintenance.md](docs/family-maintenance.md) |
| Setup, contribution, validation, and pull requests | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Recipe authoring, schema, or catalog maintenance | [content/README.md](content/README.md) |
| WordPress import, promotion, media plans, or source interpretation | [docs/migration-operations.md](docs/migration-operations.md) |
| Release artifacts or remote media verification | [docs/release-operations.md](docs/release-operations.md) |
| Deployment, legacy URL navigation pages, or launch gates | [docs/deployment.md](docs/deployment.md) |
| Invited-family Azure dev/test infrastructure and access | [docs/azure-family-test.md](docs/azure-family-test.md) |
| GitHub Actions, Copilot customization, or repository settings | [docs/repository-operations.md](docs/repository-operations.md) |

Read the relevant guide before changing its implementation or running its
operations. Skills and custom agents are optional helpers, not required review
rituals or enforcement mechanisms; critical checks belong in code and CI.

## Operator and authorization boundaries

- Distinguish inspection or dry run, local file writes, commits, pushes or pull
  requests, external-service actions, and production actions. Authorization for
  one boundary does not authorize the next.
- Accounts or billing, public uploads, any future live contact test, staging
  deployments, production traffic or DNS, and private-artifact cleanup each
  require explicit owner approval of the exact scope. Never treat available
  credentials or work credit as approval.
- Report actions as performed, proposed, unverified, or blocked. Give
  nontechnical maintainers the first actionable error in plain language, but do
  not bypass a guard or infer GitHub, provider, staging, or production readiness.
- Keep credentials, private source, upload plans, form-message contents, and
  personal data out of agent chat. A missing authorized input is a blocker, not
  permission to search unrelated folders.

## Content and privacy

- For migrated content, the owner-authorized WordPress backup/export is the
  source of truth. Public pages, feeds, REST, sitemaps, and archives are discovery
  evidence only; never turn discovered URLs directly into records or legacy
  mappings.
- Preserve source wording, IDs, slugs, timestamps, taxonomy, media, translation
  relationships, and intentionally missing translations. Do not invent fields
  or automatically translate content. Keep editorial content separate from
  normalized recipe fields.
- Keep migrated WordPress v1 records frozen. New image-free recipes use the
  source-neutral authored v2 schema and guarded workflow in `content/README.md`;
  never fabricate WordPress provenance. Moves, translation mutation, provenance
  locks, and authored media ingest remain deferred.
- Never commit raw backups, SQL/WXR exports, WordPress configuration, credentials,
  private staging, journals, uploads, form submissions, or personal data. Keep
  private inputs outside Git and public application directories; use only small,
  sanitized test fixtures. Never download or publish media without authorization.
- Do not rewrite source content during unrelated infrastructure work. Surface
  ambiguity before destructive or irreversible changes. Keep volatile counts
  in validated reports and `README.md`, not in this contract.

## URLs, language, and metadata

- Model locales explicitly as `en`, `fr`, and `ru`; derive canonical URLs and
  `hreflang` from validated translation groups, not matching titles or slugs.
- Reuse `src/content/url-path.ts` for slugs and local paths. Preserve raw-Unicode
  canonical slugs and layered checks for repeated encoding, encoded separators,
  malformed escapes, dot segments, and literal percent encodings. Route lookup
  may decode one segment once to match a validated slug; do not replace validation
  with that decoding.
- Preserve known public URLs with tested `redirectFrom` source entries. The
  approved Azure-only release design generates one static HTTP 200 navigation
  page per validated source, with an immediate meta refresh, canonical URL, and
  visible fallback link; it must not require JavaScript. Destinations use
  canonical paths with trailing slashes. Validate complete legacy-source
  coverage, encoding, path and output collisions, and cycles; never bypass
  checks with wildcards or promise arbitrary WordPress compatibility.
- Keep new routes and generated assets in centralized reserved paths, static
  route enumeration, sitemap policy, legacy-mapping checks, and output validation.
- Preserve Recipe JSON-LD, appropriate editorial/breadcrumb metadata, and
  noindex boundaries. Prevent duplicate canonicals and legacy navigation loops.

## Implementation and validation

- Avoid `any`, unsafe casts, and silent fallbacks. Validate external data at its
  boundary. Preserve the `@/*` alias, double quotes, semicolons, and two-space
  indentation; comment only non-obvious intent.
- Preserve recipe groups, quantities, units, notes, servings, times, and images.
  Scaling retains originals and changes only safely parsed quantities; print
  views retain the complete recipe without navigation-only decoration.
- Use semantic HTML, keyboard controls, visible focus, sufficient contrast, and
  responsive layouts. Use `next/image` for site-controlled images unless a
  technical constraint is documented; never fabricate alt text from filenames.
- Use the Node version in `.nvmrc` and locked dependencies. For code, content,
  or executable configuration changes, run focused checks, then `npm run check`
  and `npm run build:ci`. Documentation-only changes need link/path and diff
  review, not a rebuild. Report failed or unrun checks accurately; never weaken
  validation to pass.
- Add focused tests for edge cases. Declare Node tests at module scope, not
  dynamically inside other tests. Manually check affected content/navigation
  in each locale when changing rendered output or routes.
- Treat local/CI artifacts as nondeployable. `build:release` stays fail-closed
  until checked-in generation and output validation prove that every exact
  legacy source has the required static navigation page.
  Keep `.deployment/` metadata outside public `out/`.
- Do not commit `.next/`, `next-env.d.ts`, dependencies, build outputs, generated
  search assets, logs, or private migration artifacts.
- Inspect the complete diff before committing. Keep changes cohesive, update
  the relevant documentation, and merge only after review and passing CI.
