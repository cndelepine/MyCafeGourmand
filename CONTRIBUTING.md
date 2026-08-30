# Contributing

## Start with the repository contract

Read root [`AGENTS.md`](AGENTS.md) before changing code, content, migration
tools, routes, or operations. It is the canonical contract for source fidelity,
privacy, static export, URL safety, validation, and milestone review.

Use Node.js 24.20.0 from `.nvmrc` and install the locked dependencies:

```sh
npm ci
npm run dev
```

Do not copy `node_modules`, `.next`, `out`, generated search assets, or
migration outputs between checkouts.

## Make a focused change

- Use a topic branch and keep each pull request cohesive.
- Preserve existing source wording, locale relationships, paths, timestamps,
  taxonomy, redirects, and media metadata unless the task explicitly changes
  an approved source interpretation.
- Keep the static-export architecture. Do not add API routes, Server Actions,
  request-time rendering, or `next start`.
- Reuse shared content schemas and URL-path validation rather than introducing
  route-specific parsing.
- Add focused tests for behavior with meaningful edge cases.
- Update the closest canonical document when commands, schemas, architecture,
  migration behavior, or operations change.

Raw WordPress backups, SQL, WXR, uploads, archives, credentials, private
staging, journals, and personal data never belong in Git. Sanitized SQL fixtures
are allowed only directly under `test/fixtures/wordpress/` and must contain no
source wording or private data not deliberately created for the test.

## Validate

Run the smallest relevant checks while iterating, then run:

```sh
npm run check
npm run build:ci
```

`npm run check` includes the repository migration-input guard. Do not weaken or
skip a failing guard, content check, test, or output validator to make a pull
request pass.

`build:local` and `build:ci` are nondeployable when manifest-backed media is
present. Do not set release environment variables for those commands. Follow
[`docs/release-operations.md`](docs/release-operations.md) for a production
artifact.

## Review and pull requests

Before requesting review:

1. Inspect the complete diff for unrelated changes, source-content rewrites,
   generated files, raw migration inputs, credentials, and private data.
2. Confirm new routes participate in centralized route ownership, sitemap,
   redirect, and release-output validation.
3. Confirm action references are immutable SHAs and workflow permissions and
   timeouts are minimal.
4. Record any administrator-owned or provider-owned launch gate that code
   cannot configure.
5. Require CI and review to pass before merging to `main`.

Detailed private migration procedures are in
[`docs/migration-operations.md`](docs/migration-operations.md). Repository
automation and external GitHub settings are in
[`docs/repository-operations.md`](docs/repository-operations.md).
