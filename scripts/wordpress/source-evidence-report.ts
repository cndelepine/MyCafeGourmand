import { createHash } from "node:crypto";
import {
  SourceEvidenceError,
  sourceEvidenceSchemaVersion,
  type SourceEvidenceBaseline,
  type SourceEvidenceLimits,
  type SourceEvidenceReport
} from "./source-evidence-contracts";
import type { GraphState, PostTableState } from "./source-evidence-scan";
import { sortedIssues } from "./source-evidence-scan";
import type { MetadataState } from "./source-evidence-metadata";
import {
  buildGalleryEvidence,
  buildMediaEvidence,
  buildPolylangEvidence,
  buildRedirectEvidence,
  editorialReferenceEvidence,
  mergeShapeMap,
  parentLinkEvidence,
  wpurCandidateIds,
  wprmPostIds
} from "./source-evidence-analysis";
import { compareSourceEvidenceBaseline } from "./source-evidence-baseline";
import { keySignature } from "./source-evidence-structured";
import type { SqlDumpStats } from "./sql-stream";
import {
  uploadIndexContractHash,
  type UploadArchiveInventory
} from "./uploads-inventory";

export { uploadIndexContractHash } from "./uploads-inventory";

  function uploadSummary(archive: UploadArchiveInventory) {
    return {
      archives: archive.summaries.length,
      entries: archive.summaries.reduce((total, summary) => total + summary.entries, 0),
      uploadFiles: archive.summaries.reduce((total, summary) => total + summary.uploadFiles, 0),
      invalidEntries: archive.summaries.reduce(
        (total, summary) => total + summary.invalidEntries,
        0
      )
    };
  }

  function postRecordCount(postTable: PostTableState) {
    return [...postTable.records.values()]
      .filter((record) => record.kind === "post")
      .length;
  }

  function reportWithoutStructuralHash(report: SourceEvidenceReport) {
    return {
      ...report,
      contracts: {
        ...report.contracts,
        reportStructuralSha256: ""
      }
    };
  }

  function withStructuralHash(report: SourceEvidenceReport): SourceEvidenceReport {
    const reportStructuralSha256 = createHash("sha256")
      .update(JSON.stringify(reportWithoutStructuralHash(report)), "utf8")
      .digest("hex");
    return {
      ...report,
      contracts: {
        ...report.contracts,
        reportStructuralSha256
      }
    };
  }

  export function buildReport(
    sqlStats: SqlDumpStats,
    archive: UploadArchiveInventory,
    graph: GraphState,
    metadata: MetadataState,
    postTable: PostTableState,
    postMetaTable: string | undefined,
    limits: SourceEvidenceLimits,
    baseline: SourceEvidenceBaseline | undefined
  ) {
    if (postMetaTable === undefined) {
      graph.issues.add("missing-postmeta-table");
    }
    const wprmIds = wprmPostIds(postTable);
    const wpurIds = wpurCandidateIds(postTable, metadata);
    if (wprmIds.size + wpurIds.size > limits.maxRecipeCandidates) {
      throw new SourceEvidenceError("recipe-candidate-limit");
    }
    const wprmEvidence = {
      recipePostRecords: wprmIds.size,
      ingredients: mergeShapeMap(metadata.wprmIngredients, wprmIds),
      instructions: mergeShapeMap(metadata.wprmInstructions, wprmIds),
      parentLinks: parentLinkEvidence(postTable, wprmIds, metadata.wprmParents),
      editorialReferences: editorialReferenceEvidence(
        postTable,
        wprmIds,
        metadata.wprmParents
      )
    };
    const signatureCounts = new Map<string, number>();
    for (const [postId, keys] of metadata.wpurKeys) {
      if (postTable.records.get(postId)?.kind !== "recipe") {
        continue;
      }
      const structuralKeys = [...keys].sort((left, right) => left.localeCompare(right));
      if (structuralKeys.length === 0) {
        continue;
      }
      const signature = JSON.stringify(structuralKeys);
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    }
    const wpurEvidence = {
      recipePostRecords: wpurIds.size,
      metadataSignalPosts: metadata.wpurSignalPosts.size,
      structuralSignatureCounts: [...signatureCounts.entries()]
        .map(([keys, count]) => ({
          keys: keySignature(keys),
          count
        }))
        .sort((left, right) =>
          JSON.stringify(left.keys).localeCompare(JSON.stringify(right.keys))
        ),
      ingredients: mergeShapeMap(metadata.wpurIngredients, wpurIds),
      instructions: mergeShapeMap(metadata.wpurInstructions, wpurIds)
    };
    const polylangEvidence = buildPolylangEvidence(
      graph,
      postTable,
      wprmIds,
      wpurIds,
      metadata.wprmParents
    );
    const mediaEvidence = buildMediaEvidence(postTable, metadata, archive);
    const redirectEvidence = buildRedirectEvidence(graph.redirects);
    const galleryEvidence = buildGalleryEvidence(graph.galleries, archive);
    const upload = uploadSummary(archive);
    if (redirectEvidence.targetEncoding.malformed > 0) {
      graph.issues.add(
        "redirect-target-malformed",
        redirectEvidence.targetEncoding.malformed
      );
    }
    if (redirectEvidence.targetEncoding.unsupported > 0) {
      graph.issues.add(
        "redirect-target-unsupported",
        redirectEvidence.targetEncoding.unsupported
      );
    }
    if (galleryEvidence.albumRelations.malformed > 0) {
      graph.issues.add(
        "malformed-bwg-album-gallery-relation",
        galleryEvidence.albumRelations.malformed
      );
    }
    if (galleryEvidence.imagePathCoverage.storageForms.unsafe > 0) {
      graph.issues.add(
        "unsafe-bwg-image-path",
        galleryEvidence.imagePathCoverage.storageForms.unsafe
      );
    }
    for (const [code, value] of metadata.issues.values) {
      graph.issues.add(code, value.count, value.severity);
    }
    if (upload.invalidEntries > 0) {
      graph.issues.add("invalid-upload-entry", upload.invalidEntries);
    }
    const base: SourceEvidenceReport = {
      schemaVersion: sourceEvidenceSchemaVersion,
      kind: "wordpress-source-evidence",
      contracts: {
        probe: "wordpress-source-evidence-v3",
        sqlDecompressedSha256: sqlStats.sqlDecompressedSha256,
        uploadIndexContractSha256: uploadIndexContractHash(archive),
        reportStructuralSha256: ""
      },
      source: {
        database: {
          format: sqlStats.format,
          compressedBytes: sqlStats.compressedBytes,
          decompressedBytes: sqlStats.decompressedBytes,
          sqlRows: sqlStats.rows,
          sqlStatements: sqlStats.statements
        },
        uploads: upload
      },
      reconciliation: {
        baselineSupplied: false,
        comparisons: [],
        passed: true,
        informational: null
      },
      evidence: {
        posts: {
          postRecords: postRecordCount(postTable),
          pageRecords: postTable.pages
        },
        wprm: wprmEvidence,
        wpur: wpurEvidence,
        polylang: polylangEvidence,
        media: mediaEvidence,
        redirects: redirectEvidence,
        galleries: galleryEvidence
      },
      issues: sortedIssues(graph.issues),
      privacy: {
        rawValuesEmitted: false,
        individualValueHashesEmitted: 0,
        sourcePathsEmitted: false,
        timestampsEmitted: false
      }
    };
    const reconciled = baseline
      ? { ...base, reconciliation: compareSourceEvidenceBaseline(base, baseline) }
      : base;
    return withStructuralHash(reconciled);
  }
