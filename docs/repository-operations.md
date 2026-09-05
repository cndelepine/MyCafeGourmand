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
| `scripts/check-forbidden-migration-inputs.mjs` | Reject tracked paths matching forbidden migration-input names, except the SQL fixture boundary |

CI and CodeQL run for pull requests targeting `main`, merge-queue check
requests, pushes to `main`, and manual dispatch. CodeQL also runs weekly.
Concurrency groups isolate pull request numbers and merge-group head SHAs so
superseded runs cancel without crossing changes. Every job has a timeout, and
workflows default to read-only repository permissions. CodeQL receives only the
additional `security-events: write` permission needed to publish its analysis.

All third-party workflow steps use immutable commit SHAs with a nearby release
comment. Dependabot proposes action updates, but a reviewer must verify that a
new SHA belongs to the stated official release before merging it.

The Copilot setup workflow has the required single `copilot-setup-steps` job.
It must exist on the default branch before Copilot cloud agent uses it. Its
manual trigger exists only to test setup; it is not CI or deployment.
GitHub may continue the agent session after a failed setup step, so setup success
is not a validation gate. Inspect setup logs when dependencies are missing and
use the ordinary repository checks to establish correctness.

## Copilot customization

Keep each customization focused:

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Short shared repository invariants and links to task guides |
| `.github/copilot-instructions.md` | Compatibility entry point directing Copilot to that contract |
| `.github/skills/migration-operator/SKILL.md` | Task-specific guidance for private migration work |
| `.github/agents/migration-release-reviewer.agent.md` | Optional review focus with file-read/search tools only |

GitHub documents `.github/copilot-instructions.md` as repository-wide
instructions; support for `AGENTS.md` varies by client. A Markdown link requests
reading another file, not automatic inclusion. Keep important invariants in
the shared contract rather than duplicating a long prompt across both files.

Project skills are discovered under `.github/skills/<name>/SKILL.md`. Their YAML
frontmatter needs `name` and a `description` explaining intent and when the skill
is relevant. Descriptions help selection; they do not guarantee activation.
Use the operator guide directly if a skill is unavailable. Do not put critical
validation solely in skill instructions or add shell preapproval to avoid
operation-specific authorization.

Custom agent profiles live under `.github/agents/` with a required description.
The reviewer's `read` and `search` entries are documented tool aliases for file
reading and code/file search. It intentionally has no execution, edit, web, or
delegation tools. Supply its diff (or readable before/after artifacts) and test
results; do not expect it to obtain a Git diff through a shell or run validation.
A profile describes a review role, not a sandbox or mandatory approval gate.

Keep discovery/frontmatter/tool assumptions aligned with the official references:

- [Custom instruction support](https://docs.github.com/en/copilot/reference/custom-instructions-support)
- [Adding agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [Custom agent configuration and tool aliases](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- [Cloud-agent environment setup](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)

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
  locations. It checks tracked path names only: it does not inspect file bytes,
  prove a fixture is sanitized, find arbitrary renamed secrets, or scan untracked
  files and Git history. Diff review and GitHub security controls remain separate.
- Revisit the Node LTS line before its maintenance or end-of-life date.

The current Node 24 LTS line reaches end of life in April 2028. Upgrade through
a dedicated pull request that validates the Windows launcher, full checks, and
static build.
