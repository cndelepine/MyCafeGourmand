import {
  canonicalCandidateJson,
  fingerprintCandidate,
  readFingerprintKey,
  stagePrivateStagingFiles
} from "./wprm-import-stage";
import {
  editorialImportContractVersion,
  EditorialImportError,
  type EditorialCandidateOutcome,
  type EditorialGalleryOutcome,
  type EditorialSafeManifest
} from "./editorial-import-contracts";

interface EditorialStagingMarker {
  readonly schemaVersion: 2;
  readonly kind: "wordpress-editorial-staging";
  readonly sqlDecompressedSha256: string;
  readonly uploadIndexContractSha256: string;
  readonly importerContractVersion: typeof editorialImportContractVersion;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function markerMatches(
  value: unknown,
  expected: EditorialStagingMarker
): value is EditorialStagingMarker {
  return exactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "uploadIndexContractSha256",
    "importerContractVersion"
  ])
    && value.schemaVersion === 2
    && value.kind === "wordpress-editorial-staging"
    && value.sqlDecompressedSha256 === expected.sqlDecompressedSha256
    && value.uploadIndexContractSha256 === expected.uploadIndexContractSha256
    && value.importerContractVersion === expected.importerContractVersion;
}

function privateJson(value: unknown) {
  return `${JSON.stringify(JSON.parse(canonicalCandidateJson(value)), null, 2)}\n`;
}

function existingCandidateMatches(content: Buffer, expected: unknown) {
  try {
    return canonicalCandidateJson(JSON.parse(content.toString("utf8")))
      === canonicalCandidateJson(expected);
  } catch {
    return false;
  }
}

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

function stagingError(error: unknown): EditorialImportError {
  if (error instanceof EditorialImportError) {
    return error;
  }
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return new EditorialImportError(error.code);
  }
  return new EditorialImportError("staging-write-failed");
}

export async function editorialFingerprintKey(keyFile: string) {
  try {
    return await readFingerprintKey(keyFile);
  } catch (error) {
    throw stagingError(error);
  }
}

export function fingerprintEditorialCandidate(key: Uint8Array, candidate: unknown) {
  return fingerprintCandidate(key, canonicalCandidateJson(candidate));
}

export async function stageEditorialCandidates(input: {
  readonly outcomes: readonly EditorialCandidateOutcome[];
  readonly gallery: EditorialGalleryOutcome | null;
  readonly galleries?: readonly EditorialGalleryOutcome[];
  readonly manifest: EditorialSafeManifest;
  readonly stagingDir: string;
  readonly resume?: boolean;
}) {
  const marker: EditorialStagingMarker = {
    schemaVersion: 2,
    kind: "wordpress-editorial-staging",
    sqlDecompressedSha256: input.manifest.source.sqlDecompressedSha256,
    uploadIndexContractSha256: input.manifest.source.uploadIndexContractSha256,
    importerContractVersion: editorialImportContractVersion
  };
  const files = [
    ...[...input.outcomes]
      .sort((left, right) => numericIdSort(left.sourceId, right.sourceId))
      .map((outcome) => ({
        relativePath: `candidates/page-${outcome.sourceId}.json`,
        content: privateJson(outcome.record),
        matchesExisting: (existing: Buffer) =>
          existingCandidateMatches(existing, outcome.record)
      })),
    ...[...(input.galleries ?? (input.gallery === null ? [] : [input.gallery]))]
      .sort((left, right) =>
        numericIdSort(left.sourceId, right.sourceId)
        || left.sourceKind.localeCompare(right.sourceKind)
      )
      .map((gallery) => ({
        relativePath: gallery.sourceKind === "gallery"
          ? `candidates/gallery-${gallery.sourceId}.json`
          : `candidates/unassigned-image-${gallery.sourceId}.json`,
        content: privateJson(gallery.record),
        matchesExisting: (existing: Buffer) =>
          existingCandidateMatches(existing, gallery.record)
      })),
    {
      relativePath: "manifest.json",
      content: `${JSON.stringify(input.manifest, null, 2)}\n`
    }
  ];
  try {
    await stagePrivateStagingFiles({
      stagingDir: input.stagingDir,
      resume: input.resume,
      markerFileName: ".editorial-staging.json",
      markerContent: `${JSON.stringify(marker)}\n`,
      markerMatches: (value) => markerMatches(value, marker),
      files
    });
  } catch (error) {
    throw stagingError(error);
  }
}
