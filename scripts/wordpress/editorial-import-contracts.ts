import type { Locale } from "../../src/content/schema";
import {
  defaultSourceEvidenceLimits,
  type SourceEvidenceLimits
} from "./source-evidence-contracts";
import type { SqlDumpStats } from "./sql-stream";
import type { UploadArchiveInventory } from "./uploads-inventory";

export const editorialImportContractVersion = "wordpress-editorial-staging-v3";

export type EditorialPublicationStatus =
  | "published"
  | "publication-excluded"
  | "unknown";

export type EditorialCandidateStatus =
  | "ready"
  | "review"
  | "publication-excluded";

export type EditorialPublicationDisposition =
  | "editorial-page"
  | "posts-archive";

export type EditorialIssueCode =
  | "ambiguous-gallery-reference"
  | "ambiguous-attachment-path"
  | "ambiguous-inline-media"
  | "canonical-slug-collision"
  | "conflicting-page-locale"
  | "cyclic-attachment-parent"
  | "attachment-parent-depth-limit"
  | "cyclic-page-parent"
  | "duplicate-attachment-archive-path"
  | "duplicate-attachment-meta"
  | "duplicate-translation-group-locale"
  | "gallery-image-archive-missing"
  | "gallery-image-archive-duplicate"
  | "gallery-image-path-unsafe"
  | "gallery-image-path-unsupported"
  | "malformed-bwg-image-gallery-id"
  | "missing-bwg-image-gallery"
  | "missing-bwg-image-gallery-id"
  | "unknown-gallery-image-publication"
  | "gallery-reference-missing"
  | "invalid-page-ancestor"
  | "incompatible-page-parent-locale"
  | "incompatible-page-parent-publication"
  | "incompatible-page-parent-translation"
  | "attachment-archive-missing"
  | "invalid-attachment-metadata"
  | "invalid-translation-group"
  | "malformed-page-content"
  | "malformed-gallery-reference"
  | "malformed-attachment-parent"
  | "malformed-page-parent"
  | "page-parent-depth-limit"
  | "page-for-posts-archive"
  | "missing-attachment"
  | "missing-attachment-file"
  | "missing-attachment-parent"
  | "missing-page-parent"
  | "missing-page-locale"
  | "missing-page-slug"
  | "missing-page-title"
  | "missing-translation-group"
  | "non-page-attachment-parent"
  | "non-page-parent"
  | "nonpublish-attachment"
  | "nonpublish-attachment-parent"
  | "nonpublish-page"
  | "protected-page"
  | "protected-attachment"
  | "protected-attachment-parent"
  | "source-limit"
  | "unsafe-attachment-path"
  | "unsafe-canonical-slug"
  | "unsafe-inline-media"
  | "unsafe-page-ancestor-slug"
  | "unsafe-internal-link"
  | "unknown-attachment-parent-status"
  | "unknown-attachment-status"
  | "unlocalized-gallery-publication"
  | "unknown-page-status"
  | "unresolved-attachment-parent"
  | "unresolved-inline-media"
  | "unresolved-internal-link"
  | "unsupported-block"
  | "unsupported-contact-form-7"
  | "unsupported-shortcode"
  | "unsupported-gallery-reference"
  | "unsupported-wp-tiles"
  | "unsupported-attachment-extension";

export interface EditorialImportLimits {
  readonly evidence: SourceEvidenceLimits;
  readonly maxPageCandidates: number;
  readonly maxInlineMediaReferences: number;
  readonly maxBwgImageRecords: number;
  readonly maxShortcodesPerPage: number;
  readonly maxBlocksPerPage: number;
}

export type EditorialImportLimitsInput =
  & Omit<Partial<EditorialImportLimits>, "evidence">
  & {
    readonly evidence?: Partial<SourceEvidenceLimits> & {
      readonly sql?: Partial<SourceEvidenceLimits["sql"]>;
      readonly uploads?: Partial<SourceEvidenceLimits["uploads"]>;
    };
  };

export const defaultEditorialImportLimits: EditorialImportLimits = {
  evidence: defaultSourceEvidenceLimits,
  maxPageCandidates: 100_000,
  maxInlineMediaReferences: 100_000,
  maxBwgImageRecords: 100_000,
  maxShortcodesPerPage: 10_000,
  maxBlocksPerPage: 10_000
};

export class EditorialImportError extends Error {
  readonly code: string;

  constructor(code: string, message = "The WordPress editorial import failed.") {
    super(message);
    this.name = "EditorialImportError";
    this.code = code;
  }
}

export function mergeEditorialImportLimits(
  input: EditorialImportLimitsInput | undefined
): EditorialImportLimits {
  const evidence: SourceEvidenceLimits = {
    ...defaultSourceEvidenceLimits,
    ...(input?.evidence ?? {}),
    sql: {
      ...defaultSourceEvidenceLimits.sql,
      ...(input?.evidence?.sql ?? {})
    },
    uploads: {
      ...defaultSourceEvidenceLimits.uploads,
      ...(input?.evidence?.uploads ?? {})
    }
  };
  const merged: EditorialImportLimits = {
    evidence,
    maxPageCandidates:
      input?.maxPageCandidates ?? defaultEditorialImportLimits.maxPageCandidates,
    maxInlineMediaReferences:
      input?.maxInlineMediaReferences
      ?? defaultEditorialImportLimits.maxInlineMediaReferences,
    maxBwgImageRecords:
      input?.maxBwgImageRecords ?? defaultEditorialImportLimits.maxBwgImageRecords,
    maxShortcodesPerPage:
      input?.maxShortcodesPerPage
      ?? defaultEditorialImportLimits.maxShortcodesPerPage,
    maxBlocksPerPage:
      input?.maxBlocksPerPage ?? defaultEditorialImportLimits.maxBlocksPerPage
  };
  const values = [
    ["maxPageCandidates", merged.maxPageCandidates],
    ["maxInlineMediaReferences", merged.maxInlineMediaReferences],
    ["maxBwgImageRecords", merged.maxBwgImageRecords],
    ["maxShortcodesPerPage", merged.maxShortcodesPerPage],
    ["maxBlocksPerPage", merged.maxBlocksPerPage],
    ["maxPosts", evidence.maxPosts],
    ["maxPostMetaRows", evidence.maxPostMetaRows],
    ["maxTermRelationships", evidence.maxTermRelationships],
    ["maxEvidenceReferences", evidence.maxEvidenceReferences],
    ["maxPostContentBytes", evidence.maxPostContentBytes],
    ["maxMetaValueBytes", evidence.maxMetaValueBytes],
    ["maxSerializedDepth", evidence.maxSerializedDepth],
    ["maxSerializedEntries", evidence.maxSerializedEntries],
    ["maxShapeKeySets", evidence.maxShapeKeySets],
    ...Object.entries(evidence.sql),
    ...Object.entries(evidence.uploads)
  ] as const;
  for (const [name, value] of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new EditorialImportError("invalid-limit", `The ${name} limit is invalid.`);
    }
  }
  return merged;
}

const excludedStatuses = new Set([
  "auto-draft",
  "draft",
  "future",
  "inherit",
  "pending",
  "private",
  "trash"
]);

export function classifyEditorialPublicationStatus(
  status: string
): EditorialPublicationStatus {
  if (status === "publish") {
    return "published";
  }
  return excludedStatuses.has(status) ? "publication-excluded" : "unknown";
}

export interface RawEditorialPage {
  readonly id: string;
  readonly status: string;
  readonly hasPassword: boolean;
  readonly parentId: string | null;
  readonly parentIdMalformed: boolean;
  readonly authorId: string | null;
  readonly slug: string | null;
  readonly title: string | null;
  readonly content: string | null;
  readonly excerpt: string | null;
  readonly createdLocal: string | null;
  readonly createdGmt: string | null;
  readonly modifiedLocal: string | null;
  readonly modifiedGmt: string | null;
  readonly guid: string | null;
  readonly source: Readonly<Record<string, string | null>>;
}

export interface RawEditorialAttachment {
  readonly id: string;
  readonly status?: string;
  readonly hasPassword?: boolean;
  readonly parentId?: string | null;
  readonly parentIdMalformed?: boolean;
  readonly mimeType: string | null;
  readonly guid: string | null;
  readonly source: Readonly<Record<string, string | null>>;
}

export interface RawEditorialPostState {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly hasPassword: boolean;
  readonly parentId: string | null;
  readonly parentIdMalformed: boolean;
  readonly menuOrder: number | null;
  readonly menuOrderMalformed: boolean;
  readonly createdGmt: string | null;
}

export interface RawWpTilesGridTemplate {
  readonly id: string;
  readonly status: string;
  readonly hasPassword: boolean;
  readonly title: string | null;
  readonly content: string | null;
  readonly menuOrder: number | null;
  readonly menuOrderMalformed: boolean;
}

export interface RawEditorialAttachmentMeta {
  readonly attachedFile: string | null;
  readonly alt: string | null;
  readonly duplicateKeys: ReadonlySet<string>;
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
  readonly parentTermId: string | null;
  readonly parentTermIdMalformed: boolean;
}

export interface RawBwgGallery {
  readonly id: string;
  readonly source: Readonly<Record<string, string | null>>;
}

export interface RawBwgImage {
  readonly id: string;
  readonly galleryId: string | null;
  readonly galleryIdState: "present" | "missing" | "malformed";
  readonly imageUrl: string | null;
  readonly thumbUrl: string | null;
  readonly alt: string | null;
  readonly description: string | null;
  readonly order: number | null;
  readonly orderMalformed: boolean;
  readonly source: Readonly<Record<string, string | null>>;
}

export interface EditorialSourceGraph {
  readonly posts?: ReadonlyMap<string, RawEditorialPostState>;
  readonly pages: ReadonlyMap<string, RawEditorialPage>;
  readonly attachments: ReadonlyMap<string, RawEditorialAttachment>;
  readonly attachmentMeta: ReadonlyMap<string, RawEditorialAttachmentMeta>;
  readonly featuredMediaReferences: ReadonlyMap<string, readonly (string | null)[]>;
  /**
   * Counts every `_thumbnail_id` row retained for a page, including malformed
   * or duplicate values. This is bounded source evidence, not a count of
   * successfully resolved media records.
   */
  readonly featuredReferenceCount: number;
  readonly featuredMediaDuplicates: ReadonlySet<string>;
  readonly featuredMediaMalformed: ReadonlySet<string>;
  readonly terms: ReadonlyMap<string, RawTerm>;
  readonly taxonomies: ReadonlyMap<string, RawTermTaxonomy>;
  readonly relationships: ReadonlyMap<string, ReadonlySet<string>>;
  readonly gridTemplates: ReadonlyMap<string, RawWpTilesGridTemplate>;
  readonly galleries: ReadonlyMap<string, RawBwgGallery>;
  readonly galleryImages: readonly RawBwgImage[];
}

export interface EditorialSourceSnapshot {
  readonly graph: EditorialSourceGraph;
  readonly sql: SqlDumpStats;
  readonly uploads: UploadArchiveInventory;
  readonly options: {
    readonly homeOrigin: string;
    readonly locales: readonly ["en", "fr", "ru"];
    readonly pageForPosts: string | null;
    readonly wpTilesDefaultGrid: string | null;
    readonly wpTilesPagination: "ajax" | null;
  };
}

export interface EditorialMediaReference {
  readonly sourceId: string;
  readonly roles: readonly ("featured" | "inline")[];
  readonly mimeType: string | null;
  readonly attachedFile: string | null;
  readonly alt: string | null;
  readonly archiveMatch: "matched" | "missing" | "duplicate" | "unsafe";
}

export interface EditorialStructuralAnalysis {
  readonly model: "lossless-wordpress-html-v2";
  readonly shortcodeCounts: readonly {
    readonly name: string;
    readonly count: number;
  }[];
  readonly blockCounts: readonly {
    readonly name: string;
    readonly count: number;
  }[];
  readonly links: {
    readonly internal: number;
    readonly resolved: number;
    readonly unresolved: number;
    readonly unsafe: number;
  };
  readonly inlineMediaReferences: number;
  readonly markupImageReferences: number;
  readonly unresolvedMediaReferences: number;
  readonly unsafeImageReferences: number;
  readonly externalImageReferences: number;
}

export interface EditorialPageCandidate {
  readonly schemaVersion: 1;
  readonly kind: "wordpress-editorial-page-candidate";
  readonly sourceId: string;
  readonly locale: Locale | null;
  readonly translationGroupId: string | null;
  readonly sourcePath: string | null;
  readonly publicationDisposition: EditorialPublicationDisposition;
  readonly publication: EditorialPublicationStatus;
  readonly status: EditorialCandidateStatus;
  readonly issueCodes: readonly EditorialIssueCode[];
  readonly source: {
    readonly post: Readonly<Record<string, string | null>>;
    readonly title: string | null;
    readonly body: string | null;
    readonly excerpt: string | null;
  };
  readonly structure: EditorialStructuralAnalysis;
  readonly media: readonly EditorialMediaReference[];
}

export interface EditorialGalleryAsset {
  readonly sourceId: string;
  readonly role: "original" | "thumbnail";
  readonly storagePath: string | null;
  readonly normalization:
    | "matched"
    | "missing"
    | "duplicate"
    | "unsafe"
    | "unsupported";
}

export interface EditorialGalleryCandidate {
  readonly schemaVersion: 1;
  readonly kind: "wordpress-bwg-gallery-candidate";
  readonly sourceId: string;
  readonly locale: null;
  readonly status: "review";
  readonly issueCodes: readonly EditorialIssueCode[];
  readonly publishedImages: number;
  readonly source: {
    readonly gallery: Readonly<Record<string, string | null>>;
    readonly images: readonly Readonly<Record<string, string | null>>[];
  };
  readonly assets: readonly EditorialGalleryAsset[];
}

export interface EditorialUnassignedBwgImageCandidate {
  readonly schemaVersion: 1;
  readonly kind: "wordpress-bwg-unassigned-image-candidate";
  readonly sourceId: string;
  readonly locale: null;
  readonly status: "review";
  readonly issueCodes: readonly EditorialIssueCode[];
  readonly publishedImages: number;
  readonly source: {
    readonly image: Readonly<Record<string, string | null>>;
  };
  readonly assets: readonly EditorialGalleryAsset[];
}

export type EditorialGalleryRecord =
  | EditorialGalleryCandidate
  | EditorialUnassignedBwgImageCandidate;

export interface EditorialCandidateOutcome {
  readonly sourceId: string;
  readonly locale: Locale | null;
  readonly status: EditorialCandidateStatus;
  readonly publication: EditorialPublicationStatus;
  readonly issueCodes: readonly EditorialIssueCode[];
  readonly record: EditorialPageCandidate;
  readonly fingerprint: string;
}

export interface EditorialGalleryOutcome {
  readonly sourceId: string;
  readonly sourceKind: "gallery" | "unassigned-image";
  readonly record: EditorialGalleryRecord;
  readonly fingerprint: string;
}

export interface EditorialSafeOutcome {
  readonly fingerprint: string;
  readonly locale: Locale | null;
  readonly publicationDisposition: EditorialPublicationDisposition;
  readonly status: EditorialCandidateStatus;
  readonly publication: EditorialPublicationStatus;
  readonly issueCodes: readonly EditorialIssueCode[];
}

export interface EditorialSafeManifest {
  readonly schemaVersion: 2;
  readonly kind: "wordpress-editorial-staging-manifest";
  readonly source: {
    readonly format: "sql" | "gzip";
    readonly decompressedBytes: number;
    readonly sqlDecompressedSha256: string;
    readonly uploadIndexContractSha256: string;
    readonly sqlRows: number;
    readonly sqlStatements: number;
    readonly uploads: {
      readonly archives: number;
      readonly entries: number;
      readonly uploadFiles: number;
    };
  };
  readonly pages: {
    readonly total: number;
    readonly status: Readonly<Record<EditorialCandidateStatus, number>>;
    readonly publication: Readonly<Record<EditorialPublicationStatus, number>>;
    readonly locales: Readonly<Record<Locale | "unlocalized", number>>;
    readonly translation: {
      readonly groups: number;
      readonly completeTriples: number;
      readonly enFrPairs: number;
      readonly ungrouped: number;
    };
    readonly media: {
      readonly uniqueAttachments: number;
      readonly archiveBackedAttachments: number;
      readonly featuredReferences: number;
      readonly inlineReferences: number;
      readonly unresolvedReferences: number;
    };
    readonly issues: readonly {
      readonly code: EditorialIssueCode;
      readonly count: number;
    }[];
    readonly outcomes: readonly EditorialSafeOutcome[];
  };
  readonly gallery: {
    readonly galleries: number;
    readonly imageRows: number;
    readonly assignedImages: number;
    readonly unassignedImages: number;
    readonly candidates: number;
    readonly publishedImages: number;
    readonly assets: number;
    readonly archiveBackedAssets: number;
    readonly status: "review";
    readonly issueCodes: readonly EditorialIssueCode[];
    readonly fingerprints: readonly string[];
  };
  readonly privacy: {
    readonly rawValuesEmitted: false;
    readonly sourceWordingEmitted: false;
    readonly sourcePathsEmitted: false;
    readonly timestampsEmitted: false;
    readonly serializedValuesEmitted: false;
    readonly candidateIdentifiersAreKeyedHmac: true;
  };
}

export interface EditorialImportOptions {
  readonly database: string;
  readonly uploadsDir?: string;
  readonly uploadArchives?: readonly string[];
  readonly fingerprintKeyFile: string;
  readonly dryRun?: boolean;
  readonly write?: boolean;
  readonly stagingDir?: string;
  readonly resume?: boolean;
  readonly limits?: EditorialImportLimitsInput;
}

export interface EditorialImportResult {
  readonly manifest: EditorialSafeManifest;
  readonly outcomes: readonly EditorialCandidateOutcome[];
  readonly gallery: EditorialGalleryOutcome | null;
  readonly galleries: readonly EditorialGalleryOutcome[];
  readonly snapshot: EditorialSourceSnapshot;
}
