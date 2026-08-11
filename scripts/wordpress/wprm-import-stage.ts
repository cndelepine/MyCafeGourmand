import { createHmac, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recipeRecordSchema, type RecipeRecord } from "../../src/content/schema";
import {
  wprmImportContractVersion,
  WprmImportError,
  type CandidateOutcome,
  type WprmSafeManifest,
  type WprmStagedMediaBindings,
  type WprmStagingMarker
} from "./wprm-import-contracts";

export interface StagingOptions {
  readonly stagingDir: string;
  readonly fingerprintKeyFile: string;
  readonly resume?: boolean;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = realpathSync(path.resolve(moduleDirectory, "../.."));
const migrationOutputRoot = path.join(repositoryRoot, "migration-output");
const forbiddenRootNames = ["src", "content", "public", "out", ".next"] as const;
const forbiddenRoots = forbiddenRootNames.map((name) =>
  path.join(repositoryRoot, name)
);

interface DestinationAuthorization {
  readonly destination: string;
  readonly inputWasAbsolute: boolean;
  readonly physicalDestination: string;
  readonly existingPrefix: string;
  readonly missingParts: readonly string[];
  readonly exists: boolean;
  readonly inRepository: boolean;
}

interface StagingDirectories {
  readonly root: string;
  readonly candidates: string;
  readonly inputWasAbsolute: boolean;
  readonly allowExistingExternal: boolean;
}

function isWithin(candidate: string, directory: string) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber
    ? -1
    : leftNumber > rightNumber
      ? 1
      : left.localeCompare(right);
}

function canonicalDestination(input: string) {
  const inputWasAbsolute = path.isAbsolute(input);
  return {
    inputWasAbsolute,
    destination: inputWasAbsolute
      ? path.resolve(input)
      : path.resolve(repositoryRoot, input)
  };
}

function pathParts(destination: string) {
  const parsed = path.parse(destination);
  return {
    root: parsed.root,
    parts: destination
      .slice(parsed.root.length)
      .split(path.sep)
      .filter((part) => part.length > 0)
  };
}

function missingError(error: unknown) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isPrivateOwned(stats: { readonly mode: number; readonly uid?: number }) {
  if ((stats.mode & 0o077) !== 0) {
    return false;
  }
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

interface WprmStagingMarkerShape {
  readonly schemaVersion: 1 | 2;
  readonly kind: "wprm-bulk-staging";
  readonly sqlDecompressedSha256: string;
  readonly importerContractVersion: string;
  readonly mediaBindingVersion?: 1;
}

function isWprmStagingMarkerShape(value: unknown): value is WprmStagingMarkerShape {
  const isLegacy = hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "importerContractVersion"
  ])
    && value.schemaVersion === 1;
  const isCurrent = hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "importerContractVersion",
    "mediaBindingVersion"
  ])
    && value.schemaVersion === 2
    && value.mediaBindingVersion === 1;
  return (isLegacy || isCurrent)
    && value.kind === "wprm-bulk-staging"
    && typeof value.sqlDecompressedSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sqlDecompressedSha256)
    && typeof value.importerContractVersion === "string"
    && /^wprm-bulk-import-v\d+$/u.test(value.importerContractVersion);
}

function isWprmStagingMarker(value: unknown): value is WprmStagingMarker {
  return isWprmStagingMarkerShape(value)
    && value.schemaVersion === 2
    && value.mediaBindingVersion === 1
    && value.importerContractVersion === wprmImportContractVersion;
}

function markerContent(marker: WprmStagingMarker) {
  return `${JSON.stringify(marker)}\n`;
}

function markerMatches(
  actual: WprmStagingMarkerShape,
  expected: WprmStagingMarker
) {
  return actual.schemaVersion === expected.schemaVersion
    && actual.kind === expected.kind
    && actual.sqlDecompressedSha256 === expected.sqlDecompressedSha256
    && actual.importerContractVersion === expected.importerContractVersion
    && actual.mediaBindingVersion === expected.mediaBindingVersion;
}

function isLegacyV3Marker(value: WprmStagingMarkerShape) {
  return value.schemaVersion === 1
    && value.importerContractVersion === "wprm-bulk-import-v3";
}

async function privateDirectoryStats(target: string) {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    throw new WprmImportError("unsafe-staging-dir");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || !isPrivateOwned(stats)
  ) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  return stats;
}

async function readPrivateMarker(
  target: string,
  expected?: WprmStagingMarker
) {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    throw new WprmImportError("unsafe-staging-dir");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || !isPrivateOwned(stats)
  ) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile()) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    const parsed: unknown = JSON.parse((await handle.readFile()).toString("utf8"));
    if (!isWprmStagingMarkerShape(parsed)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    if (expected !== undefined && isLegacyV3Marker(parsed)) {
      throw new WprmImportError("staging-media-binding-upgrade-required");
    }
    if (expected !== undefined && !markerMatches(parsed, expected)) {
      throw new WprmImportError("staging-conflict");
    }
    if (expected === undefined && !isWprmStagingMarker(parsed)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    return parsed;
  } catch (error) {
    if (error instanceof WprmImportError) {
      throw error;
    }
    throw new WprmImportError("unsafe-staging-dir");
  } finally {
    await handle?.close();
  }
}

async function validateExistingExternalRoot(
  authorization: DestinationAuthorization,
  expectedMarker?: WprmStagingMarker
) {
  if (authorization.inRepository || !authorization.exists) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  await privateDirectoryStats(authorization.destination);
  const candidates = path.join(authorization.destination, "candidates");
  await privateDirectoryStats(candidates);
  await readPrivateMarker(
    path.join(authorization.destination, ".wprm-staging.json"),
    expectedMarker
  );
}

async function inspectExistingComponents(destination: string) {
  const { root, parts } = pathParts(destination);
  let current = root;
  let existingPrefix = root;
  let missingParts: string[] = [];

  try {
    const rootStats = await lstat(current);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new WprmImportError("unsafe-staging-dir");
    }
  } catch (error) {
    if (!missingError(error)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
  }

  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (missingParts.length > 0) {
      missingParts.push(part);
      continue;
    }
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (missingError(error)) {
        existingPrefix = path.dirname(current);
        missingParts = parts.slice(index);
        break;
      }
      throw new WprmImportError("unsafe-staging-dir");
    }
    if (stats.isSymbolicLink()) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    if (!stats.isDirectory()) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    existingPrefix = current;
  }

  return { existingPrefix, missingParts };
}

async function authorizeDestination(
  input: string,
  inputWasAbsoluteOverride?: boolean,
  allowExistingExternal = false
): Promise<DestinationAuthorization> {
  const canonical = canonicalDestination(input);
  const inputWasAbsolute = inputWasAbsoluteOverride ?? canonical.inputWasAbsolute;
  if (canonical.destination === path.parse(canonical.destination).root) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  const { existingPrefix, missingParts } = await inspectExistingComponents(
    canonical.destination
  );
  let physicalPrefix: string;
  try {
    physicalPrefix = await realpath(existingPrefix);
  } catch {
    throw new WprmImportError("unsafe-staging-dir");
  }
  const physicalDestination = path.join(physicalPrefix, ...missingParts);
  const exists = missingParts.length === 0;
  if (forbiddenRoots.some((root) => isWithin(physicalDestination, root))) {
    throw new WprmImportError("unsafe-staging-dir");
  }

  const inRepository = isWithin(physicalDestination, repositoryRoot);
  if (inRepository) {
    if (!isWithin(physicalDestination, migrationOutputRoot)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
  } else {
    if (!inputWasAbsolute || (exists && !allowExistingExternal)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
  }

  return {
    destination: canonical.destination,
    inputWasAbsolute,
    physicalDestination,
    existingPrefix,
    missingParts,
    exists,
    inRepository
  };
}

async function ensurePrivateDirectory(
  input: string,
  inputWasAbsoluteOverride?: boolean,
  allowExistingExternal = false
) {
  const initial = await authorizeDestination(
    input,
    inputWasAbsoluteOverride,
    allowExistingExternal
  );
  if (initial.exists && !initial.inRepository) {
    await privateDirectoryStats(initial.destination);
  }
  let current = initial.existingPrefix;
  for (const part of initial.missingParts) {
    const next = path.join(current, part);
    await authorizeDestination(current, inputWasAbsoluteOverride, true);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw new WprmImportError("staging-write-failed");
      }
    }
    let stats;
    try {
      stats = await lstat(next);
    } catch {
      throw new WprmImportError("unsafe-staging-dir");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    await chmod(next, 0o700);
    await authorizeDestination(next, inputWasAbsoluteOverride, true);
    current = next;
  }
  await authorizeDestination(initial.destination, inputWasAbsoluteOverride, true);
  if (initial.inRepository || !initial.exists) {
    await chmod(initial.destination, 0o700);
  }
  await authorizeDestination(initial.destination, inputWasAbsoluteOverride, true);
  return initial.destination;
}

async function revalidateStagingDirectories(
  directories: StagingDirectories
) {
  const rootAuthorization = await authorizeDestination(
    directories.root,
    directories.inputWasAbsolute,
    directories.allowExistingExternal
  );
  const candidatesAuthorization = await authorizeDestination(
    directories.candidates,
    directories.inputWasAbsolute,
    directories.allowExistingExternal
  );
  if (!rootAuthorization.inRepository && rootAuthorization.exists) {
    await privateDirectoryStats(rootAuthorization.destination);
  }
  if (!candidatesAuthorization.inRepository && candidatesAuthorization.exists) {
    await privateDirectoryStats(candidatesAuthorization.destination);
  }
}

export function canonicalCandidateJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(canonicalize);
    }
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)])
      );
    }
    return input;
  };
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) {
    throw new WprmImportError("invalid-candidate");
  }
  return serialized;
}

export async function readFingerprintKey(keyFile: string) {
  const keyPath = path.resolve(keyFile);
  let stats;
  try {
    stats = await lstat(keyPath);
  } catch {
    throw new WprmImportError("invalid-fingerprint-key");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || !isPrivateOwned(stats)
  ) {
    throw new WprmImportError("invalid-fingerprint-key");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile() || !isPrivateOwned(handleStats)) {
      throw new WprmImportError("invalid-fingerprint-key");
    }
    const key = await handle.readFile();
    if (key.byteLength < 32) {
      throw new WprmImportError("invalid-fingerprint-key");
    }
    return key;
  } catch {
    throw new WprmImportError("invalid-fingerprint-key");
  } finally {
    await handle?.close();
  }
}

export function fingerprintCandidate(
  key: Uint8Array,
  candidate: RecipeRecord | string
) {
  return createHmac("sha256", key)
    .update(
      typeof candidate === "string" ? candidate : canonicalCandidateJson(candidate),
      "utf8"
    )
    .digest("hex");
}

export async function assertPrivateStagingDirectory(
  stagingDir: string,
  resume = false,
  expectedMarker?: WprmStagingMarker
) {
  const canonical = canonicalDestination(stagingDir);
  const initialAuthorization = await authorizeDestination(
    canonical.destination,
    canonical.inputWasAbsolute,
    true
  );
  const existingExternal = (
    !initialAuthorization.inRepository && initialAuthorization.exists
  );
  if (existingExternal) {
    if (!resume) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    await validateExistingExternalRoot(initialAuthorization, expectedMarker);
  } else if (resume && initialAuthorization.exists) {
    await readPrivateMarker(
      path.join(initialAuthorization.destination, ".wprm-staging.json"),
      expectedMarker
    );
  } else if (initialAuthorization.exists) {
    const markerPath = path.join(initialAuthorization.destination, ".wprm-staging.json");
    try {
      await lstat(markerPath);
      await readPrivateMarker(markerPath, expectedMarker);
    } catch (error) {
      if (!missingError(error)) {
        throw error;
      }
    }
  }
  const root = await ensurePrivateDirectory(
    canonical.destination,
    canonical.inputWasAbsolute,
    existingExternal
  );
  const candidates = await ensurePrivateDirectory(
    path.join(root, "candidates"),
    canonical.inputWasAbsolute,
    !initialAuthorization.inRepository
  );
  const directories = {
    root,
    candidates,
    inputWasAbsolute: canonical.inputWasAbsolute,
    allowExistingExternal: !initialAuthorization.inRepository
  } satisfies StagingDirectories;
  await revalidateStagingDirectories(directories);
  return directories;
}

async function readExistingRegularFile(
  target: string,
  mode: number
) {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (missingError(error)) {
      return null;
    }
    throw new WprmImportError("staging-conflict");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new WprmImportError("staging-conflict");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile()) {
      throw new WprmImportError("staging-conflict");
    }
    const content = await handle.readFile();
    await handle.chmod(mode);
    return content;
  } catch (error) {
    if (error instanceof WprmImportError) {
      throw error;
    }
    throw new WprmImportError("staging-conflict");
  } finally {
    await handle?.close();
  }
}

async function writeAtomic(
  target: string,
  content: string,
  mode: number,
  resume: boolean,
  directories: StagingDirectories,
  matchesExisting: (existing: Buffer) => boolean
) {
  await revalidateStagingDirectories(directories);
  const existing = await readExistingRegularFile(target, mode);
  if (existing !== null) {
    if (!resume || !matchesExisting(existing)) {
      throw new WprmImportError("staging-conflict");
    }
    await revalidateStagingDirectories(directories);
    return false;
  }

  await revalidateStagingDirectories(directories);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(16).toString("hex")}.tmp`
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      mode
    );
    await handle.writeFile(content, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original staging failure.
    }
    throw new WprmImportError("staging-write-failed");
  } finally {
    await handle?.close();
  }

  try {
    await revalidateStagingDirectories(directories);
    const raced = await readExistingRegularFile(target, mode);
    if (raced !== null) {
      throw new WprmImportError("staging-conflict");
    }
    await rename(temporary, target);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original staging failure.
    }
    if (error instanceof WprmImportError) {
      throw error;
    }
    throw new WprmImportError("staging-write-failed");
  }
  return true;
}

function candidateContent(record: RecipeRecord) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function validateMediaBindings(mediaBindings: WprmStagedMediaBindings) {
  if (
    mediaBindings.schemaVersion !== 1
    || mediaBindings.kind !== "wprm-staged-media-bindings"
  ) {
    throw new WprmImportError("invalid-media-bindings");
  }
  let previous: string | undefined;
  for (const entry of mediaBindings.entries) {
    if (
      !/^\d+$/u.test(entry.attachmentId)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || !/^[a-f0-9]{64}$/u.test(entry.keyedSha256)
      || (previous !== undefined && BigInt(previous) >= BigInt(entry.attachmentId))
    ) {
      throw new WprmImportError("invalid-media-bindings");
    }
    previous = entry.attachmentId;
  }
}

export async function stageWprmCandidates(
  outcomes: readonly CandidateOutcome[],
  manifest: WprmSafeManifest,
  mediaBindings: WprmStagedMediaBindings,
  options: StagingOptions
) {
  validateMediaBindings(mediaBindings);
  const key = await readFingerprintKey(options.fingerprintKeyFile);
  const resume = options.resume === true;
  const marker: WprmStagingMarker = {
    schemaVersion: 2,
    kind: "wprm-bulk-staging",
    sqlDecompressedSha256: manifest.source.sqlDecompressedSha256,
    importerContractVersion: wprmImportContractVersion,
    mediaBindingVersion: 1
  };
  const directories = await assertPrivateStagingDirectory(
    options.stagingDir,
    resume,
    marker
  );
  await writeAtomic(
    path.join(directories.root, ".wprm-staging.json"),
    markerContent(marker),
    0o600,
    resume,
    directories,
    (existing) => {
      try {
        const parsed: unknown = JSON.parse(existing.toString("utf8"));
        return isWprmStagingMarker(parsed)
          && markerMatches(parsed, marker);
      } catch {
        return false;
      }
    }
  );
  const staged: CandidateOutcome[] = [];
  for (const outcome of [...outcomes].sort((left, right) =>
    numericIdSort(left.recipeId, right.recipeId)
  )) {
    if (outcome.status === "error" || outcome.record === null) {
      await revalidateStagingDirectories(directories);
      const errorTarget = path.join(
        directories.candidates,
        `${outcome.recipeId}.json`
      );
      if (await readExistingRegularFile(errorTarget, 0o600) !== null) {
        throw new WprmImportError("staging-conflict");
      }
      staged.push({ ...outcome, fingerprint: null });
      continue;
    }
    const fingerprint = fingerprintCandidate(key, outcome.record);
    const target = path.join(directories.candidates, `${outcome.recipeId}.json`);
    await writeAtomic(
      target,
      candidateContent(outcome.record),
      0o600,
      resume,
      directories,
      (existing) => {
        try {
          const parsed: unknown = JSON.parse(existing.toString("utf8"));
          const record = recipeRecordSchema.parse(parsed);
          return fingerprintCandidate(key, record) === fingerprint;
        } catch {
          return false;
        }
      }
    );
    staged.push({ ...outcome, fingerprint });
  }
  const safeManifest = {
    ...manifest,
    candidates: {
      ...manifest.candidates,
      outcomes: staged.map((outcome) => ({
        recipeId: outcome.recipeId,
        locale: outcome.locale,
        status: outcome.status,
        codes: outcome.codes,
        fingerprint: outcome.fingerprint
      }))
    }
  } satisfies WprmSafeManifest;
  const mediaBindingContent = `${JSON.stringify(mediaBindings, null, 2)}\n`;
  await writeAtomic(
    path.join(directories.root, "media-bindings.json"),
    mediaBindingContent,
    0o600,
    resume,
    directories,
    (existing) => existing.toString("utf8") === mediaBindingContent
  );
  const manifestContent = `${JSON.stringify(safeManifest, null, 2)}\n`;
  await writeAtomic(
    path.join(directories.root, "manifest.json"),
    manifestContent,
    0o600,
    resume,
    directories,
    (existing) => existing.toString("utf8") === manifestContent
  );
  return { outcomes: staged, manifest: safeManifest };
}

export const writeWprmStaging = stageWprmCandidates;
export const candidateFingerprint = fingerprintCandidate;
export const readPrivateFingerprintKey = readFingerprintKey;
