import path from "node:path";
import { inventorySitemaps } from "./traverse";
import {
  assertWritableOutput,
  writeInventoryOutput
} from "./output";
import type {
  InventoryLimits,
  UrlInventoryOutput
} from "./types";

type CliArguments = Record<string, string | boolean>;

const supportedCliOptions = new Set([
  "dry-run",
  "max-depth",
  "max-document-bytes",
  "max-documents",
  "request-timeout-ms",
  "max-urls",
  "no-compare",
  "output",
  "overwrite",
  "recipes-root",
  "sitemap",
  "write"
]);

function parseArguments(values: string[]): CliArguments {
  const parsed: CliArguments = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument ?? "<missing>"}`);
    }
    const key = argument.slice(2);
    if (!key) {
      throw new Error("Empty command-line option.");
    }
    if (!supportedCliOptions.has(key)) {
      throw new Error(`Unknown command-line option: --${key}`);
    }
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (parsed[key] !== undefined) {
        throw new Error(`Duplicate command-line option: --${key}`);
      }
      parsed[key] = next;
      index += 1;
    } else {
      if (parsed[key] !== undefined) {
        throw new Error(`Duplicate command-line option: --${key}`);
      }
      parsed[key] = true;
    }
  }
  return parsed;
}

function requiredOption(args: CliArguments, key: string) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option: --${key}`);
  }
  return value;
}

function numericOption(args: CliArguments, key: string) {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  const description = key === "max-depth" ? "non-negative" : "positive";
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`--${key} must be a ${description} integer.`);
  }
  const parsed = Number(value);
  const minimum = key === "max-depth" ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `--${key} must be an integer greater than or equal to ${minimum}.`
    );
  }
  return parsed;
}

export async function runUrlInventory(
  argv: string[]
): Promise<UrlInventoryOutput> {
  const args = parseArguments(argv);
  const sitemap = requiredOption(args, "sitemap");
  const write = args.write === true;
  const dryRun = args["dry-run"] === true;
  const overwrite = args.overwrite === true;
  const outputOption = args.output;
  const outputPath = typeof outputOption === "string" ? path.resolve(outputOption) : undefined;

  if (write && !outputPath) {
    throw new Error("--write requires an explicit --output path.");
  }
  if (!write && outputPath) {
    throw new Error("--output is only valid together with --write.");
  }
  if (write && dryRun) {
    throw new Error("--dry-run and --write cannot be used together.");
  }
  if (overwrite && !write) {
    throw new Error("--overwrite is only valid together with --write.");
  }
  if (outputPath) {
    await assertWritableOutput(outputPath, overwrite);
  }

  const limits: Partial<InventoryLimits> = {};
  const maxDepth = numericOption(args, "max-depth");
  const maxDocuments = numericOption(args, "max-documents");
  const requestTimeoutMs = numericOption(args, "request-timeout-ms");
  const maxUrls = numericOption(args, "max-urls");
  const maxDocumentBytes = numericOption(args, "max-document-bytes");
  const recipesRoot = args["recipes-root"];
  if (recipesRoot !== undefined && typeof recipesRoot !== "string") {
    throw new Error("--recipes-root requires a path.");
  }
  if (maxDepth !== undefined) {
    limits.maxDepth = maxDepth;
  }
  if (maxDocuments !== undefined) {
    limits.maxDocuments = maxDocuments;
  }
  if (requestTimeoutMs !== undefined) {
    limits.requestTimeoutMs = requestTimeoutMs;
  }
  if (maxUrls !== undefined) {
    limits.maxUrls = maxUrls;
  }
  if (maxDocumentBytes !== undefined) {
    limits.maxDocumentBytes = maxDocumentBytes;
  }

  const output = await inventorySitemaps({
    sitemap,
    limits,
    compare: args["no-compare"] !== true,
    ...(typeof recipesRoot === "string" ? { recipesRoot } : {})
  });
  const serialized = `${JSON.stringify(output, null, 2)}\n`;

  if (outputPath) {
    await writeInventoryOutput(outputPath, serialized, overwrite);
    console.log(`Created ${outputPath}`);
    if (output.errors.length > 0) {
      console.error(`Inventory completed with ${output.errors.length} reported issue(s).`);
    }
  } else {
    process.stdout.write(serialized);
    console.error("Dry run only; add --write --output migration-output/urls.json to write a file.");
  }

  return output;
}
