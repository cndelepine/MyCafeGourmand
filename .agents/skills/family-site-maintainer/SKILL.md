---
name: family-site-maintainer
description: Guide a nontechnical maintainer through proposing or adding one new image-free v2 recipe, changing currently supported authored content, previewing locally, preparing a local update for review, creating a pull request when explicitly requested, or reporting release readiness. Not for private WordPress migration execution, media ingest, contact implementation, provider selection or provisioning, billing, DNS, or production deployment.
---

# Family site maintainer

Read root [AGENTS.md](../../../AGENTS.md) and
[family-maintenance.md](../../../docs/family-maintenance.md). Use the family
guide as the task entry point and its linked specialist guide as the authority
for exact commands and validation.

## Keep the requested boundary

- A proposal or dry run is read-only.
- Applying a change authorizes only the described local file writes.
- Preparing an update for review authorizes diff inspection and validation, not
  a commit, push, or pull request.
- Creating a pull request authorizes the reviewed commit and topic-branch push,
  not a merge.
- Reporting release readiness is evidence gathering, not permission for an
  account, billing, upload, staging, production, traffic, or DNS action.

Do not infer a later authorization from an earlier one. Keep credentials,
private source, upload plans, message contents, and personal data out of chat.
A missing authorized input or owner decision is a blocker.

## Use the supported workflow

1. Classify the request using the table in the family guide.
2. For recipe or content work, read
   [content/README.md](../../../content/README.md). Keep WordPress v1 frozen and
   stop at the current image, move, translation, and provenance boundaries.
3. For preview or review preparation, use the documented existing commands.
   Do not add a convenience command that weakens validation or makes local
   output look deployable.
4. Treat contact as intentionally deferred and outside launch scope. Do not add
   a form, backend, provider integration, or email-link substitute.
5. For release status, read
   [release-operations.md](../../../docs/release-operations.md),
   [deployment.md](../../../docs/deployment.md), and
   [repository-operations.md](../../../docs/repository-operations.md). Separate
   local, repository, external-service, and production evidence.
6. Report actions as performed, proposed, unverified, or blocked. Quote the
   first actionable error and explain it in plain language; never add a bypass
   or success-shaped fallback.

Use the separate `migration-operator` skill only for an explicitly authorized
private WordPress operation.
