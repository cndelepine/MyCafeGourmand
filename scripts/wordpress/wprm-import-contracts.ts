import type { Locale, RecipeRecord } from "../../src/content/schema";
import {
  defaultSourceEvidenceLimits,
  type SourceEvidenceLimits
} from "./source-evidence-contracts";
import {
  defaultUploadArchiveLimits,
  type UploadArchiveInventory,
} from "./uploads-inventory";
import type { SqlDumpStats } from "./sql-stream";

export type WprmImportStatus = "ready" | "review" | "error";

export type WprmIssueCode =
  | "missing-editorial-parent"
  | "self-editorial-parent"
  | "dangling-editorial-parent"
  | "noneditorial-parent"
  | "incomplete-parent-translation"
  | "multiple-recipes-for-editorial-member"
  | "invalid-parent-group-locale"
  | "duplicate-parent-group-locale"
  | "ambiguous-parent-translation-group"
  | "missing-recipe-locale"
  | "unsafe-canonical-slug"
  | "canonical-slug-collision"
  | "nonpublish-recipe"
  | "nonpublish-editorial-parent"
  | "unknown-recipe-status"
  | "unknown-editorial-parent-status"
  | "protected-source-post"
  | "protected-editorial-parent"
  | "timestamp-without-gmt"
  | "missing-wprm-title"
  | "malformed-wprm-rich-text"
  | "rich-text-normalization-limit"
  | "malformed-wprm-ingredients"
  | "malformed-wprm-instructions"
  | "unsupported-wprm-field"
  | "duplicate-singular-meta"
  | "missing-attachment"
  | "unsafe-attachment-path"
  | "attachment-archive-missing"
  | "duplicate-attachment-archive-path"
  | "unsupported-attachment-extension"
  | "invalid-attachment-metadata"
  | "invalid-taxonomy-membership"
  | "excluded-rating-data"
  | "excluded-operational-data"
  | "excluded-author-data"
  | "excluded-social-media-data"
  | "excluded-video-data"
  | "excluded-wprm-type"
  | "unsupported-wprm-type"
  | "malformed-wprm-type"
  | "unsupported-wprm-servings-advanced"
  | "malformed-wprm-servings-advanced"
  | "malformed-wprm-servings-advanced-enabled"
  | "unsupported-wprm-post"
  | "missing-wprm-metadata"
  | "malformed-wprm-meta"
  | "source-changed-during-import"
  | "source-limit"
  | "redirect-candidate"
  | "old-slug-candidate";

export type WordPressPublicationStatus =
  | "published"
  | "publication-excluded"
  | "unknown";

const knownNonPublishedWordPressStatuses = new Set([
  "auto-draft",
  "draft",
  "future",
  "inherit",
  "pending",
  "private",
  "trash"
]);

const publicationExcludedIssueCodes = new Set<WprmIssueCode>([
  "nonpublish-recipe",
  "nonpublish-editorial-parent"
]);

const informationalIssueCodes = new Set<WprmIssueCode>([
  "excluded-rating-data",
  "excluded-operational-data",
  "excluded-author-data",
  "excluded-social-media-data",
  "excluded-video-data",
  "excluded-wprm-type"
]);

export function classifyWordPressPublicationStatus(
  status: string
): WordPressPublicationStatus {
  if (status === "publish") {
    return "published";
  }
  return knownNonPublishedWordPressStatuses.has(status)
    ? "publication-excluded"
    : "unknown";
}

export function sourcePublicationIssueCode(
  status: string,
  source: "recipe" | "editorial-parent"
): WprmIssueCode | null {
  const classification = classifyWordPressPublicationStatus(status);
  if (classification === "published") {
    return null;
  }
  if (classification === "publication-excluded") {
    return source === "recipe"
      ? "nonpublish-recipe"
      : "nonpublish-editorial-parent";
  }
  return source === "recipe"
    ? "unknown-recipe-status"
    : "unknown-editorial-parent-status";
}

export function isPublicationExcludedIssueCode(code: WprmIssueCode) {
  return publicationExcludedIssueCodes.has(code);
}

export function isInformationalWprmIssueCode(code: WprmIssueCode) {
  return informationalIssueCodes.has(code);
}

export type WprmCandidateDisposition =
  | "eligible"
  | "publication-excluded"
  | "integrity-blocking";

export function classifyWprmCandidateDisposition(
  codes: readonly WprmIssueCode[]
): WprmCandidateDisposition {
  if (
    codes.some((code) =>
      !isPublicationExcludedIssueCode(code)
      && !isInformationalWprmIssueCode(code)
    )
  ) {
    return "integrity-blocking";
  }
  return codes.some(isPublicationExcludedIssueCode)
    ? "publication-excluded"
    : "eligible";
}

export interface WprmImportLimits {
  readonly evidence: SourceEvidenceLimits;
  readonly maxRedirectRecords: number;
  readonly maxOldSlugRecords: number;
  readonly maxTaxonomiesPerCandidate: number;
  readonly maxMediaPerCandidate: number;
}

export type WprmImportLimitsInput =
  Omit<Partial<WprmImportLimits>, "evidence">
  & {
    readonly evidence?: Partial<SourceEvidenceLimits> & {
      readonly sql?: Partial<SourceEvidenceLimits["sql"]>;
      readonly uploads?: Partial<SourceEvidenceLimits["uploads"]>;
    };
  };

export const defaultWprmImportLimits: WprmImportLimits = {
  evidence: defaultSourceEvidenceLimits,
  maxRedirectRecords: 100_000,
  maxOldSlugRecords: 100_000,
  maxTaxonomiesPerCandidate: 10_000,
  maxMediaPerCandidate: 10_000
};

export interface RawWordPressPost {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly hasPassword: boolean;
  readonly parentId: string | null;
  readonly slug: string | null;
  readonly title: string | null;
  readonly content: string | null;
  readonly excerpt: string | null;
  readonly createdLocal: string | null;
  readonly createdGmt: string | null;
  readonly modifiedLocal: string | null;
  readonly modifiedGmt: string | null;
  readonly mimeType: string | null;
  readonly wprmReferences: ReadonlySet<string>;
}

export interface RawTerm {
  readonly id: string;
  readonly name: string | null;
  readonly slug: string | null;
}

export interface RawTermTaxonomy {
  readonly id: string;
  readonly termId: string;
  readonly taxonomy: string;
}

export interface RawTermRelationship {
  readonly objectId: string;
  readonly taxonomyId: string;
}

export interface RawAttachment {
  readonly id: string;
  readonly mimeType: string | null;
}

export interface RawRedirect {
  readonly id: string;
  readonly source: string | null;
  readonly matchType: string | null;
  readonly regex: string | null;
  readonly status: string | null;
  readonly actionType: string | null;
  readonly actionCode: string | null;
  readonly actionData: string | null;
}

export interface RawWprmMeta {
  readonly values: ReadonlyMap<string, string>;
  readonly duplicateKeys: ReadonlySet<string>;
  readonly unsupportedKeys: ReadonlySet<string>;
  readonly wprmType: WprmTypeProvenance;
  readonly excludedRatingData: number;
  readonly excludedOperationalData: number;
  readonly excludedAuthorData: number;
  readonly excludedSocialMediaData: number;
  readonly excludedVideoData: number;
  readonly excludedWprmType: number;
  readonly pinImageFieldsWithoutReference: number;
  readonly resolvedPinImageReferences: number;
  readonly unresolvedPinImageReferences: number;
  readonly oldSlugs: readonly string[];
}

export type WprmTypeClassification =
  | "food"
  | "howto"
  | "other"
  | "unknown"
  | "malformed";

export interface WprmTypeProvenance {
  readonly present: boolean;
  readonly raw: string | null;
  readonly classification: WprmTypeClassification;
}

export function classifyWprmType(
  raw: string | null | undefined
): WprmTypeClassification {
  if (raw === undefined) {
    return "food";
  }
  if (raw === null || raw.length === 0 || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return "malformed";
  }
  if (raw === "food") {
    return "food";
  }
  if (raw === "howto") {
    return "howto";
  }
  if (raw === "other" || raw === "non-food") {
    return "other";
  }
  if (/^(?:a|b|d|i|o|r|s|c):/iu.test(raw) || /^[\[{]/u.test(raw)) {
    return "malformed";
  }
  return "unknown";
}

export function wprmTypeProvenance(
  raw: string | null | undefined
): WprmTypeProvenance {
  return {
    present: raw !== undefined,
    raw: raw ?? null,
    classification: classifyWprmType(raw)
  };
}

export interface RawAttachmentMeta {
  readonly attachedFile: string | null;
  readonly alt: string | null;
  readonly dimensions: string | null;
  readonly duplicateKeys: ReadonlySet<string>;
}

export interface WprmSourceGraph {
  readonly posts: ReadonlyMap<string, RawWordPressPost>;
  readonly attachments: ReadonlyMap<string, RawAttachment>;
  readonly terms: ReadonlyMap<string, RawTerm>;
  readonly taxonomies: ReadonlyMap<string, RawTermTaxonomy>;
  readonly relationships: ReadonlyMap<string, ReadonlySet<string>>;
  readonly redirects: readonly RawRedirect[];
  readonly oldSlugCount: number;
  readonly excludedRatingData: number;
}

export interface WprmSourceMetadata {
  readonly wprm: ReadonlyMap<string, RawWprmMeta>;
  readonly attachments: ReadonlyMap<string, RawAttachmentMeta>;
  readonly wpurSignals: ReadonlyMap<string, ReadonlySet<string>>;
  readonly wpurSignalPosts: ReadonlySet<string>;
  readonly sql: SqlDumpStats;
}

export interface WprmSourceSnapshot {
  readonly graph: WprmSourceGraph;
  readonly metadata: WprmSourceMetadata;
  readonly sql: SqlDumpStats;
  readonly uploads: UploadArchiveInventory;
}

export interface CandidateOutcome {
  readonly recipeId: string;
  readonly status: WprmImportStatus;
  readonly locale: Locale | null;
  readonly codes: readonly WprmIssueCode[];
  readonly record: RecipeRecord | null;
  readonly fingerprint: string | null;
}

export interface SafeManifestOutcome {
  readonly recipeId: string;
  readonly locale: Locale | null;
  readonly status: WprmImportStatus;
  readonly codes: readonly WprmIssueCode[];
  readonly fingerprint: string | null;
}

export interface RedirectManifest {
  readonly candidates: number;
  readonly exactSafe: number;
  readonly regex: number;
  readonly unsupported: number;
  readonly unresolvedTarget: number;
  readonly oldSlugCandidates: number;
  readonly accepted: number;
}

export interface WprmAggregateReconciliation {
  readonly wprmPosts: number;
  readonly nonpublishRecipes: number;
  readonly publicationExcludedCandidates: number;
  readonly integrityBlockingCandidates: number;
  readonly usableParents: number;
  readonly missingParents: number;
  readonly provenParentGroups: number;
  readonly incompleteParentGroups: number;
  readonly usableParentRecipesOutsideGroups: number;
  readonly directWprmGroups: number;
  readonly wpurSignals: number;
  readonly wpurRecordsEmitted: number;
  readonly indexedAttachments: number;
  readonly matchedAttachments: number;
  readonly redirectCandidates: number;
  readonly acceptedRedirects: number;
  readonly nonLaunchFields: {
    readonly authorNamesExcluded: number;
    readonly pinImageFieldsExcluded: number;
    readonly pinImageFieldsWithoutReference: number;
    readonly resolvedPinImageReferences: number;
    readonly unresolvedPinImageReferences: number;
    readonly videoFieldsExcluded: number;
    readonly opaqueTypesExcluded: number;
  };
}

export interface WprmSafeManifest {
  readonly schemaVersion: 2;
  readonly kind: "wprm-bulk-import-manifest";
  readonly source: {
    readonly format: "sql" | "gzip";
    readonly decompressedBytes: number;
    readonly sqlDecompressedSha256: string;
    readonly sqlRows: number;
    readonly sqlStatements: number;
    readonly uploads: {
      readonly archives: number;
      readonly entries: number;
      readonly uploadFiles: number;
      readonly matchedAttachments: number;
    };
  };
  readonly candidates: {
    readonly total: number;
    readonly ready: number;
    readonly review: number;
    readonly error: number;
    readonly outcomes: readonly SafeManifestOutcome[];
  };
  readonly wpurSignals: number;
  readonly wpurRecordsEmitted: 0;
  readonly redirects: RedirectManifest;
  readonly aggregate: WprmAggregateReconciliation;
  readonly privacy: {
    readonly rawValuesEmitted: false;
    readonly sourceWordingEmitted: false;
    readonly sourcePathsEmitted: false;
    readonly timestampsEmitted: false;
    readonly serializedValuesEmitted: false;
    readonly individualValueHashesEmitted: 0;
  };
}

export const wprmImportContractVersion = "wprm-bulk-import-v7";

export interface WprmStagedMediaBinding {
  readonly attachmentId: string;
  readonly bytes: number;
  readonly keyedSha256: string;
}

export interface WprmStagedMediaBindings {
  readonly schemaVersion: 1;
  readonly kind: "wprm-staged-media-bindings";
  readonly entries: readonly WprmStagedMediaBinding[];
}

export interface WprmStagingMarker {
  readonly schemaVersion: 2;
  readonly kind: "wprm-bulk-staging";
  readonly sqlDecompressedSha256: string;
  readonly importerContractVersion: typeof wprmImportContractVersion;
  readonly mediaBindingVersion: 1;
}

export interface WprmImportOptions {
  readonly database: string;
  readonly uploadsDir?: string;
  readonly uploadArchives?: readonly string[];
  readonly fingerprintKeyFile: string;
  readonly dryRun?: boolean;
  readonly write?: boolean;
  readonly stagingDir?: string;
  readonly resume?: boolean;
  readonly limits?: WprmImportLimitsInput;
}

export interface WprmBulkImportResult {
  readonly manifest: WprmSafeManifest;
  readonly outcomes: readonly CandidateOutcome[];
  readonly snapshot: WprmSourceSnapshot;
  readonly sourceTranslationGroups: ReadonlyMap<string, string | null>;
}

export class WprmImportError extends Error {
  readonly code: string;

  constructor(code: string, message = "The WPRM bulk import failed.") {
    super(message);
    this.name = "WprmImportError";
    this.code = code;
  }
}

export function isWprmImportIssueCode(value: string): value is WprmIssueCode {
  return [
    "missing-editorial-parent",
    "self-editorial-parent",
    "dangling-editorial-parent",
    "noneditorial-parent",
    "incomplete-parent-translation",
    "multiple-recipes-for-editorial-member",
    "invalid-parent-group-locale",
    "duplicate-parent-group-locale",
    "ambiguous-parent-translation-group",
    "missing-recipe-locale",
    "unsafe-canonical-slug",
    "canonical-slug-collision",
    "nonpublish-recipe",
    "nonpublish-editorial-parent",
    "unknown-recipe-status",
    "unknown-editorial-parent-status",
    "protected-source-post",
    "protected-editorial-parent",
    "timestamp-without-gmt",
    "missing-wprm-title",
    "malformed-wprm-rich-text",
    "rich-text-normalization-limit",
    "malformed-wprm-ingredients",
    "malformed-wprm-instructions",
    "unsupported-wprm-field",
    "duplicate-singular-meta",
    "missing-attachment",
    "unsafe-attachment-path",
    "attachment-archive-missing",
    "duplicate-attachment-archive-path",
    "unsupported-attachment-extension",
    "invalid-attachment-metadata",
    "invalid-taxonomy-membership",
    "excluded-rating-data",
    "excluded-operational-data",
    "excluded-author-data",
    "excluded-social-media-data",
    "excluded-video-data",
    "excluded-wprm-type",
    "unsupported-wprm-type",
    "malformed-wprm-type",
    "unsupported-wprm-servings-advanced",
    "malformed-wprm-servings-advanced",
    "malformed-wprm-servings-advanced-enabled",
    "unsupported-wprm-post",
    "missing-wprm-metadata",
    "malformed-wprm-meta",
    "source-changed-during-import",
    "source-limit",
    "redirect-candidate",
    "old-slug-candidate"
  ].includes(value);
}

export function mergeWprmImportLimits(
  input: WprmImportLimitsInput | undefined
): WprmImportLimits {
  const evidence = {
    ...defaultSourceEvidenceLimits,
    ...(input?.evidence ?? {}),
    sql: {
      ...defaultSourceEvidenceLimits.sql,
      ...(input?.evidence?.sql ?? {})
    },
    uploads: {
      ...defaultUploadArchiveLimits,
      ...(input?.evidence?.uploads ?? {})
    }
  };
  const merged: WprmImportLimits = {
    evidence,
    maxRedirectRecords:
      input?.maxRedirectRecords ?? defaultWprmImportLimits.maxRedirectRecords,
    maxOldSlugRecords:
      input?.maxOldSlugRecords ?? defaultWprmImportLimits.maxOldSlugRecords,
    maxTaxonomiesPerCandidate:
      input?.maxTaxonomiesPerCandidate
      ?? defaultWprmImportLimits.maxTaxonomiesPerCandidate,
    maxMediaPerCandidate:
      input?.maxMediaPerCandidate ?? defaultWprmImportLimits.maxMediaPerCandidate
  };

  const validate = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WprmImportError("invalid-limit", `The ${name} limit is invalid.`);
    }
  };
  for (const [name, value] of [
    ["maxRedirectRecords", merged.maxRedirectRecords],
    ["maxOldSlugRecords", merged.maxOldSlugRecords],
    ["maxTaxonomiesPerCandidate", merged.maxTaxonomiesPerCandidate],
    ["maxMediaPerCandidate", merged.maxMediaPerCandidate],
    ["maxPosts", evidence.maxPosts],
    ["maxPostMetaRows", evidence.maxPostMetaRows],
    ["maxTermRelationships", evidence.maxTermRelationships],
    ["maxRecipeCandidates", evidence.maxRecipeCandidates],
    ["maxEvidenceReferences", evidence.maxEvidenceReferences],
    ["maxPostContentBytes", evidence.maxPostContentBytes],
    ["maxMetaValueBytes", evidence.maxMetaValueBytes],
    ["maxSerializedDepth", evidence.maxSerializedDepth],
    ["maxSerializedEntries", evidence.maxSerializedEntries],
    ["maxShapeKeySets", evidence.maxShapeKeySets]
  ] as const) {
    validate(name, value);
  }
  for (const [name, value] of Object.entries(evidence.sql)) {
    validate(`sql.${name}`, value);
  }
  for (const [name, value] of Object.entries(evidence.uploads)) {
    validate(`uploads.${name}`, value);
  }
  return merged;
}

export function uploadMatchedAttachmentCount(
  snapshot: Pick<WprmSourceSnapshot, "graph" | "metadata" | "uploads">
) {
  let matched = 0;
  for (const [attachmentId, metadata] of snapshot.metadata.attachments) {
    if (
      snapshot.graph.attachments.has(attachmentId)
      && metadata.attachedFile !== null
      && snapshot.uploads.uploadPathCounts.has(metadata.attachedFile)
    ) {
      matched += 1;
    }
  }
  return matched;
}
