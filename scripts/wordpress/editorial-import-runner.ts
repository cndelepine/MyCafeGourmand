import { uploadIndexContractHash } from "./source-evidence-report";
import {
  EditorialImportError,
  mergeEditorialImportLimits,
  type EditorialImportOptions,
  type EditorialImportResult,
  type EditorialIssueCode,
  type EditorialSafeManifest
} from "./editorial-import-contracts";
import { mapEditorialOutcomes } from "./editorial-import-map";
import {
  editorialFingerprintKey,
  fingerprintEditorialCandidate,
  stageEditorialCandidates
} from "./editorial-import-stage";
import { extractEditorialSource } from "./editorial-import-source";

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

function sortedIssues(values: ReadonlyMap<EditorialIssueCode, number>) {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

function createManifest(
  result: ReturnType<typeof mapEditorialOutcomes>,
  snapshot: Awaited<ReturnType<typeof extractEditorialSource>>
): EditorialSafeManifest {
  const status = {
    ready: 0,
    review: 0,
    "publication-excluded": 0
  };
  const publication = {
    published: 0,
    "publication-excluded": 0,
    unknown: 0
  };
  const locales = {
    en: 0,
    fr: 0,
    ru: 0,
    unlocalized: 0
  };
  const issues = new Map<EditorialIssueCode, number>();
  const attachmentIds = new Set<string>();
  const backedAttachments = new Set<string>();
  const featuredReferences = snapshot.graph.featuredReferenceCount;
  let inlineReferences = 0;
  let unresolvedReferences = 0;
  for (const outcome of result.outcomes) {
    status[outcome.status] += 1;
    publication[outcome.publication] += 1;
    if (outcome.locale === null) {
      locales.unlocalized += 1;
    } else {
      locales[outcome.locale] += 1;
    }
    for (const code of outcome.issueCodes) {
      issues.set(code, (issues.get(code) ?? 0) + 1);
    }
    inlineReferences += outcome.record.structure.inlineMediaReferences
      + outcome.record.structure.markupImageReferences;
    unresolvedReferences += outcome.record.structure.unresolvedMediaReferences;
    for (const media of outcome.record.media) {
      attachmentIds.add(media.sourceId);
      if (media.archiveMatch === "matched") {
        backedAttachments.add(media.sourceId);
      }
    }
    if (outcome.issueCodes.includes("unresolved-attachment-parent")) {
      unresolvedReferences += 1;
    }
  }
  const galleryOutcomes = result.galleries;
  const galleryAssets = galleryOutcomes.flatMap((outcome) => outcome.record.assets);
  const galleryIssueCodes = result.galleryIssueCodes;
  return {
    schemaVersion: 2,
    kind: "wordpress-editorial-staging-manifest",
    source: {
      format: snapshot.sql.format,
      decompressedBytes: snapshot.sql.decompressedBytes,
      sqlDecompressedSha256: snapshot.sql.sqlDecompressedSha256,
      uploadIndexContractSha256: uploadIndexContractHash(snapshot.uploads),
      sqlRows: snapshot.sql.rows,
      sqlStatements: snapshot.sql.statements,
      uploads: {
        archives: snapshot.uploads.summaries.length,
        entries: snapshot.uploads.summaries.reduce(
          (total, archive) => total + archive.entries,
          0
        ),
        uploadFiles: snapshot.uploads.summaries.reduce(
          (total, archive) => total + archive.uploadFiles,
          0
        )
      }
    },
    pages: {
      total: result.outcomes.length,
      status,
      publication,
      locales,
      translation: result.relations.groupSummary,
      media: {
        uniqueAttachments: attachmentIds.size,
        archiveBackedAttachments: backedAttachments.size,
        featuredReferences,
        inlineReferences,
        unresolvedReferences
      },
      issues: sortedIssues(issues),
      outcomes: [...result.outcomes]
        .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))
        .map((outcome) => ({
          fingerprint: outcome.fingerprint,
          locale: outcome.locale,
          publicationDisposition: outcome.record.publicationDisposition,
          status: outcome.status,
          publication: outcome.publication,
          issueCodes: outcome.issueCodes
        }))
    },
    gallery: {
      galleries: snapshot.graph.galleries.size,
      imageRows: snapshot.graph.galleryImages.length,
      assignedImages: snapshot.graph.galleryImages.filter((image) =>
        image.galleryIdState === "present"
        && image.galleryId !== null
        && snapshot.graph.galleries.has(image.galleryId)
      ).length,
      unassignedImages: galleryOutcomes.filter(
        (outcome) => outcome.sourceKind === "unassigned-image"
      ).length,
      candidates: galleryOutcomes.length,
      publishedImages: galleryOutcomes.reduce(
        (total, outcome) => total + outcome.record.publishedImages,
        0
      ),
      assets: galleryAssets.length,
      archiveBackedAssets: galleryAssets.filter(
        (asset) => asset.normalization === "matched"
      ).length,
      status: "review",
      issueCodes: galleryIssueCodes,
      fingerprints: galleryOutcomes
        .map((outcome) => outcome.fingerprint)
        .sort((left, right) => left.localeCompare(right))
    },
    privacy: {
      rawValuesEmitted: false,
      sourceWordingEmitted: false,
      sourcePathsEmitted: false,
      timestampsEmitted: false,
      serializedValuesEmitted: false,
      candidateIdentifiersAreKeyedHmac: true
    }
  };
}

function importError(error: unknown) {
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
  return new EditorialImportError("mapping-failed");
}

export async function runEditorialImport(
  options: EditorialImportOptions
): Promise<EditorialImportResult> {
  if (typeof options.database !== "string" || options.database.length === 0) {
    throw new EditorialImportError("missing-database");
  }
  if (
    typeof options.fingerprintKeyFile !== "string"
    || options.fingerprintKeyFile.length === 0
  ) {
    throw new EditorialImportError("missing-fingerprint-key");
  }
  const write = options.write === true;
  if (write && options.dryRun === true) {
    throw new EditorialImportError("conflicting-mode");
  }
  if (write && !options.stagingDir) {
    throw new EditorialImportError("missing-staging-dir");
  }
  if (options.resume && !write) {
    throw new EditorialImportError("resume-requires-write");
  }
  const limits = mergeEditorialImportLimits(options.limits);
  const key = await editorialFingerprintKey(options.fingerprintKeyFile);
  let snapshot: Awaited<ReturnType<typeof extractEditorialSource>>;
  let mapped: ReturnType<typeof mapEditorialOutcomes>;
  try {
    snapshot = await extractEditorialSource({
      database: options.database,
      uploadsDir: options.uploadsDir,
      uploadArchives: options.uploadArchives,
      limits
    });
    mapped = mapEditorialOutcomes(snapshot, limits, (record) =>
      fingerprintEditorialCandidate(key, record)
    );
  } catch (error) {
    throw importError(error);
  }
  const manifest = createManifest(mapped, snapshot);
  if (write) {
    await stageEditorialCandidates({
      outcomes: mapped.outcomes,
      gallery: mapped.gallery,
      galleries: mapped.galleries,
      manifest,
      stagingDir: options.stagingDir!,
      resume: options.resume
    });
  }
  return {
    manifest,
    outcomes: [...mapped.outcomes].sort((left, right) =>
      numericIdSort(left.sourceId, right.sourceId)
    ),
    gallery: mapped.gallery,
    galleries: mapped.galleries,
    snapshot
  };
}

export function serializeEditorialManifest(manifest: EditorialSafeManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const runWordPressEditorialImport = runEditorialImport;
