#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  WprmPromotionError,
  defaultPromotionRepositoryRoot,
  promoteWprmStaging,
  serializeWprmPromotionResult
} from "./wordpress/wprm-promotion";

type Arguments = ReadonlyMap<string, string | boolean>;

const allowedOptions = new Set([
  "database",
  "uploads-dir",
  "fingerprint-key-file",
  "staging-dir",
  "expected-ready",
  "expected-review",
  "expected-error",
  "dry-run",
  "write"
]);

const rejectedOptions = new Set([
  "apply",
  "copy-media",
  "content-root",
  "public-root",
  "output",
  "overwrite"
]);

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      throw new WprmPromotionError("invalid-argument");
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const key = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (rejectedOptions.has(key)) {
      throw new WprmPromotionError(`rejected-option-${key}`);
    }
    if (!allowedOptions.has(key)) {
      throw new WprmPromotionError(`unsupported-option-${key}`);
    }
    if (parsed.has(key)) {
      throw new WprmPromotionError(`duplicate-option-${key}`);
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

function requiredString(args: Arguments, key: string) {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new WprmPromotionError(`missing-${key}`);
  }
  return value;
}

function optionalString(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new WprmPromotionError(`invalid-${key}`);
  }
  return value;
}

function expectedCount(args: Arguments, key: string) {
  const value = requiredString(args, key);
  if (!/^\d+$/u.test(value)) {
    throw new WprmPromotionError(`invalid-${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WprmPromotionError(`invalid-${key}`);
  }
  return parsed;
}

export async function runWprmPromotionCli(argv: readonly string[]) {
  const args = parseArguments(argv);
  const writeValue = args.get("write");
  const dryRunValue = args.get("dry-run");
  if (
    (writeValue !== undefined && writeValue !== true)
    || (dryRunValue !== undefined && dryRunValue !== true)
  ) {
    throw new WprmPromotionError("invalid-mode");
  }
  const write = writeValue === true;
  const dryRun = dryRunValue === true;
  if (write && dryRun) {
    throw new WprmPromotionError("conflicting-mode");
  }
  const uploadsDir = optionalString(args, "uploads-dir");
  const result = await promoteWprmStaging({
    database: requiredString(args, "database"),
    ...(uploadsDir === undefined ? {} : { uploadsDir }),
    fingerprintKeyFile: requiredString(args, "fingerprint-key-file"),
    stagingDir: requiredString(args, "staging-dir"),
    expected: {
      ready: expectedCount(args, "expected-ready"),
      review: expectedCount(args, "expected-review"),
      error: expectedCount(args, "expected-error")
    },
    repositoryRoot: defaultPromotionRepositoryRoot,
    write
  });
  process.stdout.write(serializeWprmPromotionResult(result));
  return result;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runWprmPromotionCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof WprmPromotionError) {
      console.error(error.code);
    } else {
      console.error("promotion-failed");
    }
    process.exitCode = 1;
  });
}
