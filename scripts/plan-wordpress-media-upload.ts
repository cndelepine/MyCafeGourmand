#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  WprmMediaUploadPlanError,
  createWprmMediaUploadPlan,
  serializeWprmMediaUploadPlanResult
} from "./wordpress/wprm-media-upload-plan";
import { defaultPromotionRepositoryRoot } from "./wordpress/wprm-promotion";

type Arguments = ReadonlyMap<string, string | boolean>;

const allowedOptions = new Set([
  "database",
  "uploads-dir",
  "fingerprint-key-file",
  "staging-dir",
  "expected-ready",
  "expected-review",
  "expected-error",
  "upload-dir",
  "dry-run",
  "write",
  "resume",
  "write-public-manifest"
]);

const rejectedOptions = new Set([
  "account-name",
  "account-key",
  "connection-string",
  "container",
  "copy-media",
  "destination",
  "output",
  "overwrite",
  "public-root",
  "sas-token"
]);

function parseArguments(values: readonly string[]): Arguments {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      throw new WprmMediaUploadPlanError("invalid-argument");
    }
    const withoutPrefix = argument.slice(2);
    const equals = withoutPrefix.indexOf("=");
    const key = equals === -1 ? withoutPrefix : withoutPrefix.slice(0, equals);
    if (rejectedOptions.has(key)) {
      throw new WprmMediaUploadPlanError(`rejected-option-${key}`);
    }
    if (!allowedOptions.has(key) || parsed.has(key)) {
      throw new WprmMediaUploadPlanError(`unsupported-option-${key}`);
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
    throw new WprmMediaUploadPlanError(`missing-${key}`);
  }
  return value;
}

function optionalString(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new WprmMediaUploadPlanError(`invalid-${key}`);
  }
  return value;
}

function expectedCount(args: Arguments, key: string) {
  const value = requiredString(args, key);
  if (!/^\d+$/u.test(value)) {
    throw new WprmMediaUploadPlanError(`invalid-${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WprmMediaUploadPlanError(`invalid-${key}`);
  }
  return parsed;
}

function booleanOption(args: Arguments, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return false;
  }
  if (value !== true) {
    throw new WprmMediaUploadPlanError(`invalid-${key}`);
  }
  return true;
}

export async function runWprmMediaUploadPlanCli(argv: readonly string[]) {
  const args = parseArguments(argv);
  const write = booleanOption(args, "write");
  const dryRun = booleanOption(args, "dry-run");
  const resume = booleanOption(args, "resume");
  const writePublicManifest = booleanOption(args, "write-public-manifest");
  if (write === dryRun || (resume && !write) || (writePublicManifest && !write)) {
    throw new WprmMediaUploadPlanError("invalid-mode");
  }
  const uploadsDir = optionalString(args, "uploads-dir");
  const result = await createWprmMediaUploadPlan({
    database: requiredString(args, "database"),
    ...(uploadsDir === undefined ? {} : { uploadsDir }),
    fingerprintKeyFile: requiredString(args, "fingerprint-key-file"),
    stagingDir: requiredString(args, "staging-dir"),
    uploadDir: requiredString(args, "upload-dir"),
    expected: {
      ready: expectedCount(args, "expected-ready"),
      review: expectedCount(args, "expected-review"),
      error: expectedCount(args, "expected-error")
    },
    repositoryRoot: defaultPromotionRepositoryRoot,
    dryRun,
    write,
    resume,
    writePublicManifest
  });
  process.stdout.write(serializeWprmMediaUploadPlanResult(result));
  return result;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  runWprmMediaUploadPlanCli(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof WprmMediaUploadPlanError) {
      console.error(error.code);
    } else {
      console.error("media-upload-plan-failed");
    }
    process.exitCode = 1;
  });
}
