# My Cafe Gourmand

A multilingual recipe site replacing the family's WordPress website at
`mycafegourmand.com`.

The application is an early Next.js prototype. Migration work must preserve the
source recipes, English/French/Russian relationships, media, metadata, and old
URLs. See `AGENTS.md` for the shared Copilot and Codex working agreement.

## Requirements

- Node.js 20.9 or newer
- npm

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

## Validation

```sh
npm run check
```

This runs linting, type checking, tests, content validation, and a production
build.

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

Production hosting and CMS details will be documented after their proof of
concept is validated.
