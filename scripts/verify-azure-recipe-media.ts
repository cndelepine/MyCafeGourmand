#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recipeMediaUploadPlanSchema,
} from "./wordpress/wprm-media-upload-plan";
import {
  editorialGalleryMediaUploadPlanSchema
} from "./wordpress/editorial-media-upload-plan";

const defaultRequestTimeoutMs = 30_000;
const maxPrivateUploadManifestBytes = 8 * 1024 * 1024;

export type AzureVerificationOptions = {
  readonly accountName: string;
  readonly container: string;
  readonly repositoryRoot?: string;
  readonly timeoutMs?: number;
  /**
   * Compatibility form for verifying one recipe or editorial upload plan.
   */
  readonly uploadDir?: string;
  /**
   * Verify independent, non-overlapping private plans as one Blob set.
   */
  readonly uploadDirs?: readonly string[];
};

export type AzureMediaVerificationDependencies = {
  /**
   * A loopback-only endpoint used by the Node tests. The CLI never accepts it.
   */
  readonly testBlobOrigin?: string;
};

export type AzureMediaVerificationResult = {
  readonly schemaVersion: 1;
  readonly kind: "azure-recipe-media-verification";
  readonly objects: number;
  readonly bytes: number;
  readonly unavailable: number;
  readonly statusFailures: number;
  readonly streamFailures: number;
  readonly sizeMismatches: number;
  readonly sha256Mismatches: number;
  readonly contentTypeMismatches: number;
};

export class AzureMediaVerificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Azure recipe media verification failed.");
    this.name = "AzureMediaVerificationError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new AzureMediaVerificationError(code);
}

function isWithin(candidate: string, directory: string) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function isPrivateOwned(stats: { readonly mode: number; readonly uid?: number }) {
  if ((stats.mode & 0o077) !== 0) {
    return false;
  }
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

async function assertDirectory(target: string) {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    fail("unsafe-upload-staging");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || !isPrivateOwned(stats)
    || (stats.mode & 0o777) !== 0o700
  ) {
    fail("unsafe-upload-staging");
  }
}

type AzureUploadManifest = {
  readonly entries: readonly {
    readonly bytes: number;
    readonly contentType: AzureMediaContentType;
    readonly key: string;
    readonly sha256: string;
  }[];
};

type AzureMediaContentType =
  | "image/avif"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

function isAzureMediaContentType(value: string): value is AzureMediaContentType {
  return value === "image/avif"
    || value === "image/gif"
    || value === "image/jpeg"
    || value === "image/png"
    || value === "image/webp";
}

function parseAzureUploadManifest(value: unknown): AzureUploadManifest {
  const recipe = recipeMediaUploadPlanSchema.safeParse(value);
  if (recipe.success) {
    return recipe.data;
  }
  const editorial = editorialGalleryMediaUploadPlanSchema.safeParse(value);
  if (editorial.success) {
    return editorial.data;
  }
  fail("invalid-upload-manifest");
}

async function readPrivateUploadManifest(
  repositoryRoot: string,
  uploadDir: string
): Promise<AzureUploadManifest> {
  if (path.isAbsolute(uploadDir)) {
    fail("unsafe-upload-staging");
  }
  const migrationOutput = path.join(repositoryRoot, "migration-output");
  const root = path.resolve(repositoryRoot, uploadDir);
  if (!isWithin(root, migrationOutput) || root === migrationOutput) {
    fail("unsafe-upload-staging");
  }
  await assertDirectory(migrationOutput);
  let current = migrationOutput;
  for (const part of path.relative(migrationOutput, root).split(path.sep)) {
    if (part.length === 0 || part === "." || part === "..") {
      fail("unsafe-upload-staging");
    }
    current = path.join(current, part);
    await assertDirectory(current);
  }
  const manifest = path.join(root, "upload-manifest.json");
  let stats;
  try {
    stats = await lstat(manifest);
  } catch {
    fail("unsafe-upload-staging");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || !isPrivateOwned(stats)
    || (stats.mode & 0o777) !== 0o600
    || !Number.isSafeInteger(stats.size)
    || stats.size > maxPrivateUploadManifestBytes
  ) {
    fail("unsafe-upload-staging");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || !isPrivateOwned(opened)
      || (opened.mode & 0o777) !== 0o600
      || !Number.isSafeInteger(opened.size)
      || opened.size > maxPrivateUploadManifestBytes
    ) {
      fail("unsafe-upload-staging");
    }
    return parseAzureUploadManifest(
      JSON.parse((await handle.readFile()).toString("utf8")) as unknown
    );
  } catch (error) {
    if (error instanceof AzureMediaVerificationError) {
      throw error;
    }
    fail("invalid-upload-manifest");
  } finally {
    await handle?.close();
  }
  fail("invalid-upload-manifest");
}

function uploadDirectories(options: AzureVerificationOptions) {
  if (
    options.uploadDir !== undefined
    && options.uploadDirs !== undefined
  ) {
    fail("invalid-upload-directories");
  }
  const directories = options.uploadDirs ?? (
    options.uploadDir === undefined ? [] : [options.uploadDir]
  );
  if (
    directories.length === 0
    || directories.length > 64
    || directories.some((directory) =>
      typeof directory !== "string" || directory.length === 0
    )
  ) {
    fail("invalid-upload-directories");
  }
  const unique = new Set(directories);
  if (unique.size !== directories.length) {
    fail("invalid-upload-directories");
  }
  return [...directories];
}

function validateAzureNames(accountName: string, container: string) {
  if (
    !/^[a-z0-9]{3,24}$/u.test(accountName)
    || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(container)
  ) {
    fail("invalid-azure-destination");
  }
}

function resolveBlobOrigin(
  accountName: string,
  dependencies: AzureMediaVerificationDependencies
) {
  if (dependencies.testBlobOrigin === undefined) {
    return new URL(`https://${accountName}.blob.core.windows.net/`);
  }
  let origin: URL;
  try {
    origin = new URL(dependencies.testBlobOrigin);
  } catch {
    fail("invalid-test-blob-origin");
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:")
    || origin.username.length > 0
    || origin.password.length > 0
    || origin.search.length > 0
    || origin.hash.length > 0
    || !["127.0.0.1", "::1", "localhost"].includes(origin.hostname)
  ) {
    fail("invalid-test-blob-origin");
  }
  return origin;
}

function blobUrl(origin: URL, container: string, key: string) {
  const url = new URL(origin.href);
  const basePath = url.pathname === "/"
    ? []
    : url.pathname.split("/").filter((part) => part.length > 0);
  const keyParts = key.slice(1).split("/");
  url.pathname = `/${[
    ...basePath,
    encodeURIComponent(container),
    ...keyParts.map((part) => encodeURIComponent(part))
  ].join("/")}`;
  url.search = "";
  url.hash = "";
  return url;
}

function validTimeout(value: number | undefined) {
  const resolved = value ?? defaultRequestTimeoutMs;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 300_000) {
    fail("invalid-request-timeout");
  }
  return resolved;
}

function contentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    return null;
  }
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function normalizedContentType(response: Response): AzureMediaContentType | null {
  const header = response.headers.get("content-type");
  if (
    header === null
    || Buffer.byteLength(header, "utf8") > 256
    || /[\u0000-\u001f\u007f]/u.test(header)
  ) {
    return null;
  }
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType !== undefined && isAzureMediaContentType(mediaType)
    ? mediaType
    : null;
}

function responseMatchesRequest(response: Response, expected: URL) {
  if (response.redirected || response.url.length === 0) {
    return false;
  }
  let actual: URL;
  try {
    actual = new URL(response.url);
  } catch {
    return false;
  }
  return actual.protocol === expected.protocol
    && actual.host === expected.host
    && actual.pathname === expected.pathname
    && actual.search.length === 0
    && actual.hash.length === 0
    && actual.username.length === 0
    && actual.password.length === 0;
}

type StreamVerification = {
  readonly bytes: number;
  readonly sha256: string | null;
  readonly failed: boolean;
  readonly oversized: boolean;
};

async function hashResponseBody(
  response: Response,
  expectedBytes: number
): Promise<StreamVerification> {
  if (response.body === null) {
    return {
      bytes: 0,
      sha256: null,
      failed: true,
      oversized: false
    };
  }
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  let oversized = false;
  let failed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const value = chunk.value;
      if (!(value instanceof Uint8Array)) {
        failed = true;
        break;
      }
      if (value.byteLength > expectedBytes - bytes) {
        bytes = expectedBytes + 1;
        oversized = true;
        break;
      }
      bytes += value.byteLength;
      hash.update(value);
    }
  } catch {
    failed = true;
  } finally {
    if (oversized || failed) {
      try {
        await reader.cancel();
      } catch {
        // The aggregate result remains authoritative.
      }
    }
    reader.releaseLock();
  }
  return {
    bytes,
    sha256: failed || oversized ? null : hash.digest("hex"),
    failed,
    oversized
  };
}

type ObjectVerification = {
  readonly contentTypeMismatch: boolean;
  readonly unavailable: boolean;
  readonly statusFailure: boolean;
  readonly streamFailure: boolean;
  readonly sizeMismatch: boolean;
  readonly sha256Mismatch: boolean;
};

async function verifyObject(
  expected: {
    readonly bytes: number;
    readonly contentType: AzureMediaContentType;
    readonly key: string;
    readonly sha256: string;
  },
  url: URL,
  timeoutMs: number
): Promise<ObjectVerification> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal
      });
    } catch {
      return {
        contentTypeMismatch: false,
        unavailable: true,
        statusFailure: true,
        streamFailure: false,
        sizeMismatch: false,
        sha256Mismatch: false
      };
    }
    if (
      response.status !== 200
      || !responseMatchesRequest(response, url)
    ) {
      try {
        await response.body?.cancel();
      } catch {
        // The aggregate result remains authoritative.
      }
      return {
        contentTypeMismatch: false,
        unavailable: true,
        statusFailure: true,
        streamFailure: false,
        sizeMismatch: false,
        sha256Mismatch: false
      };
    }
    const declaredBytes = contentLength(response);
    const contentTypeMismatch = normalizedContentType(response) !== expected.contentType;
    const streamed = await hashResponseBody(response, expected.bytes);
    return {
      contentTypeMismatch,
      unavailable: false,
      statusFailure: false,
      streamFailure: streamed.failed,
      sizeMismatch: declaredBytes !== expected.bytes
        || streamed.bytes !== expected.bytes
        || streamed.oversized,
      sha256Mismatch: streamed.sha256 !== null && streamed.sha256 !== expected.sha256
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyAzureRecipeMedia(
  options: AzureVerificationOptions,
  dependencies: AzureMediaVerificationDependencies = {}
): Promise<AzureMediaVerificationResult> {
  validateAzureNames(options.accountName, options.container);
  const timeoutMs = validTimeout(options.timeoutMs);
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(path.resolve(options.repositoryRoot ?? process.cwd()));
  } catch {
    fail("invalid-repository-root");
  }
  const manifests = [];
  for (const directory of uploadDirectories(options)) {
    manifests.push(await readPrivateUploadManifest(repositoryRoot, directory));
  }
  const expected = new Map<string, AzureUploadManifest["entries"][number]>();
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (expected.has(entry.key)) {
        fail("duplicate-upload-object-key");
      }
      expected.set(entry.key, entry);
    }
  }
  const origin = resolveBlobOrigin(options.accountName, dependencies);
  let unavailable = 0;
  let statusFailures = 0;
  let streamFailures = 0;
  let sizeMismatches = 0;
  let sha256Mismatches = 0;
  let contentTypeMismatches = 0;
  let bytes = 0;

  for (const entry of [...expected.values()].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  )) {
    bytes += entry.bytes;
    const result = await verifyObject(
      entry,
      blobUrl(origin, options.container, entry.key),
      timeoutMs
    );
    unavailable += result.unavailable ? 1 : 0;
    contentTypeMismatches += result.contentTypeMismatch ? 1 : 0;
    statusFailures += result.statusFailure ? 1 : 0;
    streamFailures += result.streamFailure ? 1 : 0;
    sizeMismatches += result.sizeMismatch ? 1 : 0;
    sha256Mismatches += result.sha256Mismatch ? 1 : 0;
  }
  return {
    schemaVersion: 1,
    kind: "azure-recipe-media-verification",
    objects: expected.size,
    bytes,
    unavailable,
    statusFailures,
    streamFailures,
    sizeMismatches,
    sha256Mismatches,
    contentTypeMismatches
  };
}

function parseArguments(values: readonly string[]) {
  const parsed = new Map<string, string>();
  const uploadDirs: string[] = [];
  const allowed = new Set(["account-name", "container", "upload-dir"]);
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index]!;
    if (!argument.startsWith("--")) {
      fail("invalid-argument");
    }
    const key = argument.slice(2);
    if (!allowed.has(key) || (key !== "upload-dir" && parsed.has(key))) {
      fail("invalid-argument");
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("invalid-argument");
    }
    if (key === "upload-dir") {
      uploadDirs.push(value);
    } else {
      parsed.set(key, value);
    }
    index += 1;
  }
  const accountName = parsed.get("account-name");
  const container = parsed.get("container");
  if (accountName === undefined || container === undefined || uploadDirs.length === 0) {
    fail("missing-argument");
  }
  return { accountName, container, uploadDirs };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const args = parseArguments(process.argv.slice(2));
  verifyAzureRecipeMedia(args).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (
      result.unavailable > 0
      || result.statusFailures > 0
      || result.streamFailures > 0
      || result.sizeMismatches > 0
      || result.sha256Mismatches > 0
      || result.contentTypeMismatches > 0
    ) {
      process.exitCode = 1;
    }
  }).catch((error: unknown) => {
    if (error instanceof AzureMediaVerificationError) {
      console.error(error.code);
    } else {
      console.error("azure-media-verification-failed");
    }
    process.exitCode = 1;
  });
}
