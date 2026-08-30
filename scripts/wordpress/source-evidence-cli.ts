import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import {
  assertWritableOutput,
  writeInventoryOutput
} from "../url-inventory/output";
import {
  SourceEvidenceError,
  type SourceEvidenceBaseline,
  type SourceEvidenceLimits,
  type SourceEvidenceReport
} from "./source-evidence-contracts";
import {
  parseSourceEvidenceBaseline
} from "./source-evidence-baseline";
import {
  probeWordPressSourceEvidence,
  serializeSourceEvidenceReport
} from "./source-evidence-runner";
import type { SqlDumpLimits } from "./sql-stream";
import type { UploadArchiveLimits } from "./uploads-inventory";

type ParsedArgument = string | boolean | string[];

  const supportedOptions = new Set([
    "database",
    "uploads",
    "uploads-dir",
    "baseline",
    "dry-run",
    "write",
    "output",
    "overwrite",
    "max-compressed-bytes",
    "max-decompressed-bytes",
    "max-statement-bytes",
    "max-sql-rows",
    "max-archives",
    "max-archive-bytes",
    "max-central-directory-bytes",
    "max-total-entries",
    "max-entries-per-archive",
    "max-entry-name-bytes",
    "max-entry-uncompressed-bytes",
    "max-total-uncompressed-bytes",
    "max-posts",
    "max-postmeta-rows",
    "max-term-relationships",
    "max-recipe-candidates",
    "max-evidence-references",
    "max-post-content-bytes",
    "max-meta-value-bytes",
    "max-serialized-depth",
    "max-serialized-entries",
    "max-shape-keysets"
  ]);

  function parseArguments(values: readonly string[]) {
    const parsed = new Map<string, ParsedArgument>();
    for (let index = 0; index < values.length; index += 1) {
      const argument = values[index];
      if (!argument?.startsWith("--") || argument === "--") {
        throw new SourceEvidenceError("invalid-cli-arguments");
      }
      const key = argument.slice(2);
      if (!supportedOptions.has(key)) {
        throw new SourceEvidenceError("invalid-cli-arguments");
      }
      const next = values[index + 1];
      const takesValue = next !== undefined && !next.startsWith("--");
      if (!takesValue) {
        if (parsed.has(key)) {
          throw new SourceEvidenceError("invalid-cli-arguments");
        }
        parsed.set(key, true);
        continue;
      }
      if (key === "uploads") {
        const existing = parsed.get(key);
        const paths = Array.isArray(existing) ? existing : [];
        parsed.set(key, [...paths, next]);
      } else {
        if (parsed.has(key)) {
          throw new SourceEvidenceError("invalid-cli-arguments");
        }
        parsed.set(key, next);
      }
      index += 1;
    }
    return parsed;
  }

  function requiredArgument(args: ReadonlyMap<string, ParsedArgument>, key: string) {
    const value = args.get(key);
    if (typeof value !== "string" || value.length === 0) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    return value;
  }

  function numericArgument(
    args: ReadonlyMap<string, ParsedArgument>,
    key: string
  ) {
    const value = args.get(key);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || !/^\d+$/u.test(value)) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    return number;
  }

  async function expandUploadInputs(
    explicit: readonly string[],
    directory: string | undefined
  ) {
    const inputs = [...explicit];
    if (directory !== undefined) {
      const entries = await readdir(path.resolve(directory), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
          inputs.push(path.join(path.resolve(directory), entry.name));
        }
      }
    }
    return [...new Set(inputs.map((value) => path.resolve(value)))]
      .sort((left, right) => left.localeCompare(right));
  }

  export async function runWordPressSourceEvidenceProbe(
    argv: readonly string[]
  ): Promise<SourceEvidenceReport> {
    const args = parseArguments(argv);
    const database = requiredArgument(args, "database");
    const uploadsValue = args.get("uploads");
    const explicitUploads = Array.isArray(uploadsValue) ? uploadsValue : [];
    const uploadsDirectory = args.get("uploads-dir");
    if (uploadsDirectory !== undefined && typeof uploadsDirectory !== "string") {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    let uploadArchives: readonly string[];
    try {
      uploadArchives = await expandUploadInputs(
        explicitUploads,
        typeof uploadsDirectory === "string" ? uploadsDirectory : undefined
      );
    } catch {
      throw new SourceEvidenceError("invalid-upload-input");
    }

    const baselineValue = args.get("baseline");
    let baseline: SourceEvidenceBaseline | undefined;
    if (baselineValue !== undefined) {
      if (typeof baselineValue !== "string") {
        throw new SourceEvidenceError("invalid-baseline");
      }
      try {
        const text = await readFile(path.resolve(baselineValue), "utf8");
        baseline = parseSourceEvidenceBaseline(JSON.parse(text));
      } catch (error) {
        if (error instanceof SourceEvidenceError) {
          throw error;
        }
        throw new SourceEvidenceError("invalid-baseline");
      }
    }

    const sql: Partial<SqlDumpLimits> = {};
    const sqlOptions: Array<[string, keyof SqlDumpLimits]> = [
      ["max-compressed-bytes", "maxCompressedBytes"],
      ["max-decompressed-bytes", "maxDecompressedBytes"],
      ["max-statement-bytes", "maxStatementBytes"],
      ["max-sql-rows", "maxRows"]
    ];
    for (const [option, key] of sqlOptions) {
      const value = numericArgument(args, option);
      if (value !== undefined) {
        sql[key] = value;
      }
    }
    const uploads: Partial<UploadArchiveLimits> = {};
    const uploadOptions: Array<[string, keyof UploadArchiveLimits]> = [
      ["max-archives", "maxArchives"],
      ["max-archive-bytes", "maxArchiveBytes"],
      ["max-central-directory-bytes", "maxCentralDirectoryBytes"],
      ["max-total-entries", "maxTotalEntries"],
      ["max-entries-per-archive", "maxEntriesPerArchive"],
      ["max-entry-name-bytes", "maxEntryNameBytes"],
      ["max-entry-uncompressed-bytes", "maxEntryUncompressedBytes"],
      ["max-total-uncompressed-bytes", "maxTotalUncompressedBytes"]
    ];
    for (const [option, key] of uploadOptions) {
      const value = numericArgument(args, option);
      if (value !== undefined) {
        uploads[key] = value;
      }
    }
    const evidence: {
      -readonly [Key in keyof SourceEvidenceLimits]?: SourceEvidenceLimits[Key];
    } = {
      sql,
      uploads
    };
    const evidenceOptions: Array<
      [string, Exclude<keyof SourceEvidenceLimits, "sql" | "uploads">]
    > = [
      ["max-posts", "maxPosts"],
      ["max-postmeta-rows", "maxPostMetaRows"],
      ["max-term-relationships", "maxTermRelationships"],
      ["max-recipe-candidates", "maxRecipeCandidates"],
      ["max-evidence-references", "maxEvidenceReferences"],
      ["max-post-content-bytes", "maxPostContentBytes"],
      ["max-meta-value-bytes", "maxMetaValueBytes"],
      ["max-serialized-depth", "maxSerializedDepth"],
      ["max-serialized-entries", "maxSerializedEntries"],
      ["max-shape-keysets", "maxShapeKeySets"]
    ];
    for (const [option, key] of evidenceOptions) {
      const value = numericArgument(args, option);
      if (value !== undefined) {
        evidence[key] = value;
      }
    }

    const write = args.get("write") === true;
    const dryRun = args.get("dry-run") === true;
    const overwrite = args.get("overwrite") === true;
    const outputValue = args.get("output");
    const output = typeof outputValue === "string" ? path.resolve(outputValue) : undefined;
    if (write && output === undefined) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    if (!write && output !== undefined) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    if (write && dryRun) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    if (overwrite && !write) {
      throw new SourceEvidenceError("invalid-cli-arguments");
    }
    if (output !== undefined) {
      try {
        await assertWritableOutput(output, overwrite);
      } catch {
        throw new SourceEvidenceError("invalid-output");
      }
    }

    const report = await probeWordPressSourceEvidence({
      database,
      uploadArchives,
      baseline,
      limits: evidence
    });
    const serialized = serializeSourceEvidenceReport(report);
    if (output !== undefined) {
      try {
        await writeInventoryOutput(output, serialized, overwrite);
      } catch {
        throw new SourceEvidenceError("invalid-output");
      }
    }
    process.stdout.write(serialized);
    if (
      report.issues.some((issue) => issue.severity === "error")
      || !report.reconciliation.passed
    ) {
      process.exitCode = 1;
    }
    return report;
  }
