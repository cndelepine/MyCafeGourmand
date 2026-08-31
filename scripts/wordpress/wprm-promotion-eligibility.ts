import type { WordPressRecipeRecordV1 } from "../../src/content/schema";
import {
  classifyWprmCandidateDisposition,
  isInformationalWprmIssueCode,
  type CandidateOutcome
} from "./wprm-import-contracts";

export type PromotionEligibilityResult = {
  readonly selected: readonly WordPressRecipeRecordV1[];
  readonly excluded: number;
  readonly blockedGroups: number;
  readonly intentionallyPartialGroups: number;
  readonly intentionallyPartialCandidates: number;
  readonly publicationExcludedPeers: number;
  readonly integrityBlockingPeers: number;
  readonly reviewPeers: number;
  readonly errorPeers: number;
};

export class WprmPromotionEligibilityError extends Error {
  readonly code:
    | "source-translation-group-missing"
    | "source-translation-group-mismatch";

  constructor(
    code:
      | "source-translation-group-missing"
      | "source-translation-group-mismatch"
  ) {
    super("The WPRM promotion eligibility selection failed.");
    this.name = "WprmPromotionEligibilityError";
    this.code = code;
  }
}

export function isPublicationExcludedOutcome(outcome: CandidateOutcome) {
  return outcome.status === "error"
    && classifyWprmCandidateDisposition(outcome.codes) === "publication-excluded";
}

export function isIntentionallyPartialOutcome(
  outcome: CandidateOutcome,
  sourceTranslationGroup: string | null | undefined
) {
  return outcome.status === "review"
    && outcome.record !== null
    && outcome.record.translationGroupId === null
    && sourceTranslationGroup === null
    && outcome.codes.includes("incomplete-parent-translation")
    && outcome.codes.every((code) =>
      code === "incomplete-parent-translation"
      || isInformationalWprmIssueCode(code)
    );
}

function groupIntegrityBlockers(
  members: readonly CandidateOutcome[],
  selectedIds: ReadonlySet<string>
) {
  return members.filter((member) =>
    !isPublicationExcludedOutcome(member)
    && (member.status !== "ready" || !selectedIds.has(member.recipeId))
  );
}

export function selectPromotionEligibleRecords(
  selected: readonly WordPressRecipeRecordV1[],
  outcomes: readonly CandidateOutcome[],
  sourceTranslationGroups: ReadonlyMap<string, string | null>
): PromotionEligibilityResult {
  const selectedIds = new Set(selected.map((record) => record.source.recipeId));
  const intentionallyPartialCandidates = outcomes.filter((outcome) =>
    isIntentionallyPartialOutcome(
      outcome,
      sourceTranslationGroups.get(outcome.recipeId)
    )
  ).length;
  const membersByGroup = new Map<string, CandidateOutcome[]>();
  for (const outcome of outcomes) {
    const groupId = sourceTranslationGroups.get(outcome.recipeId);
    if (groupId === undefined) {
      throw new WprmPromotionEligibilityError("source-translation-group-missing");
    }
    if (groupId === null) {
      continue;
    }
    const members = membersByGroup.get(groupId) ?? [];
    members.push(outcome);
    membersByGroup.set(groupId, members);
  }

  const blocked = new Map<string, CandidateOutcome[]>();
  const publicationExcluded = new Map<string, CandidateOutcome[]>();
  const integrityBlockers = new Map<string, CandidateOutcome[]>();
  for (const record of selected) {
    const groupId = sourceTranslationGroups.get(record.source.recipeId);
    if (groupId === undefined || groupId !== record.translationGroupId) {
      throw new WprmPromotionEligibilityError("source-translation-group-mismatch");
    }
    if (groupId === null) {
      continue;
    }
    const members = membersByGroup.get(groupId);
    if (members === undefined) {
      blocked.set(groupId, []);
      continue;
    }
    const excludedMembers = members.filter(isPublicationExcludedOutcome);
    if (excludedMembers.length > 0) {
      publicationExcluded.set(groupId, excludedMembers);
    }
    const blockers = groupIntegrityBlockers(members, selectedIds);
    if (blockers.length > 0) {
      blocked.set(groupId, blockers);
      integrityBlockers.set(groupId, blockers);
    }
  }

  const eligible = selected.filter((record) =>
    record.translationGroupId === null
    || !blocked.has(record.translationGroupId)
  );
  const publicationExcludedPeerIds = new Set(
    [...publicationExcluded.values()].flat().map((member) => member.recipeId)
  );
  const integrityBlockingMembers = [...integrityBlockers.values()].flat();
  const integrityBlockingPeerIds = new Set(
    integrityBlockingMembers.map((member) => member.recipeId)
  );
  const intentionallyPartialGroups = [...publicationExcluded.entries()]
    .filter(([groupId]) => !blocked.has(groupId))
    .length;
  return {
    selected: eligible,
    excluded: selected.length - eligible.length,
    blockedGroups: blocked.size,
    intentionallyPartialGroups,
    intentionallyPartialCandidates,
    publicationExcludedPeers: publicationExcludedPeerIds.size,
    integrityBlockingPeers: integrityBlockingPeerIds.size,
    reviewPeers: integrityBlockingMembers.filter((member) => member.status === "review").length,
    errorPeers: integrityBlockingMembers.filter((member) => member.status === "error").length
  };
}
