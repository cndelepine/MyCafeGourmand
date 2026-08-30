# Repository operations

This document covers repository automation and GitHub settings. It does not
provision Azure resources, deploy the site, or select an external service.

## Versioned automation

| File | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` | Linux checks/static build and Windows launcher/build validation |
| `.github/workflows/codeql.yml` | JavaScript and TypeScript security analysis |
| `.github/workflows/copilot-setup-steps.yml` | Node and locked dependency setup for Copilot cloud agent |
| `.github/dependabot.yml` | Weekly npm and GitHub Actions update pull requests |
| `scripts/check-forbidden-migration-inputs.mjs` | Reject tracked raw migration inputs outside the sanitized fixture boundary |

CI and CodeQL run for pull requests targeting `main`, pushes to `main`, and
manual dispatch. CodeQL also runs weekly. Concurrency groups cancel superseded
runs, every job has a timeout, and workflows default to read-only repository
permissions. CodeQL receives only the additional `security-events: write`
permission needed to publish its analysis.

All third-party workflow steps use immutable commit SHAs with a nearby release
comment. Dependabot proposes action updates, but a reviewer must verify that a
new SHA belongs to the stated official release before merging it.

The Copilot setup workflow has the required single `copilot-setup-steps` job.
It must exist on the default branch before Copilot cloud agent uses it. Its
manual trigger exists only to test setup; it is not CI or deployment.

## Administrator-owned launch gates

The files in this repository do **not** configure GitHub repository rules or
security settings. A repository administrator must configure and verify the
following before launch.

### Protect `main`

Create a branch ruleset (or equivalent branch protection) targeting `main`:

- require changes through a pull request;
- require at least one approval and dismiss stale approvals after new commits;
- require all review conversations to be resolved;
- require the branch to be current before merge, or use a configured merge
  queue;
- require these checks after they have run at least once:
  - `CI / Validate on Linux`;
  - `CI / Validate Windows launcher`;
  - `CodeQL / Analyze JavaScript and TypeScript`;
- block force pushes and branch deletion;
- limit bypass permission to the smallest owner/admin set and audit every use.

Do not type required-check names before GitHub has observed the workflows; select
the exact check names shown by the first successful pull request run.

### Enable repository security

In repository security settings:

1. Enable the dependency graph.
2. Enable Dependabot alerts and Dependabot security updates.
3. Enable secret scanning and push protection for contributors.
4. Confirm CodeQL advanced setup is active after `.github/workflows/codeql.yml`
   reaches `main`. Do not enable a duplicate default setup.
5. Configure notifications so a maintained owner receives dependency, secret,
   and code-scanning alerts.

Public repositories can use these native controls without adding a
credential-bearing third-party scanner. Their enabled state must be verified in
GitHub; the presence of this document or a workflow is not proof that the
settings are active.

### Review repository access

- Require two-factor authentication for collaborators where the organization
  supports it.
- Grant write/admin access only where needed.
- Review deploy keys, GitHub Apps, Actions secrets, environments, and webhook
  integrations before launch.
- Keep release credentials out of ordinary CI and Copilot agent setup.

## Routine maintenance

- Review Dependabot pull requests as ordinary code changes; do not auto-merge a
  major runtime, framework, build, or action update.
- Keep `.nvmrc`, `package.json` engines, Node type major, Windows launcher
  check, CI, Copilot setup, and user documentation aligned.
- Resolve CodeQL findings at their source. Suppression requires a documented,
  reviewed reason tied to a specific false positive.
- Re-run the migration-input guard after changing ignore rules or fixture
  locations.
- Revisit the Node LTS line before its maintenance or end-of-life date.

The current Node 24 LTS line reaches end of life in April 2028. Upgrade through
a dedicated pull request that validates the Windows launcher, full checks, and
static build.
