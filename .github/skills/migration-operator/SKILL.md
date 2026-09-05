---
name: migration-operator
description: Safely operates this repository's owner-authorized WordPress inventory, authenticated staging, promotion, media-plan, and post-upload verification commands. Use only when asked to run, resume, diagnose, or review those private migration operations; do not use for routine application changes, public-site scraping, or cloud-provider selection.
---

# Migration operator

Read `AGENTS.md` and `docs/migration-operations.md` before acting. Treat the
documented commands, current staging versions, expected counts, and source
contracts as authoritative; do not reconstruct commands from memory.

## Preconditions

- Require an owner-authorized WordPress database/files backup or export.
- Keep raw SQL, WXR, uploads, archives, fingerprint keys, private manifests,
  journals, and staging trees outside Git and public application directories.
- Confirm inputs are regular files/directories at the exact operator-provided
  paths. Never search unrelated directories for possible backups.
- Do not substitute public pages, REST responses, sitemaps, or web archives for
  the authoritative source.
- Never print or summarize source wording, paths, filenames, private metadata,
  HMAC values, credentials, or personal data.

## Operating sequence

1. Run the relevant privacy-safe inventory or evidence command in dry-run mode.
2. Run the recipe or editorial importer with `--dry-run`; retain and compare
   only its aggregate safe manifest.
3. Before staging, require the operator's explicit approval for the exact
   `--write --staging-dir` command. Use a new versioned private staging root
   when the marker contract changes; use `--resume` only where the documented
   command supports it.
4. Re-run promotion with `--dry-run`, exact expected counts, the same source,
   archives, fingerprint key, and staging root. Require a byte-identical
   successful result before proposing `--write`.
5. Treat promotion as a separate irreversible publication decision. Run the
   exact `--write` command only after explicit operator approval; never add an
   overwrite, apply, copy-media, destination, content-root, or public-root flag.
6. Generate recipe and editorial/gallery media upload plans independently.
   Dry-run first, then require approval for each write or resume command.
7. External upload is an operator-owned, interactively authenticated step.
   Do not choose a provider, account, container, CDN, permissions policy, or
   deployment architecture.
8. After upload, run `npm run media:verify-azure` against every planned upload
   directory together. Keep private object trees until exact HTTPS origin/path,
   redirect, status, byte count, hash, and content-type verification succeeds.
9. Run repository validation and the guarded release checks required by
   `docs/release-operations.md`; never deploy a `build:local` or `build:ci`
   artifact.

## Safety boundaries

- Ask for command-specific approval when a command writes files, contacts an
  external service, authenticates, uploads, changes permissions, or publishes
  content. Never request or grant blanket shell preapproval.
- Stop on changed sources, changed archives, count drift, non-byte-identical dry
  runs, malformed markers/journals, unexpected files, symlinks, lock conflicts,
  or validation failures. Do not weaken checks or silently skip records.
- Never guess that a promotion lock is stale. Follow the exact inspected-lock
  recovery procedure in the operator documentation.
- Never delete private source, staging, journals, or media objects as part of a
  successful run. Cleanup is a separate, explicitly authorized operation.
- Report only aggregate safe results and coded failures.
