import path from "node:path";
import {
  defaultSqlDumpLimits,
  scanSqlDump
} from "./sql-stream";
import {
  defaultUploadArchiveLimits,
  inventoryUploadArchives,
  type UploadArchiveInventory
} from "./uploads-inventory";
import {
  defaultSourceEvidenceLimits,
  SourceEvidenceError,
  type SourceEvidenceLimits,
  type SourceEvidenceOptions,
  type SourceEvidenceReport
} from "./source-evidence-contracts";
import {
  createGraphState,
  graphHandlers,
  selectCoreTable,
  selectPostMetaTable,
  type GraphState,
  type PostTableState
} from "./source-evidence-scan";
import {
  createMetadataState,
  metadataHandlers
} from "./source-evidence-metadata";
import { buildReport } from "./source-evidence-report";

function positiveSafeInteger(value: number, code: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SourceEvidenceError(code);
  }
  return value;
}

function mergeLimits(input: Partial<SourceEvidenceLimits> | undefined) {
  const result: SourceEvidenceLimits = {
    sql: { ...defaultSqlDumpLimits, ...(input?.sql ?? {}) },
    uploads: { ...defaultUploadArchiveLimits, ...(input?.uploads ?? {}) },
    maxPosts: input?.maxPosts ?? defaultSourceEvidenceLimits.maxPosts,
    maxPostMetaRows: input?.maxPostMetaRows ?? defaultSourceEvidenceLimits.maxPostMetaRows,
    maxTermRelationships:
      input?.maxTermRelationships ?? defaultSourceEvidenceLimits.maxTermRelationships,
    maxRecipeCandidates:
      input?.maxRecipeCandidates ?? defaultSourceEvidenceLimits.maxRecipeCandidates,
    maxEvidenceReferences:
      input?.maxEvidenceReferences ?? defaultSourceEvidenceLimits.maxEvidenceReferences,
    maxPostContentBytes:
      input?.maxPostContentBytes ?? defaultSourceEvidenceLimits.maxPostContentBytes,
    maxMetaValueBytes:
      input?.maxMetaValueBytes ?? defaultSourceEvidenceLimits.maxMetaValueBytes,
    maxSerializedDepth:
      input?.maxSerializedDepth ?? defaultSourceEvidenceLimits.maxSerializedDepth,
    maxSerializedEntries:
      input?.maxSerializedEntries ?? defaultSourceEvidenceLimits.maxSerializedEntries,
    maxShapeKeySets:
      input?.maxShapeKeySets ?? defaultSourceEvidenceLimits.maxShapeKeySets
  };
  for (const [key, value] of [
    ["maxPosts", result.maxPosts],
    ["maxPostMetaRows", result.maxPostMetaRows],
    ["maxTermRelationships", result.maxTermRelationships],
    ["maxRecipeCandidates", result.maxRecipeCandidates],
    ["maxEvidenceReferences", result.maxEvidenceReferences],
    ["maxPostContentBytes", result.maxPostContentBytes],
    ["maxMetaValueBytes", result.maxMetaValueBytes],
    ["maxSerializedDepth", result.maxSerializedDepth],
    ["maxSerializedEntries", result.maxSerializedEntries],
    ["maxShapeKeySets", result.maxShapeKeySets]
  ] as const) {
    positiveSafeInteger(value, `invalid-${key}`);
  }
  for (const value of Object.values(result.sql)) {
    positiveSafeInteger(value, "invalid-sql-limit");
  }
  for (const value of Object.values(result.uploads)) {
    positiveSafeInteger(value, "invalid-upload-limit");
  }
  return result;
}


  function errorCode(error: unknown, fallback: string) {
    if (
      error
      && typeof error === "object"
      && "code" in error
      && typeof error.code === "string"
    ) {
      return error.code;
    }
    return fallback;
  }

  function asProbeError(error: unknown, fallback: string): SourceEvidenceError {
    if (error instanceof SourceEvidenceError) {
      return error;
    }
    return new SourceEvidenceError(errorCode(error, fallback));
  }

  async function scanGraph(
    database: string,
    state: GraphState,
    limits: SourceEvidenceLimits
  ) {
    try {
      return await scanSqlDump(
        path.resolve(database),
        graphHandlers(state, limits),
        limits.sql
      );
    } catch (error) {
      throw asProbeError(error, "sql-probe-failed");
    }
  }

  async function scanMetadata(
    database: string,
    graph: GraphState,
    postTable: PostTableState,
    postMetaTable: string | undefined,
    limits: SourceEvidenceLimits
  ) {
    const state = createMetadataState(limits);
    try {
      const stats = await scanSqlDump(
        path.resolve(database),
        metadataHandlers(state, graph, postTable, postMetaTable, limits),
        limits.sql
      );
      return { state, stats };
    } catch (error) {
      throw asProbeError(error, "sql-probe-failed");
    }
  }

  export async function probeWordPressSourceEvidence(
    options: SourceEvidenceOptions
  ): Promise<SourceEvidenceReport> {
    if (!options.database || typeof options.database !== "string") {
      throw new SourceEvidenceError("missing-database");
    }
    const limits = mergeLimits(options.limits);
    const graph = createGraphState(limits);
    const graphStats = await scanGraph(options.database, graph, limits);
    const postTable = selectCoreTable(graph.postTables, "posts");
    const postMetaTable = selectPostMetaTable(graph);
    let archive: UploadArchiveInventory;
    try {
      archive = await inventoryUploadArchives(options.uploadArchives ?? [], limits.uploads);
    } catch (error) {
      throw asProbeError(error, "upload-probe-failed");
    }
    const metadataResult = await scanMetadata(
      options.database,
      graph,
      postTable,
      postMetaTable,
      limits
    );
    if (
      graphStats.decompressedBytes !== metadataResult.stats.decompressedBytes
      || graphStats.sqlDecompressedSha256 !== metadataResult.stats.sqlDecompressedSha256
    ) {
      throw new SourceEvidenceError("source-changed-during-probe");
    }
    return buildReport(
      graphStats,
      archive,
      graph,
      metadataResult.state,
      postTable,
      postMetaTable,
      limits,
      options.baseline
    );
  }

  export function serializeSourceEvidenceReport(report: SourceEvidenceReport) {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
