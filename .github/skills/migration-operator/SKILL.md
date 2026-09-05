---
name: migration-operator
description: Run, resume, diagnose, or review owner-authorized WordPress source inventory, authenticated recipe/editorial staging, promotion, media upload plans, and post-upload verification. Relevant to private migration operations, not routine application changes, new recipe authoring, public-site scraping, or provider selection.
---

# Migration operator

Read root [AGENTS.md](../../../AGENTS.md) and the relevant section of
[migration-operations.md](../../../docs/migration-operations.md). Paths in the
operator guide are relative to the repository root. Use its command examples
and confirm flags and staging versions against the current implementation;
documented counts are reviewed baselines, not substitutes for current evidence.

## Select the task

- For a code or procedure review, inspect the supplied diff, implementation,
  and sanitized tests. Do not require private backups or execute the migration
  pipeline merely to review it.
- For execution or diagnosis, use only the authorized inputs and exact paths
  supplied by the operator. Never search unrelated directories for backups.
- Run only the requested phase. Inventory, staging, public promotion, private
  media planning, remote upload, and verification are separate operations;
  completing one does not authorize the next.

## Execute the relevant procedure

1. Check the guide's source, privacy, and authorization prerequisites. Report
   missing input or approval rather than guessing values or source interpretation.
2. Use the documented dry run first. Check aggregate counts and contract
   versions against authenticated evidence; compare repeated results for the
   same command and inputs, not results from different pipeline phases.
3. Follow the guide's authorization boundary before writing or contacting an
   external service. Do not add blanket `allowed-tools` shell preapproval.
4. Stop on drift or validation failure. Use the documented recovery rules,
   never an overwrite flag, hand-edited journal, or guessed stale-lock removal.
5. For remote media verification or release work, also read
   [release-operations.md](../../../docs/release-operations.md). Media planning
   is credential-free; it does not authorize provider configuration or upload.
6. Report only aggregate migration results and coded failures. Distinguish
   actions performed from proposed commands and unverified external gates.

Preserve private source, keys, staging, journals, and upload trees; cleanup
requires a separate explicit authorization. A skill is guidance, not a sandbox
or a substitute for importer, promotion, upload-plan, and CI validation.
