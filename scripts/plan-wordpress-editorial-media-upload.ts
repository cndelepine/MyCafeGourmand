#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  EditorialMediaUploadPlanError,
  createEditorialMediaUploadPlan,
  serializeEditorialMediaUploadPlanResult
} from "./wordpress/editorial-media-upload-plan";
import { defaultEditorialPromotionRepositoryRoot } from "./wordpress/editorial-promotion-runner";

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
  "resume",
  "staging-dir",
  "upload-dir",
  "uploads-dir",
  "write"
]);

const rejectedOptions = new Set([
  "account-key",
  "account-name",
  "connection-string",
  "container",
  "copy-media",
  "destination",
  "output",
  "overwrite",
  "public-root",
  "sas-token",
  "write-public-manifest"
]);

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      throw new EditorialMediaUploadPlanError("invalid-argument");
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const key = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (rejectedOptions.has(key)) {
      throw new EditorialMediaUploadPlanError(`rejected-option-${key}`);
    }
    if (!allowedOptions.has(key) || parsed.has(key)) {
      throw new EditorialMediaUploadPlanError(`unsupported-option-${key}`);
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
    throw new EditorialMediaUploadPlanError(`missing-${key}`);
  }
  return value;
}

function expectedCount(args: Arguments, key: string) {
  const value = requiredString(args, key);
  if (!/^\d+$/u.test(value)) {
    throw new EditorialMediaUploadPlanError(`invalid-${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EditorialMediaUploadPlanError(`invalid-${key}`);
  }
  return parsed;
}

function booleanOption(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new EditorialMediaUploadPlanError(`invalid-${key}`);
  }
  return true;
}

export async function runEditorialMediaUploadPlanCli(argv: readonly string[]) {
  const args = parseArguments(argv);
  const write = booleanOption(args, "write");
  const dryRun = booleanOption(args, "dry-run");
  const resume = booleanOption(args, "resume");
  if (write === dryRun || (resume && !write)) {
    throw new EditorialMediaUploadPlanError("invalid-mode");
  }
  const result = await createEditorialMediaUploadPlan({
    database: requiredString(args, "database"),
    uploadsDir: requiredString(args, "uploads-dir"),
    fingerprintKeyFile: requiredString(args, "fingerprint-key-file"),
    stagingDir: requiredString(args, "staging-dir"),
    uploadDir: requiredString(args, "upload-dir"),
    expected: {
      galleryCandidates: expectedCount(args, "expected-gallery-candidates"),
      galleries: expectedCount(args, "expected-galleries"),
      publicationExcluded: expectedCount(args, "expected-publication-excluded"),
      ready: expectedCount(args, "expected-ready"),
      review: expectedCount(args, "expected-review"),
      selected: expectedCount(args, "expected-selected")
    },
    repositoryRoot: defaultEditorialPromotionRepositoryRoot,
    dryRun,
    write,
    resume
  });
  process.stdout.write(serializeEditorialMediaUploadPlanResult(result));
  return result;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runEditorialMediaUploadPlanCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof EditorialMediaUploadPlanError) {
      console.error(error.code);
    } else {
      console.error("editorial-media-upload-plan-failed");
    }
    process.exitCode = 1;
  });
}
