#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  EditorialImportError,
  type EditorialImportLimitsInput
} from "./wordpress/editorial-import-contracts";
import {
  runEditorialImport,
  serializeEditorialManifest
} from "./wordpress/editorial-import-runner";

type Arguments = ReadonlyMap<string, string | boolean>;

const rejectedOptions = new Set([
  "apply",
  "content-root",
  "copy-media",
  "destination",
  "media-base-path",
  "output",
  "public-root",
  "publish",
  "route-root"
]);

const allowedOptions = new Set([
  "database",
  "uploads-dir",
  "fingerprint-key-file",
  "dry-run",
  "write",
  "staging-dir",
  "resume",
  "max-posts",
  "max-post-meta-rows",
  "max-term-relationships",
  "max-evidence-references",
  "max-post-content-bytes",
  "max-meta-value-bytes",
  "max-serialized-depth",
  "max-serialized-entries",
  "max-shape-key-sets",
  "max-compressed-bytes",
  "max-decompressed-bytes",
  "max-statement-bytes",
  "max-rows",
  "max-archives",
  "max-archive-bytes",
  "max-central-directory-bytes",
  "max-total-entries",
  "max-entries-per-archive",
  "max-entry-name-bytes",
  "max-entry-uncompressed-bytes",
  "max-total-uncompressed-bytes",
  "max-page-candidates",
  "max-inline-media-references",
  "max-bwg-image-records",
  "max-shortcodes-per-page",
  "max-blocks-per-page"
]);

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      throw new EditorialImportError("invalid-argument");
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const key = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (rejectedOptions.has(key)) {
      throw new EditorialImportError(`rejected-option-${key}`);
    }
    if (!allowedOptions.has(key)) {
      throw new EditorialImportError(`unsupported-option-${key}`);
    }
    if (parsed.has(key)) {
      throw new EditorialImportError(`duplicate-option-${key}`);
    }
    if (equals !== -1) {
      parsed.set(key, withoutPrefix.slice(equals + 1));
      continue;
    }
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.set(key, next);
      index += 1;
    } else {
      parsed.set(key, true);
    }
  }
  return parsed;
}

function stringOption(args: Arguments, key: string, required = false) {
  const value = args.get(key);
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (required) {
    throw new EditorialImportError(`missing-${key}`);
  }
  if (value !== undefined) {
    throw new EditorialImportError(`invalid-${key}`);
  }
  return undefined;
}

function booleanOption(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new EditorialImportError(`invalid-${key}`);
  }
  return true;
}

function numericOption(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new EditorialImportError(`invalid-${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new EditorialImportError(`invalid-${key}`);
  }
  return parsed;
}

function limitsFromArguments(args: Arguments): EditorialImportLimitsInput | undefined {
  const evidence: Record<string, number> = {};
  const sql: Record<string, number> = {};
  const uploads: Record<string, number> = {};
  const result: Record<string, number> = {};
  const read = (target: Record<string, number>, name: string, key: string) => {
    const value = numericOption(args, name);
    if (value !== undefined) {
      target[key] = value;
    }
  };
  for (const [name, key] of [
    ["max-posts", "maxPosts"],
    ["max-post-meta-rows", "maxPostMetaRows"],
    ["max-term-relationships", "maxTermRelationships"],
    ["max-evidence-references", "maxEvidenceReferences"],
    ["max-post-content-bytes", "maxPostContentBytes"],
    ["max-meta-value-bytes", "maxMetaValueBytes"],
    ["max-serialized-depth", "maxSerializedDepth"],
    ["max-serialized-entries", "maxSerializedEntries"],
    ["max-shape-key-sets", "maxShapeKeySets"]
  ] as const) {
    read(evidence, name, key);
  }
  for (const [name, key] of [
    ["max-compressed-bytes", "maxCompressedBytes"],
    ["max-decompressed-bytes", "maxDecompressedBytes"],
    ["max-statement-bytes", "maxStatementBytes"],
    ["max-rows", "maxRows"]
  ] as const) {
    read(sql, name, key);
  }
  for (const [name, key] of [
    ["max-archives", "maxArchives"],
    ["max-archive-bytes", "maxArchiveBytes"],
    ["max-central-directory-bytes", "maxCentralDirectoryBytes"],
    ["max-total-entries", "maxTotalEntries"],
    ["max-entries-per-archive", "maxEntriesPerArchive"],
    ["max-entry-name-bytes", "maxEntryNameBytes"],
    ["max-entry-uncompressed-bytes", "maxEntryUncompressedBytes"],
    ["max-total-uncompressed-bytes", "maxTotalUncompressedBytes"]
  ] as const) {
    read(uploads, name, key);
  }
  for (const [name, key] of [
    ["max-page-candidates", "maxPageCandidates"],
    ["max-inline-media-references", "maxInlineMediaReferences"],
    ["max-bwg-image-records", "maxBwgImageRecords"],
    ["max-shortcodes-per-page", "maxShortcodesPerPage"],
    ["max-blocks-per-page", "maxBlocksPerPage"]
  ] as const) {
    read(result, name, key);
  }
  if (
    Object.keys(evidence).length === 0
    && Object.keys(sql).length === 0
    && Object.keys(uploads).length === 0
    && Object.keys(result).length === 0
  ) {
    return undefined;
  }
  return {
    ...result,
    evidence: {
      ...evidence,
      sql,
      uploads
    }
  };
}

export async function runEditorialImportCli(argv: readonly string[]) {
  const args = parseArguments(argv);
  const database = stringOption(args, "database", true)!;
  const uploadsDir = stringOption(args, "uploads-dir", true)!;
  const fingerprintKeyFile = stringOption(args, "fingerprint-key-file", true)!;
  const dryRun = booleanOption(args, "dry-run");
  const write = booleanOption(args, "write");
  const resume = booleanOption(args, "resume");
  if (dryRun && write) {
    throw new EditorialImportError("conflicting-mode");
  }
  if (resume && !write) {
    throw new EditorialImportError("resume-requires-write");
  }
  const stagingDir = stringOption(args, "staging-dir");
  if (write && stagingDir === undefined) {
    throw new EditorialImportError("missing-staging-dir");
  }
  const result = await runEditorialImport({
    database,
    uploadsDir,
    fingerprintKeyFile,
    dryRun: dryRun || !write,
    write,
    stagingDir,
    resume,
    limits: limitsFromArguments(args)
  });
  process.stdout.write(serializeEditorialManifest(result.manifest));
  return result;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runEditorialImportCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof EditorialImportError) {
      console.error(error.code);
    } else {
      console.error("import-failed");
    }
    process.exitCode = 1;
  });
}
