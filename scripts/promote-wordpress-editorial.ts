#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  EditorialPromotionRunnerError,
  defaultEditorialPromotionRepositoryRoot,
  promoteEditorialStaging,
  serializeEditorialPromotionResult
} from "./wordpress/editorial-promotion-runner";

type Arguments = ReadonlyMap<string, string | boolean>;

const allowedOptions = new Set([
  "database",
  "dry-run",
  "expected-gallery-candidates",
  "expected-galleries",
  "expected-publication-excluded",
  "expected-ready",
  "expected-review",
  "expected-selected",
  "fingerprint-key-file",
  "staging-dir",
  "uploads-dir",
  "write"
]);
const rejectedOptions = new Set([
  "apply",
  "content-root",
  "copy-media",
  "destination",
  "media-base-path",
  "output",
  "overwrite",
  "public-root",
  "publish",
  "resume",
  "route-root"
]);

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      throw new EditorialPromotionRunnerError("invalid-argument");
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const key = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (rejectedOptions.has(key)) {
      throw new EditorialPromotionRunnerError(`rejected-option-${key}`);
    }
    if (!allowedOptions.has(key)) {
      throw new EditorialPromotionRunnerError(`unsupported-option-${key}`);
    }
    if (parsed.has(key)) {
      throw new EditorialPromotionRunnerError(`duplicate-option-${key}`);
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
    throw new EditorialPromotionRunnerError(`missing-${key}`);
  }
  return value;
}

function expectedCount(args: Arguments, key: string) {
  const value = requiredString(args, key);
  if (!/^\d+$/u.test(value)) {
    throw new EditorialPromotionRunnerError(`invalid-${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EditorialPromotionRunnerError(`invalid-${key}`);
  }
  return parsed;
}

function mode(args: Arguments) {
  const dryRun = args.get("dry-run");
  const write = args.get("write");
  if (
    (dryRun !== undefined && dryRun !== true)
    || (write !== undefined && write !== true)
  ) {
    throw new EditorialPromotionRunnerError("invalid-mode");
  }
  if (dryRun === true && write === true) {
    throw new EditorialPromotionRunnerError("conflicting-mode");
  }
  if (dryRun !== true && write !== true) {
    throw new EditorialPromotionRunnerError("missing-mode");
  }
  return write === true;
}

export async function runEditorialPromotionCli(argv: readonly string[]) {
  const args = parseArguments(argv);
  const write = mode(args);
  const result = await promoteEditorialStaging({
    database: requiredString(args, "database"),
    uploadsDir: requiredString(args, "uploads-dir"),
    fingerprintKeyFile: requiredString(args, "fingerprint-key-file"),
    stagingDir: requiredString(args, "staging-dir"),
    expected: {
      galleryCandidates: expectedCount(args, "expected-gallery-candidates"),
      galleries: expectedCount(args, "expected-galleries"),
      publicationExcluded: expectedCount(args, "expected-publication-excluded"),
      ready: expectedCount(args, "expected-ready"),
      review: expectedCount(args, "expected-review"),
      selected: expectedCount(args, "expected-selected")
    },
    repositoryRoot: defaultEditorialPromotionRepositoryRoot,
    write
  });
  process.stdout.write(serializeEditorialPromotionResult(result));
  return result;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runEditorialPromotionCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof EditorialPromotionRunnerError) {
      console.error(error.code);
    } else {
      console.error("promotion-failed");
    }
    process.exitCode = 1;
  });
}
