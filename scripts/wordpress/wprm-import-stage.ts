import { createHmac, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  recipeRecordSchema,
  type WordPressRecipeRecordV1
} from "../../src/content/schema";
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
const rootStagingLockFileName = ".wordpress-staging.lock";
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
  readonly initialRootState: ExistingRootState;
}

interface StagingLock {
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly dev: number;
  readonly ino: number;
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
  readonly schemaVersion: 1 | 2 | 3;
  readonly kind: "wprm-bulk-staging";
  readonly sqlDecompressedSha256: string;
  readonly importerContractVersion: string;
  readonly mediaBindingVersion?: 1;
  readonly uploadIndexContractSha256?: string;
}

function isWprmStagingMarkerShape(value: unknown): value is WprmStagingMarkerShape {
  const isLegacy = hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "importerContractVersion"
  ])
    && value.schemaVersion === 1;
  const isPreUploadBound = hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "importerContractVersion",
    "mediaBindingVersion"
  ])
    && value.schemaVersion === 2
    && value.mediaBindingVersion === 1;
  const isUploadBound = hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "uploadIndexContractSha256",
    "importerContractVersion",
    "mediaBindingVersion"
  ])
    && value.schemaVersion === 3
    && value.mediaBindingVersion === 1
    && typeof value.uploadIndexContractSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.uploadIndexContractSha256);
  return (isLegacy || isPreUploadBound || isUploadBound)
    && value.kind === "wprm-bulk-staging"
    && typeof value.sqlDecompressedSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sqlDecompressedSha256)
    && typeof value.importerContractVersion === "string"
    && /^wprm-bulk-import-v\d+$/u.test(value.importerContractVersion);
}

function isWprmStagingMarker(value: unknown): value is WprmStagingMarker {
  return isWprmStagingMarkerShape(value)
    && value.schemaVersion === 3
    && value.mediaBindingVersion === 1
    && typeof value.uploadIndexContractSha256 === "string"
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
    && actual.uploadIndexContractSha256 === expected.uploadIndexContractSha256
    && actual.importerContractVersion === expected.importerContractVersion
    && actual.mediaBindingVersion === expected.mediaBindingVersion;
}

function isLegacyV3Marker(value: WprmStagingMarkerShape) {
  return value.schemaVersion === 1
    && value.importerContractVersion === "wprm-bulk-import-v3";
}

function isPreUploadBindingMarker(value: WprmStagingMarkerShape) {
  return value.schemaVersion === 2 && value.mediaBindingVersion === 1;
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
  expected?: WprmStagingMarker,
  genericMatches?: (value: unknown) => boolean
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
    if (genericMatches !== undefined) {
      if (!genericMatches(parsed)) {
        throw new WprmImportError("staging-conflict");
      }
      return parsed;
    }
    if (!isWprmStagingMarkerShape(parsed)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    if (expected !== undefined && isLegacyV3Marker(parsed)) {
      throw new WprmImportError("staging-media-binding-upgrade-required");
    }
    if (expected !== undefined && isPreUploadBindingMarker(parsed)) {
      throw new WprmImportError("staging-upload-contract-upgrade-required");
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

type ExistingRootState = "absent" | "empty" | "matching";

async function existingRootState(
  authorization: DestinationAuthorization,
  markerFileName: string,
  assertMarker: () => Promise<void>,
  ignoreOwnedLock = false,
  allowEmptyCandidatesDirectory = false
): Promise<ExistingRootState> {
  if (!authorization.exists) {
    return "absent";
  }
  await privateDirectoryStats(authorization.destination);
  let entries: string[];
  try {
    entries = await readdir(authorization.destination);
  } catch {
    throw new WprmImportError("unsafe-staging-dir");
  }
  const effectiveEntries = entries.filter((entry) =>
    !ignoreOwnedLock || entry !== rootStagingLockFileName
  );
  if (effectiveEntries.length === 0) {
    return "empty";
  }
  if (
    allowEmptyCandidatesDirectory
    && effectiveEntries.length === 1
    && effectiveEntries[0] === "candidates"
  ) {
    await privateDirectoryStats(path.join(authorization.destination, "candidates"));
    let candidateEntries: string[];
    try {
      candidateEntries = await readdir(path.join(authorization.destination, "candidates"));
    } catch {
      throw new WprmImportError("unsafe-staging-dir");
    }
    if (candidateEntries.length === 0) {
      return "empty";
    }
  }
  if (!effectiveEntries.includes(markerFileName)) {
    throw new WprmImportError("staging-conflict");
  }
  for (const marker of [".wprm-staging.json", ".editorial-staging.json"]) {
    if (marker !== markerFileName && effectiveEntries.includes(marker)) {
      throw new WprmImportError("staging-conflict");
    }
  }
  await assertMarker();
  return "matching";
}

async function existingWprmRootState(
  authorization: DestinationAuthorization,
  expectedMarker?: WprmStagingMarker,
  ignoreOwnedLock = false,
  allowEmptyCandidatesDirectory = false
) {
  return existingRootState(
    authorization,
    ".wprm-staging.json",
    async () => {
      await readPrivateMarker(
        path.join(authorization.destination, ".wprm-staging.json"),
        expectedMarker
      );
    },
    ignoreOwnedLock,
    allowEmptyCandidatesDirectory
  );
}

async function existingGenericRootState(
  authorization: DestinationAuthorization,
  markerFileName: string,
  markerMatches: (value: unknown) => boolean,
  ignoreOwnedLock = false,
  allowEmptyCandidatesDirectory = false
) {
  return existingRootState(
    authorization,
    markerFileName,
    async () => {
      await readPrivateMarker(
        path.join(authorization.destination, markerFileName),
        undefined,
        markerMatches
      );
    },
    ignoreOwnedLock,
    allowEmptyCandidatesDirectory
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
  let createdDestination = false;
  for (const part of initial.missingParts) {
    const next = path.join(current, part);
    if (initial.inRepository && current === repositoryRoot) {
      try {
        const [stats, physicalCurrent] = await Promise.all([
          lstat(current),
          realpath(current)
        ]);
        if (
          stats.isSymbolicLink()
          || !stats.isDirectory()
          || physicalCurrent !== repositoryRoot
        ) {
          throw new WprmImportError("unsafe-staging-dir");
        }
      } catch (error) {
        if (error instanceof WprmImportError) {
          throw error;
        }
        throw new WprmImportError("unsafe-staging-dir");
      }
    } else {
      await authorizeDestination(current, inputWasAbsoluteOverride, true);
    }
    let created = false;
    try {
      await mkdir(next, { mode: 0o700 });
      created = true;
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
    if (created) {
      await chmod(next, 0o700);
    }
    if (initial.inRepository && next === migrationOutputRoot) {
      await privateDirectoryStats(next);
    }
    if (created && next === initial.destination) {
      createdDestination = true;
    }
    await authorizeDestination(next, inputWasAbsoluteOverride, true);
    current = next;
  }
  await authorizeDestination(initial.destination, inputWasAbsoluteOverride, true);
  if (createdDestination) {
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
  if (rootAuthorization.exists) {
    await privateDirectoryStats(rootAuthorization.destination);
  }
  if (candidatesAuthorization.exists) {
    await privateDirectoryStats(candidatesAuthorization.destination);
  }
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number }
) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertStagingLock(lock: StagingLock) {
  let pathStats;
  try {
    pathStats = await lstat(lock.path);
  } catch {
    throw new WprmImportError("staging-conflict");
  }
  if (
    pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || !isPrivateOwned(pathStats)
    || !sameFileIdentity(pathStats, lock)
  ) {
    throw new WprmImportError("staging-conflict");
  }
  let handleStats;
  try {
    handleStats = await lock.handle.stat();
  } catch {
    throw new WprmImportError("staging-conflict");
  }
  if (
    !handleStats.isFile()
    || !isPrivateOwned(handleStats)
    || !sameFileIdentity(handleStats, lock)
  ) {
    throw new WprmImportError("staging-conflict");
  }
}

async function acquireStagingLock(root: string) {
  const lockPath = path.join(root, rootStagingLockFileName);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      lockPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "EEXIST"
    ) {
      try {
        const existing = await lstat(lockPath);
        if (
          existing.isSymbolicLink()
          || !existing.isFile()
          || !isPrivateOwned(existing)
        ) {
          throw new WprmImportError("unsafe-staging-dir");
        }
      } catch (inspectionError) {
        if (inspectionError instanceof WprmImportError) {
          throw inspectionError;
        }
        throw new WprmImportError("staging-conflict");
      }
      throw new WprmImportError("staging-conflict");
    }
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "ELOOP"
    ) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    throw new WprmImportError("staging-write-failed");
  }
  let lock: StagingLock | undefined;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !isPrivateOwned(stats)) {
      throw new WprmImportError("unsafe-staging-dir");
    }
    lock = {
      path: lockPath,
      handle,
      dev: stats.dev,
      ino: stats.ino
    };
    await handle.writeFile(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "exclusive-wordpress-staging-lock",
        pid: process.pid,
        nonce: randomBytes(16).toString("hex")
      })}\n`,
      "utf8"
    );
    await handle.chmod(0o600);
    await handle.sync();
    await assertStagingLock(lock);
    return lock;
  } catch (error) {
    try {
      if (lock !== undefined) {
        const pathStats = await lstat(lock.path);
        if (
          !pathStats.isSymbolicLink()
          && pathStats.isFile()
          && isPrivateOwned(pathStats)
          && sameFileIdentity(pathStats, lock)
        ) {
          await unlink(lock.path);
        }
      }
    } catch {
      // Leave an uncertain lock in place so a later run fails closed.
    } finally {
      try {
        await handle.close();
      } catch {
        // Preserve the original acquisition failure.
      }
    }
    if (error instanceof WprmImportError) {
      throw error;
    }
    throw new WprmImportError("staging-write-failed");
  }
}

async function releaseStagingLock(lock: StagingLock) {
  let tombstonePath: string | undefined;
  let ownsTombstone = false;
  let failure: WprmImportError | undefined;
  try {
    await assertStagingLock(lock);
    await privateDirectoryStats(path.dirname(lock.path));
    tombstonePath = path.join(
      path.dirname(lock.path),
      `.${path.basename(lock.path)}.released-${randomBytes(16).toString("hex")}`
    );
    try {
      await lstat(tombstonePath);
      throw new WprmImportError("staging-conflict");
    } catch (error) {
      if (!missingError(error)) {
        throw error;
      }
    }
    await rename(lock.path, tombstonePath);
    const tombstoneStats = await lstat(tombstonePath);
    if (
      tombstoneStats.isSymbolicLink()
      || !tombstoneStats.isFile()
      || !isPrivateOwned(tombstoneStats)
      || !sameFileIdentity(tombstoneStats, lock)
    ) {
      throw new WprmImportError("staging-conflict");
    }
    ownsTombstone = true;
  } catch (error) {
    failure = error instanceof WprmImportError
      ? error
      : new WprmImportError("staging-conflict");
  } finally {
    try {
      await lock.handle.close();
    } catch {
      if (failure === undefined) {
        failure = new WprmImportError("staging-conflict");
      }
    }
  }
  if (ownsTombstone && tombstonePath !== undefined) {
    try {
      const tombstoneStats = await lstat(tombstonePath);
      if (
        tombstoneStats.isSymbolicLink()
        || !tombstoneStats.isFile()
        || !isPrivateOwned(tombstoneStats)
        || !sameFileIdentity(tombstoneStats, lock)
      ) {
        throw new WprmImportError("staging-conflict");
      }
      await unlink(tombstonePath);
    } catch {
      if (failure === undefined) {
        failure = new WprmImportError("staging-conflict");
      }
    }
  }
  if (failure !== undefined) {
    throw failure;
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
  candidate: WordPressRecipeRecordV1 | string
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
  const state = await existingWprmRootState(
    initialAuthorization,
    expectedMarker,
    false,
    true
  );
  if (existingExternal) {
    if (!resume) {
      throw new WprmImportError("unsafe-staging-dir");
    }
  }
  if (resume && state !== "matching") {
    throw new WprmImportError("staging-conflict");
  }
  if (!resume && state === "matching") {
    throw new WprmImportError("staging-conflict");
  }
  const root = await ensurePrivateDirectory(
    canonical.destination,
    canonical.inputWasAbsolute,
    existingExternal
  );
  const rootAuthorization = await authorizeDestination(
    root,
    canonical.inputWasAbsolute,
    !initialAuthorization.inRepository
  );
  const rootState = await existingWprmRootState(
    rootAuthorization,
    expectedMarker,
    false,
    true
  );
  if (resume && rootState !== "matching") {
    throw new WprmImportError("staging-conflict");
  }
  if (!resume && rootState === "matching") {
    throw new WprmImportError("staging-conflict");
  }
  const candidates = await ensurePrivateDirectory(
    path.join(root, "candidates"),
    canonical.inputWasAbsolute,
    !initialAuthorization.inRepository
  );
  const directories = {
    root,
    candidates,
    inputWasAbsolute: canonical.inputWasAbsolute,
    allowExistingExternal: !initialAuthorization.inRepository,
    initialRootState: rootState
  } satisfies StagingDirectories;
  await revalidateStagingDirectories(directories);
  return directories;
}

async function readExistingRegularFile(target: string) {
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if (missingError(error)) {
      return null;
    }
    throw new WprmImportError("staging-conflict");
  }
  if (stats.isSymbolicLink() || !stats.isFile() || !isPrivateOwned(stats)) {
    throw new WprmImportError("staging-conflict");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile() || !isPrivateOwned(handleStats)) {
      throw new WprmImportError("staging-conflict");
    }
    const content = await handle.readFile();
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
  matchesExisting: (existing: Buffer) => boolean,
  lock?: StagingLock
) {
  if (lock !== undefined) {
    await assertStagingLock(lock);
  }
  await revalidateStagingDirectories(directories);
  const existing = await readExistingRegularFile(target);
  if (existing !== null) {
    if (!resume || !matchesExisting(existing)) {
      throw new WprmImportError("staging-conflict");
    }
    await revalidateStagingDirectories(directories);
    return false;
  }

  if (lock !== undefined) {
    await assertStagingLock(lock);
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
    if (lock !== undefined) {
      await assertStagingLock(lock);
    }
    await revalidateStagingDirectories(directories);
    const raced = await readExistingRegularFile(target);
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

export interface PrivateStagingFile {
  readonly relativePath: string;
  readonly content: string;
  readonly matchesExisting?: (existing: Buffer) => boolean;
}

export interface PrivateStagingFilesOptions {
  readonly stagingDir: string;
  readonly resume?: boolean;
  readonly markerFileName: string;
  readonly markerContent: string;
  readonly markerMatches: (value: unknown) => boolean;
  readonly files: readonly PrivateStagingFile[];
}

function validPrivateMarkerFileName(value: string) {
  return /^\.[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(value);
}

function stagingRelativeTarget(
  directories: StagingDirectories,
  relativePath: string,
  markerFileName: string
) {
  const rootFile = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
  const candidateFile = /^candidates\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u;
  if (
    relativePath === markerFileName
    || (!rootFile.test(relativePath) && !candidateFile.test(relativePath))
  ) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  const target = path.resolve(directories.root, relativePath);
  if (!isWithin(target, directories.root)) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  return target;
}

export async function stagePrivateStagingFiles(
  options: PrivateStagingFilesOptions
) {
  if (!validPrivateMarkerFileName(options.markerFileName)) {
    throw new WprmImportError("unsafe-staging-dir");
  }
  const seenFiles = new Set<string>();
  for (const file of options.files) {
    if (seenFiles.has(file.relativePath)) {
      throw new WprmImportError("staging-conflict");
    }
    seenFiles.add(file.relativePath);
  }
  const canonical = canonicalDestination(options.stagingDir);
  const initialAuthorization = await authorizeDestination(
    canonical.destination,
    canonical.inputWasAbsolute,
    true
  );
  const existingExternal = (
    !initialAuthorization.inRepository && initialAuthorization.exists
  );
  const state = await existingGenericRootState(
    initialAuthorization,
    options.markerFileName,
    options.markerMatches,
    false,
    true
  );
  if (existingExternal) {
    if (!options.resume) {
      throw new WprmImportError("unsafe-staging-dir");
    }
  }
  if (options.resume && state !== "matching") {
    throw new WprmImportError("staging-conflict");
  }
  if (!options.resume && state === "matching") {
    throw new WprmImportError("staging-conflict");
  }
  const root = await ensurePrivateDirectory(
    canonical.destination,
    canonical.inputWasAbsolute,
    existingExternal
  );
  const rootAuthorization = await authorizeDestination(
    root,
    canonical.inputWasAbsolute,
    !initialAuthorization.inRepository
  );
  const rootState = await existingGenericRootState(
    rootAuthorization,
    options.markerFileName,
    options.markerMatches,
    false,
    true
  );
  if (options.resume && rootState !== "matching") {
    throw new WprmImportError("staging-conflict");
  }
  if (!options.resume && rootState === "matching") {
    throw new WprmImportError("staging-conflict");
  }
  const candidates = await ensurePrivateDirectory(
    path.join(root, "candidates"),
    canonical.inputWasAbsolute,
    !initialAuthorization.inRepository
  );
  const directories = {
    root,
    candidates,
    inputWasAbsolute: canonical.inputWasAbsolute,
    allowExistingExternal: !initialAuthorization.inRepository,
    initialRootState: rootState
  } satisfies StagingDirectories;
  await revalidateStagingDirectories(directories);
  const lock = await acquireStagingLock(root);
  try {
    await assertStagingLock(lock);
    const lockedAuthorization = await authorizeDestination(
      root,
      directories.inputWasAbsolute,
      directories.allowExistingExternal
    );
    const lockedState = await existingGenericRootState(
      lockedAuthorization,
      options.markerFileName,
      options.markerMatches,
      true,
      directories.initialRootState !== "matching"
    );
    if (
      (options.resume === true && lockedState !== "matching")
      || (options.resume !== true && lockedState === "matching")
    ) {
      throw new WprmImportError("staging-conflict");
    }
    if (options.resume === true) {
      const expectedRootEntries = new Set([
        options.markerFileName,
        rootStagingLockFileName,
        "candidates",
        ...options.files
          .filter((file) => !file.relativePath.startsWith("candidates/"))
          .map((file) => file.relativePath)
      ]);
      const expectedCandidateEntries = new Set(
        options.files
          .filter((file) => file.relativePath.startsWith("candidates/"))
          .map((file) => path.basename(file.relativePath))
      );
      const rootEntries = await readdir(root);
      const candidateEntries = await readdir(candidates);
      if (
        rootEntries.some((entry) => !expectedRootEntries.has(entry))
        || candidateEntries.some((entry) => !expectedCandidateEntries.has(entry))
      ) {
        throw new WprmImportError("staging-conflict");
      }
    }
    const markerPath = path.join(root, options.markerFileName);
    await writeAtomic(
      markerPath,
      options.markerContent,
      0o600,
      options.resume === true,
      directories,
      (existing) => {
        try {
          return options.markerMatches(JSON.parse(existing.toString("utf8")));
        } catch {
          return false;
        }
      },
      lock
    );
    for (const file of options.files) {
      const target = stagingRelativeTarget(
        directories,
        file.relativePath,
        options.markerFileName
      );
      await writeAtomic(
        target,
        file.content,
        0o600,
        options.resume === true,
        directories,
        file.matchesExisting ?? ((existing) => existing.toString("utf8") === file.content),
        lock
      );
    }
  } finally {
    await releaseStagingLock(lock);
  }
  return directories;
}

function candidateContent(record: WordPressRecipeRecordV1) {
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
    schemaVersion: 3,
    kind: "wprm-bulk-staging",
    sqlDecompressedSha256: manifest.source.sqlDecompressedSha256,
    uploadIndexContractSha256: manifest.source.uploadIndexContractSha256,
    importerContractVersion: wprmImportContractVersion,
    mediaBindingVersion: 1
  };
  const directories = await assertPrivateStagingDirectory(
    options.stagingDir,
    resume,
    marker
  );
  const lock = await acquireStagingLock(directories.root);
  try {
    await assertStagingLock(lock);
    const lockedAuthorization = await authorizeDestination(
      directories.root,
      directories.inputWasAbsolute,
      directories.allowExistingExternal
    );
    const lockedState = await existingWprmRootState(
      lockedAuthorization,
      marker,
      true,
      directories.initialRootState !== "matching"
    );
    if (
      (resume && lockedState !== "matching")
      || (!resume && lockedState === "matching")
    ) {
      throw new WprmImportError("staging-conflict");
    }
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
      },
      lock
    );
    const staged: CandidateOutcome[] = [];
    for (const outcome of [...outcomes].sort((left, right) =>
      numericIdSort(left.recipeId, right.recipeId)
    )) {
      if (outcome.status === "error" || outcome.record === null) {
        await assertStagingLock(lock);
        await revalidateStagingDirectories(directories);
        const errorTarget = path.join(
          directories.candidates,
          `${outcome.recipeId}.json`
        );
        if (await readExistingRegularFile(errorTarget) !== null) {
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
        },
        lock
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
      (existing) => existing.toString("utf8") === mediaBindingContent,
      lock
    );
    const manifestContent = `${JSON.stringify(safeManifest, null, 2)}\n`;
    await writeAtomic(
      path.join(directories.root, "manifest.json"),
      manifestContent,
      0o600,
      resume,
      directories,
      (existing) => existing.toString("utf8") === manifestContent,
      lock
    );
    return { outcomes: staged, manifest: safeManifest };
  } finally {
    await releaseStagingLock(lock);
  }
}

export const writeWprmStaging = stageWprmCandidates;
export const candidateFingerprint = fingerprintCandidate;
export const readPrivateFingerprintKey = readFingerprintKey;
