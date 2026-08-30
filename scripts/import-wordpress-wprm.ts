#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  WprmImportError,
  type WprmImportLimitsInput
} from "./wordpress/wprm-import-contracts";
import {
  runWprmBulkImport,
  serializeWprmManifest
} from "./wordpress/wprm-import-runner";

type Arguments = ReadonlyMap<string, string | boolean>;

const rejectedOptions = new Set([
  "apply",
  "copy-media",
  "content-root",
  "public-root",
  "recipe-id",
  "slug",
  "locale",
  "output",
  "media-base-path"
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
  "max-recipe-candidates",
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
  "max-redirect-records",
  "max-old-slug-records",
  "max-option-records",
  "max-redirect-depth",
  "max-taxonomies-per-candidate",
  "max-media-per-candidate"
]);

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      throw new WprmImportError("invalid-argument");
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const key = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (rejectedOptions.has(key)) {
      throw new WprmImportError(`rejected-option-${key}`);
    }
    if (!allowedOptions.has(key)) {
      throw new WprmImportError(`unsupported-option-${key}`);
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
    throw new WprmImportError(`missing-${key}`);
  }
  return undefined;
}

function numericOption(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new WprmImportError(`invalid-${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WprmImportError(`invalid-${key}`);
  }
  return parsed;
}

function limitsFromArguments(args: Arguments): WprmImportLimitsInput | undefined {
  const evidence: Record<string, number> = {};
  const sql: Record<string, number> = {};
  const uploads: Record<string, number> = {};
  const read = (
    target: Record<string, number>,
    name: string,
    key: string
  ) => {
    const value = numericOption(args, name);
    if (value !== undefined) {
      target[key] = value;
    }
  };
  for (const [name, key] of [
    ["max-posts", "maxPosts"],
    ["max-post-meta-rows", "maxPostMetaRows"],
    ["max-term-relationships", "maxTermRelationships"],
    ["max-recipe-candidates", "maxRecipeCandidates"],
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
  const maxRedirectRecords = numericOption(args, "max-redirect-records");
  const maxOldSlugRecords = numericOption(args, "max-old-slug-records");
  const maxOptionRecords = numericOption(args, "max-option-records");
  const maxRedirectDepth = numericOption(args, "max-redirect-depth");
  const maxTaxonomiesPerCandidate = numericOption(args, "max-taxonomies-per-candidate");
  const maxMediaPerCandidate = numericOption(args, "max-media-per-candidate");
  if (
    Object.keys(evidence).length === 0
    && Object.keys(sql).length === 0
    && Object.keys(uploads).length === 0
    && maxRedirectRecords === undefined
    && maxOldSlugRecords === undefined
    && maxOptionRecords === undefined
    && maxRedirectDepth === undefined
    && maxTaxonomiesPerCandidate === undefined
    && maxMediaPerCandidate === undefined
  ) {
    return undefined;
  }
  return {
    evidence: {
      ...evidence,
      sql,
      uploads
    },
    ...(maxRedirectRecords === undefined ? {} : { maxRedirectRecords }),
    ...(maxOldSlugRecords === undefined ? {} : { maxOldSlugRecords }),
    ...(maxOptionRecords === undefined ? {} : { maxOptionRecords }),
    ...(maxRedirectDepth === undefined ? {} : { maxRedirectDepth }),
    ...(maxTaxonomiesPerCandidate === undefined ? {} : { maxTaxonomiesPerCandidate }),
    ...(maxMediaPerCandidate === undefined ? {} : { maxMediaPerCandidate })
  };
}

export async function runWprmImportCli(argv: readonly string[]) {
  const args = parseArguments(argv);
  const database = stringOption(args, "database", true)!;
  const uploadsDir = stringOption(args, "uploads-dir", true)!;
  const fingerprintKeyFile = stringOption(args, "fingerprint-key-file", true)!;
  const dryRun = args.get("dry-run") === true;
  const write = args.get("write") === true;
  if (dryRun && write) {
    throw new WprmImportError("conflicting-mode");
  }
  if (args.get("resume") === true && !write) {
    throw new WprmImportError("resume-requires-write");
  }
  const stagingDir = stringOption(args, "staging-dir");
  if (write && stagingDir === undefined) {
    throw new WprmImportError("missing-staging-dir");
  }
  const result = await runWprmBulkImport({
    database,
    uploadsDir,
    fingerprintKeyFile,
    dryRun: dryRun || !write,
    write,
    stagingDir,
    resume: args.get("resume") === true,
    limits: limitsFromArguments(args)
  });
  process.stdout.write(serializeWprmManifest(result.manifest));
  return result;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runWprmImportCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof WprmImportError) {
      console.error(error.code);
    } else {
      console.error("import-failed");
    }
    process.exitCode = 1;
  });
}
