import {
  defaultSqlDumpLimits,
  type SqlDumpLimits
} from "./sql-stream";
import {
  defaultUploadArchiveLimits,
  type UploadArchiveLimits
} from "./uploads-inventory";

export type SafeShapeEncoding =
  | "absent"
  | "empty"
  | "plain"
  | "php-serialized"
  | "json"
  | "malformed-php"
  | "malformed-json"
  | "unsupported-serialized-type"
  | "limit-exceeded";

export interface ShapeContract {
  readonly root: "array" | "object";
  readonly allowedGroupKeys: readonly string[];
  readonly allowedItemKeys: readonly string[];
}

export interface SafeKeySetCount {
  readonly keys: readonly string[];
  readonly count: number;
}

export interface StructuralShapeEvidence {
  readonly encoding: Record<SafeShapeEncoding, number>;
  readonly rootKinds: Record<"array" | "object" | "scalar" | "none", number>;
  readonly groupKeySets: readonly SafeKeySetCount[];
  readonly itemKeySets: readonly SafeKeySetCount[];
  readonly malformed: number;
}

export type StructuralShapeEvidenceDelta = StructuralShapeEvidence;

export type Locale = "en" | "fr" | "ru";
export type IdSet = Set<string>;

export type BwgStoragePathKind =
  | "relative-to-bwg-root"
  | "single-leading-bwg-relative"
  | "already-archive-relative"
  | "wordpress-root-relative"
  | "absolute"
  | "empty"
  | "external"
  | "unsafe"
  | "unsupported";

export interface BwgArchivePathCandidate {
  readonly kind: BwgStoragePathKind;
  readonly archivePath: string | null;
}

export const sourceEvidenceSchemaVersion = 2;

export interface SourceEvidenceLimits {
  readonly sql: Partial<SqlDumpLimits>;
  readonly uploads: Partial<UploadArchiveLimits>;
  readonly maxPosts: number;
  readonly maxPostMetaRows: number;
  readonly maxTermRelationships: number;
  readonly maxRecipeCandidates: number;
  readonly maxEvidenceReferences: number;
  readonly maxPostContentBytes: number;
  readonly maxMetaValueBytes: number;
  readonly maxSerializedDepth: number;
  readonly maxSerializedEntries: number;
  readonly maxShapeKeySets: number;
}

export const defaultSourceEvidenceLimits: SourceEvidenceLimits = {
  sql: defaultSqlDumpLimits,
  uploads: defaultUploadArchiveLimits,
  maxPosts: 100_000,
  maxPostMetaRows: 1_000_000,
  maxTermRelationships: 1_000_000,
  maxRecipeCandidates: 10_000,
  maxEvidenceReferences: 1_000_000,
  maxPostContentBytes: 1_048_576,
  maxMetaValueBytes: 4_194_304,
  maxSerializedDepth: 64,
  maxSerializedEntries: 100_000,
  maxShapeKeySets: 128
};

export interface SourceEvidenceOptions {
  readonly database: string;
  readonly uploadArchives?: readonly string[];
  readonly baseline?: SourceEvidenceBaseline;
  readonly limits?: Partial<SourceEvidenceLimits>;
}

export class SourceEvidenceError extends Error {
  readonly code: string;

  constructor(code: string, message = "The WordPress source evidence probe failed.") {
    super(message);
    this.name = "SourceEvidenceError";
    this.code = code;
  }
}

export interface SourceEvidenceBaselineMetrics {
  readonly posts: number;
  readonly pages: number;
  readonly wprmPostRecords: number;
  readonly wpurMetadataSignalPosts: number;
  readonly postTranslationGroups: number;
  readonly termTranslationGroups: number;
  readonly redirectionPluginRecords: number;
  readonly legacyOldSlugRecords: number;
  readonly matchedAttachments: number;
  readonly bwgImageRecords: number;
}

export interface SourceEvidenceBaseline {
  readonly kind: "wordpress-source-inventory";
  readonly schemaVersion: 3;
  readonly metrics: SourceEvidenceBaselineMetrics;
}

export interface SourceEvidenceComparison {
  readonly metric: string;
  readonly expected: number;
  readonly actual: number;
  readonly status: "match" | "mismatch";
}

export interface SourceEvidenceReconciliation {
  readonly baselineSupplied: boolean;
  readonly comparisons: readonly SourceEvidenceComparison[];
  readonly passed: boolean;
  readonly informational: {
    readonly legacyOldSlugRecords: {
      readonly expected: number;
      readonly status: "not-probed";
    };
  } | null;
}

export interface CountLabel {
  readonly value: string;
  readonly count: number;
}

export interface MemberCount {
  readonly members: number;
  readonly count: number;
}

export interface RecipeEditorialAlignmentEvidence {
  readonly direct: {
    readonly wprmGroups: number;
    readonly wpurGroups: number;
    readonly invalidGroups: number;
  };
  readonly parent: {
    readonly groupsConsidered: number;
    readonly oneToOne: number;
    readonly oneLanguage: number;
    readonly twoLanguage: number;
    readonly threeLanguage: number;
    readonly missingRecipe: number;
    readonly multipleRecipes: number;
    readonly mixedMissingAndMultiple: number;
    readonly invalidLocale: number;
  };
  readonly wprmParentEligibility: {
    readonly usable: number;
    readonly missingParent: number;
    readonly selfParent: number;
    readonly danglingParent: number;
    readonly nonEditorialParent: number;
    readonly ungroupedParentRecipes: number;
  };
}

export interface ActionCountLabel {
  readonly type: string;
  readonly code: number | string;
  readonly count: number;
}

interface SourceEvidenceReportContracts {
  readonly probe: "wordpress-source-evidence-v2";
  readonly sqlDecompressedSha256: string;
  readonly uploadIndexContractSha256: string;
  readonly reportStructuralSha256: string;
}

interface SourceEvidenceReport {
  readonly schemaVersion: 2;
  readonly kind: "wordpress-source-evidence";
  readonly contracts: SourceEvidenceReportContracts;
  readonly source: {
    readonly database: {
      readonly format: "sql" | "gzip";
      readonly compressedBytes: number;
      readonly decompressedBytes: number;
      readonly sqlRows: number;
      readonly sqlStatements: number;
    };
    readonly uploads: {
      readonly archives: number;
      readonly entries: number;
      readonly uploadFiles: number;
      readonly invalidEntries: number;
    };
  };
  readonly reconciliation: SourceEvidenceReconciliation;
  readonly evidence: {
    readonly posts: {
      readonly postRecords: number;
      readonly pageRecords: number;
    };
    readonly wprm: {
      readonly recipePostRecords: number;
      readonly ingredients: StructuralShapeEvidence;
      readonly instructions: StructuralShapeEvidence;
      readonly parentLinks: {
        readonly missing: number;
        readonly valid: number;
        readonly self: number;
        readonly dangling: number;
      };
      readonly editorialReferences: {
        readonly none: number;
        readonly one: number;
        readonly many: number;
        readonly agreesWithParent: number;
        readonly conflictsWithParent: number;
      };
    };
    readonly wpur: {
      readonly recipePostRecords: number;
      readonly metadataSignalPosts: number;
      readonly structuralSignatureCounts: readonly {
        readonly keys: readonly string[];
        readonly count: number;
      }[];
      readonly ingredients: StructuralShapeEvidence;
      readonly instructions: StructuralShapeEvidence;
    };
    readonly polylang: {
      readonly posts: {
        readonly translationGroups: number;
        readonly emptyGroups: number;
        readonly memberCardinality: readonly MemberCount[];
        readonly localeCardinality: readonly {
          readonly en: number;
          readonly fr: number;
          readonly ru: number;
          readonly count: number;
        }[];
        readonly conflictingLocaleAssignments: number;
      };
      readonly terms: {
        readonly translationGroups: number;
        readonly emptyGroups: number;
        readonly memberCardinality: readonly MemberCount[];
        readonly mixedTaxonomyGroups: number;
      };
      readonly recipeEditorialAlignment: RecipeEditorialAlignmentEvidence;
    };
    readonly media: {
      readonly referencedAttachmentIds: number;
      readonly heroReferences: number;
      readonly stepReferences: number;
      readonly attachmentRecords: number;
      readonly attachedFilePresent: number;
      readonly altPresent: number;
      readonly dimensionMetadata: {
        readonly present: number;
        readonly hasWidth: number;
        readonly hasHeight: number;
        readonly malformed: number;
      };
      readonly archiveCoverage: {
        readonly matched: number;
        readonly missing: number;
        readonly duplicate: number;
        readonly unsafe: number;
      };
    };
    readonly redirects: {
      readonly records: number;
      readonly statusCounts: readonly CountLabel[];
      readonly matcherCounts: readonly CountLabel[];
      readonly actionCounts: readonly ActionCountLabel[];
      readonly sourceSafety: {
        readonly safeExactPath: number;
        readonly unsafeOrUnsupported: number;
      };
      readonly targetEncoding: {
        readonly plain: number;
        readonly "php-serialized": number;
        readonly json: number;
        readonly missing: number;
        readonly malformed: number;
        readonly unsupported: number;
      };
      readonly resolvableLocalTargets: number;
    };
    readonly galleries: {
      readonly galleries: number;
      readonly images: number;
      readonly albums: number;
      readonly shortcodes: number;
      readonly imageRelations: {
        readonly valid: number;
        readonly missingGallery: number;
      };
      readonly albumRelations: {
        readonly toGallery: number;
        readonly toAlbum: number;
        readonly missingTarget: number;
        readonly malformed: number;
      };
      readonly imagePathCoverage: {
        readonly storageForms: Record<BwgStoragePathKind, number>;
        readonly currentGeneric: {
          readonly imageMatched: number;
          readonly imageMissing: number;
          readonly thumbMatched: number;
          readonly thumbMissing: number;
        };
        readonly bwgRootNormalized: {
          readonly imageMatched: number;
          readonly imageMissing: number;
          readonly thumbMatched: number;
          readonly thumbMissing: number;
        };
        readonly thumbValuesPresent: number;
      };
    };
  };
  readonly issues: readonly {
    readonly code: string;
    readonly severity: "error" | "warning";
    readonly count: number;
  }[];
  readonly privacy: {
    readonly rawValuesEmitted: false;
    readonly individualValueHashesEmitted: 0;
    readonly sourcePathsEmitted: false;
    readonly timestampsEmitted: false;
  };
}

export type { SourceEvidenceReport };
