# Contributing

## Start with the repository contract

Read root [`AGENTS.md`](AGENTS.md) for architecture, content fidelity, privacy,
URL safety, and implementation invariants.

Use Node.js 24.20.0 from `.nvmrc` and install the locked dependencies:

```sh
npm ci
npm run dev
```

Do not copy `node_modules`, `.next`, `out`, generated search assets, or
migration outputs between checkouts.

## Make a focused change

- Use a topic branch and keep each pull request cohesive.
- Check the working tree before editing and preserve unrelated changes.
- Follow the task-specific guide linked from `AGENTS.md`; migration operations
  are not prerequisites for ordinary application or documentation work.
- Update the closest canonical document when commands, schemas, architecture,
  migration behavior, or operations change.

Sanitized SQL fixtures are allowed only directly under
`test/fixtures/wordpress/` and must be deliberately created test data, not
copied private source records.

## Validate

For code, content, or executable configuration changes, run the smallest
relevant checks while iterating, then run:

```sh
npm run check
npm run build:ci
```

`npm run check` runs the tracked-path migration-input guard, linting, strict
type checking, Node tests, and recipe/schema checks. `npm run build:ci` adds
content validation and static export. Record actual results and any pre-existing
failures.

For documentation-only changes, verify local links, paths, command names, and
the complete diff. No build is required unless executable behavior also changes.
CI still runs its configured checks. A read-only reviewer can inspect supplied
results but must not claim to have run commands.

`build:local` and `build:ci` are nondeployable when manifest-backed media is
present. Do not set release environment variables for those commands. Follow
[`docs/release-operations.md`](docs/release-operations.md) for a production
artifact.

## Review and pull requests

Before requesting review:

1. Inspect the complete diff for unrelated changes, source-content rewrites,
   generated files, raw migration inputs, credentials, and private data.
2. For route changes, confirm centralized route ownership, sitemap,
   redirect, and release-output validation.
3. For workflow changes, confirm immutable action SHAs, minimal permissions,
   bounded timeouts, and the expected event coverage.
4. Record any administrator-owned or provider-owned launch gate that code
   cannot configure.
5. Require CI and review to pass before merging to `main`.

Detailed private migration procedures are in
[`docs/migration-operations.md`](docs/migration-operations.md). Repository
automation and external GitHub settings are in
[`docs/repository-operations.md`](docs/repository-operations.md).
