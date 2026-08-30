import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { loadRecipeCatalogWithSources } from "../../src/content/catalog";
import {
  createEditorialGalleryMediaManifest,
  loadEditorialGalleryMediaManifest,
  parseEditorialGalleryMediaManifest,
  validateEditorialGalleryMediaManifestClosure,
  type EditorialGalleryMediaManifest,
  type EditorialGalleryMediaManifestEntry
} from "../../src/content/editorial-media-manifest";
import {
  loadEditorialCatalogWithSources
} from "../../src/content/editorial-catalog";
import {
  loadGalleryCatalogWithSources,
  validatePublicContentCatalogs
} from "../../src/content/gallery-catalog";
import {
  localeValues,
  type EditorialPageRecord,
  type PublicMediaObject
} from "../../src/content/editorial-schema";
import type { GalleryRecord } from "../../src/content/gallery-schema";
import type { RecipeRecord } from "../../src/content/schema";
import { getReservedPublicPaths } from "../../src/lib/public-routes";
import {
  copyVerifiedOpenUploadArchiveEntry,
  hashVerifiedOpenUploadArchiveEntry,
  openVerifiedUploadArchive,
  type VerifiedUploadArchive
} from "./uploads-media";
import { inventoryUploadArchives } from "./uploads-inventory";
import {
  editorialImportContractVersion,
  type EditorialSafeManifest
} from "./editorial-import-contracts";
import {
  maxImageDimensionProbeBytes,
  parseImageDimensions
} from "./image-dimensions";
import { type EditorialPromotionPlan, type EditorialPlannedMediaBinding } from "./editorial-promotion";
import { resolveEditorialUploadArchives } from "./editorial-import-source";
import { canonicalCandidateJson } from "./wprm-import-stage";

type Roots = {
  readonly repositoryRoot: string;
  readonly contentRoot: string;
  readonly editorialRoot: string;
  readonly galleryRoot: string;
  readonly mediaManifest: string;
  readonly migrationOutputRoot: string;
};

type FailureInjection =
  | "after-promotion-lock"
  | "after-transaction-bootstrap"
  | "after-transaction-root"
  | "after-transaction-records-directory"
  | "after-transaction-backups-directory"
  | "after-initial-transaction-journal"
  | "after-staged-artifact-write"
  | "after-prepared-transaction-journal"
  | "after-publishing-transaction-journal"
  | "before-create-link"
  | "after-create-link"
  | "after-live-move-before-replacement-link"
  | "after-replacement-link"
  | "after-first-publication"
  | "after-some-new-files-publish"
  | "after-rollback-transaction-journal"
  | "after-rollback-preserved-create-journal"
  | "after-rollback-create-unlink"
  | "after-rollback-replacement-unlink"
  | "after-rollback-backup-rename"
  | "after-cleanup-transaction-journal"
  | "after-cleanup-staged-unlink"
  | "after-cleanup-backup-unlink"
  | "after-cleanup-journal-unlink";

export type EditorialPublicationTestOptions = {
  /**
   * Test-only fault injection. It is deliberately not accepted by the CLI.
   */
  readonly failureInjection?: FailureInjection | readonly FailureInjection[];
  /**
   * Test-only synchronization hook for an independent lock contender.
   */
  readonly onPromotionLockAcquired?: () => Promise<void>;
};

export type EditorialPublicationInput = EditorialPublicationTestOptions & {
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly fingerprintKey: Uint8Array;
  readonly sourceManifest: EditorialSafeManifest;
  readonly plan: EditorialPromotionPlan;
  readonly recipeRecords: readonly RecipeRecord[];
  readonly uploadsDir?: string;
  readonly uploadArchives?: readonly string[];
  readonly write: boolean;
};

export type EditorialPublicationSummary = {
  readonly records: {
    readonly created: number;
    readonly removed: number;
    readonly reused: number;
    readonly galleriesCreated: number;
    readonly galleriesReused: number;
  };
  readonly media: {
    readonly addedToManifest: number;
    readonly removedFromManifest: number;
    readonly reusedFromManifest: number;
    readonly updatedInManifest: number;
  };
};

export class EditorialPublicationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The editorial publication transaction failed.");
    this.name = "EditorialPublicationError";
    this.code = code;
  }
}

class EditorialPublicationInterruption extends Error {
  readonly code = "injected-promotion-interruption";

  constructor() {
    super("The editorial publication was interrupted.");
    this.name = "EditorialPublicationInterruption";
  }
}

function fail(code: string): never {
  throw new EditorialPublicationError(code);
}

function interrupt() {
  throw new EditorialPublicationInterruption();
}

function hasFailureInjection(
  configured: EditorialPublicationTestOptions["failureInjection"],
  point: FailureInjection
) {
  return Array.isArray(configured)
    ? configured.includes(point)
    : configured === point;
}

function interruptAt(
  configured: EditorialPublicationTestOptions["failureInjection"],
  point: FailureInjection
) {
  if (hasFailureInjection(configured, point)) {
    interrupt();
  }
}

function isWithin(candidate: string, directory: string) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function isMissing(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

function isRegularFile(stats: { isFile(): boolean; isSymbolicLink(): boolean }) {
  return stats.isFile() && !stats.isSymbolicLink();
}

function isPrivateOwned(stats: { readonly mode: number; readonly uid?: number }) {
  if ((stats.mode & 0o077) !== 0) {
    return false;
  }
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

function isOwnedByCurrentUser(stats: { readonly uid?: number }) {
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

function fixedEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalEquals(left: unknown, right: unknown) {
  return canonicalCandidateJson(left) === canonicalCandidateJson(right);
}

function sha256Canonical(value: unknown) {
  return createHash("sha256").update(canonicalCandidateJson(value), "utf8").digest("hex");
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

async function existingStats(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    fail("filesystem-inspection-failed");
  }
}

async function assertDirectoryChain(root: string, destination: string, createMissing: boolean) {
  if (!isWithin(destination, root)) {
    fail("unsafe-destination");
  }
  const relative = path.relative(root, destination);
  if (relative === "") {
    const stats = await existingStats(root);
    if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
      fail("unsafe-destination");
    }
    return;
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    fail("unsafe-destination");
  }
  const rootStats = await existingStats(root);
  if (rootStats === null || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail("unsafe-destination");
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part.length === 0 || part === "." || part === "..") {
      fail("unsafe-destination");
    }
    current = path.join(current, part);
    let stats = await existingStats(current);
    if (stats === null) {
      if (!createMissing) {
        fail("unsafe-destination");
      }
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (error) {
        if (
          error === null
          || typeof error !== "object"
          || !("code" in error)
          || error.code !== "EEXIST"
        ) {
          fail("destination-directory-create-failed");
        }
      }
      stats = await existingStats(current);
    }
    if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
      fail("unsafe-destination");
    }
  }
}

async function assertPrivateDirectory(target: string) {
  const stats = await existingStats(target);
  if (
    stats === null
    || stats.isSymbolicLink()
    || !stats.isDirectory()
    || !isPrivateOwned(stats)
    || (stats.mode & 0o777) !== 0o700
  ) {
    fail("unsafe-staging");
  }
}

async function readPrivateFile(target: string, maxBytes: number) {
  const stats = await existingStats(target);
  if (
    stats === null
    || !isRegularFile(stats)
    || !isPrivateOwned(stats)
    || (stats.mode & 0o777) !== 0o600
    || !Number.isSafeInteger(stats.size)
    || stats.size > maxBytes
  ) {
    fail("unsafe-staging");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || !isPrivateOwned(opened)
      || (opened.mode & 0o777) !== 0o600
    ) {
      fail("unsafe-staging");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("unsafe-staging");
  } finally {
    await handle?.close();
  }
}

async function readPrivateJson(target: string, maxBytes: number) {
  try {
    return JSON.parse((await readPrivateFile(target, maxBytes)).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("invalid-promotion-journal");
  }
}

async function readRegularJson(target: string) {
  const stats = await existingStats(target);
  if (stats === null || !isRegularFile(stats)) {
    fail("destination-file-conflict");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) {
      fail("destination-file-conflict");
    }
    return JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("destination-file-conflict");
  } finally {
    await handle?.close();
  }
}

async function hashRegularFile(target: string): Promise<FileProof> {
  const stats = await existingStats(target);
  if (stats === null || !isRegularFile(stats) || !isOwnedByCurrentUser(stats)) {
    fail("destination-file-conflict");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !isOwnedByCurrentUser(opened)) {
      fail("destination-file-conflict");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) {
        fail("destination-file-conflict");
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    return {
      bytes: opened.size,
      dev: opened.dev,
      ino: opened.ino,
      sha256: hash.digest("hex")
    };
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("destination-file-conflict");
  } finally {
    await handle?.close();
  }
  fail("destination-file-conflict");
}

async function proofMatches(target: string, expected: FileProof) {
  try {
    const observed = await hashRegularFile(target);
    return observed.bytes === expected.bytes
      && observed.dev === expected.dev
      && observed.ino === expected.ino
      && fixedEqual(observed.sha256, expected.sha256);
  } catch {
    return false;
  }
}

async function digestMatches(target: string, expected: FileDigest) {
  try {
    const observed = await hashRegularFile(target);
    return observed.bytes === expected.bytes
      && fixedEqual(observed.sha256, expected.sha256);
  } catch {
    return false;
  }
}

async function syncDirectory(directory: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isDirectory()) {
      fail("promotion-transaction-failed");
    }
    try {
      await handle.sync();
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-transaction-failed");
  } finally {
    await handle?.close();
  }
}

async function syncDirectories(directories: readonly string[]) {
  for (const directory of new Set(directories)) {
    await syncDirectory(directory);
  }
}

export async function resolveEditorialPublicationRoots(repositoryRoot: string): Promise<Roots> {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    fail("missing-repository-root");
  }
  let root: string;
  try {
    root = await realpath(path.resolve(repositoryRoot));
  } catch {
    fail("invalid-repository-root");
  }
  const stats = await existingStats(root);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("invalid-repository-root");
  }
  return {
    repositoryRoot: root,
    contentRoot: path.join(root, "content"),
    editorialRoot: path.join(root, "content", "editorial"),
    galleryRoot: path.join(root, "content", "galleries"),
    mediaManifest: path.join(root, "content", "editorial-gallery-media-manifest.json"),
    migrationOutputRoot: path.join(root, "migration-output")
  };
}

type PromotionLock = {
  readonly root: string;
  readonly owner: string;
  readonly parent: string;
  readonly token: string;
};

const promotionLockName = ".editorial-promotion.lock";

function isLockOwner(value: unknown): value is {
  readonly schemaVersion: 1;
  readonly kind: "wordpress-editorial-promotion-lock";
  readonly token: string;
} {
  return hasExactKeys(value, ["schemaVersion", "kind", "token"])
    && value.schemaVersion === 1
    && value.kind === "wordpress-editorial-promotion-lock"
    && typeof value.token === "string"
    && /^[a-f0-9]{64}$/u.test(value.token);
}

async function writePrivateText(target: string, content: string, failureCode: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail(failureCode);
  } finally {
    await handle?.close();
  }
}

async function acquirePromotionLock(roots: Roots): Promise<PromotionLock> {
  await assertDirectoryChain(roots.repositoryRoot, roots.migrationOutputRoot, false);
  const root = path.join(roots.migrationOutputRoot, promotionLockName);
  try {
    await mkdir(root, { mode: 0o700 });
    await syncDirectory(roots.migrationOutputRoot);
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "EEXIST"
    ) {
      fail("promotion-locked");
    }
    fail("promotion-lock-failed");
  }
  try {
    await assertPrivateDirectory(root);
    const token = randomBytes(32).toString("hex");
    const owner = path.join(root, "owner.json");
    await writePrivateText(
      owner,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "wordpress-editorial-promotion-lock",
        token
      })}\n`,
      "promotion-lock-failed"
    );
    await syncDirectory(root);
    return { root, owner, parent: roots.migrationOutputRoot, token };
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-lock-failed");
  }
}

async function releasePromotionLock(lock: PromotionLock) {
  try {
    await assertPrivateDirectory(lock.root);
    const entries = await readdir(lock.root, { encoding: "utf8", withFileTypes: true });
    if (
      entries.length !== 1
      || entries[0]?.name !== "owner.json"
      || entries[0].isSymbolicLink()
      || !entries[0].isFile()
    ) {
      fail("promotion-lock-release-failed");
    }
    const owner = JSON.parse((await readPrivateFile(lock.owner, 4 * 1024)).toString("utf8"));
    if (!isLockOwner(owner) || !fixedEqual(owner.token, lock.token)) {
      fail("promotion-lock-release-failed");
    }
    await unlink(lock.owner);
    await syncDirectory(lock.root);
    await rmdir(lock.root);
    await syncDirectory(lock.parent);
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-lock-release-failed");
  }
}

export async function withEditorialPromotionLock<T>(
  roots: Roots,
  options: EditorialPublicationTestOptions,
  callback: () => Promise<T>
) {
  const lock = await acquirePromotionLock(roots);
  try {
    await options.onPromotionLockAcquired?.();
    interruptAt(options.failureInjection, "after-promotion-lock");
    return await callback();
  } finally {
    await releasePromotionLock(lock);
  }
}

type FileDigest = {
  readonly bytes: number;
  readonly sha256: string;
};

type FileProof = FileDigest & {
  readonly dev: number;
  readonly ino: number;
};

type StagedArtifact = FileDigest & {
  readonly name: string;
  proof: FileProof | null;
};

type TransactionOperation =
  | {
    readonly kind: "create";
    readonly destination: string;
    readonly staged: string;
    readonly stagedProof: FileProof;
    state: "prepared" | "published" | "rolled-back";
  }
  | {
    readonly kind: "replace";
    readonly destination: string;
    readonly staged: string;
    readonly stagedProof: FileProof;
    readonly backup: string;
    readonly backupProof: FileProof;
    state: "prepared" | "published" | "rolled-back";
  }
  | {
    readonly kind: "remove";
    readonly destination: string;
    readonly backup: string;
    readonly backupProof: FileProof;
    state: "prepared" | "published" | "rolled-back";
  };

type TransactionIdentity = {
  readonly source: {
    readonly sqlDecompressedSha256: string;
    readonly manifestSha256: string;
  };
  readonly contract: {
    readonly importerContractVersion: typeof editorialImportContractVersion;
    readonly publicMediaManifestVersion: 1;
  };
  readonly planSha256: string;
};

type TransactionPhase = "setup" | "prepared" | "publishing" | "rollback" | "cleanup";
type TransactionOutcome = "pending" | "committed" | "rolled-back";

type TransactionLocation = {
  readonly root: string;
  readonly records: string;
  readonly backups: string;
  readonly journal: string;
  readonly bootstrap: string;
  readonly transactionId: string;
};

type Transaction = {
  readonly roots: Roots;
  readonly stagingRoot: string;
  readonly identity: TransactionIdentity;
  readonly key: Uint8Array;
  readonly root: string;
  readonly records: string;
  readonly backups: string;
  readonly journal: string;
  readonly bootstrap: string;
  readonly transactionId: string;
  readonly failureInjection: EditorialPublicationTestOptions["failureInjection"];
  readonly stagedArtifacts: StagedArtifact[];
  readonly operations: TransactionOperation[];
  phase: TransactionPhase;
  outcome: TransactionOutcome;
  generation: number;
  backupSequence: number;
};

type PromotionJournal = {
  readonly schemaVersion: 1;
  readonly kind: "wordpress-editorial-promotion-transaction";
  readonly transactionId: string;
  readonly generation: number;
  readonly phase: TransactionPhase;
  readonly outcome: TransactionOutcome;
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly identity: TransactionIdentity;
  readonly stagedArtifacts: readonly StagedArtifact[];
  readonly operations: readonly TransactionOperation[];
  readonly authentication: string;
};

type PromotionBootstrap = {
  readonly schemaVersion: 1;
  readonly kind: "wordpress-editorial-promotion-bootstrap";
  readonly transactionId: string;
  readonly phase: "setup" | "cleanup";
  readonly outcome: TransactionOutcome;
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly identity: TransactionIdentity;
  readonly authentication: string;
};

const maxJournalBytes = 1_048_576;
const maxJournalArtifacts = 1_024;
const maxJournalOperations = 1_024;

function transactionLocation(roots: Roots, stagingRoot: string): TransactionLocation {
  const transactionId = createHash("sha256")
    .update(`${roots.repositoryRoot}\0${stagingRoot}`, "utf8")
    .digest("hex");
  const root = path.join(
    roots.migrationOutputRoot,
    `.editorial-promotion-${transactionId}`
  );
  return {
    root,
    records: path.join(root, "records"),
    backups: path.join(root, "backups"),
    journal: path.join(root, "journal.json"),
    bootstrap: path.join(
      roots.migrationOutputRoot,
      `.editorial-promotion-${transactionId}.bootstrap.json`
    ),
    transactionId
  };
}

function isFileDigest(value: unknown): value is FileDigest {
  return hasExactKeys(value, ["bytes", "sha256"])
    && typeof value.bytes === "number"
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function isFileProof(value: unknown): value is FileProof {
  return hasExactKeys(value, ["bytes", "sha256", "dev", "ino"])
    && isFileDigest({ bytes: value.bytes, sha256: value.sha256 })
    && typeof value.dev === "number"
    && Number.isSafeInteger(value.dev)
    && value.dev >= 0
    && typeof value.ino === "number"
    && Number.isSafeInteger(value.ino)
    && value.ino >= 0;
}

function isIdentity(value: unknown): value is TransactionIdentity {
  return hasExactKeys(value, ["source", "contract", "planSha256"])
    && hasExactKeys(value.source, ["sqlDecompressedSha256", "manifestSha256"])
    && typeof value.source.sqlDecompressedSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.source.sqlDecompressedSha256)
    && typeof value.source.manifestSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.source.manifestSha256)
    && hasExactKeys(value.contract, [
      "importerContractVersion",
      "publicMediaManifestVersion"
    ])
    && value.contract.importerContractVersion === editorialImportContractVersion
    && value.contract.publicMediaManifestVersion === 1
    && typeof value.planSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.planSha256);
}

function isStagedArtifact(value: unknown): value is StagedArtifact {
  if (
    !hasExactKeys(value, ["name", "bytes", "sha256", "proof"])
    || typeof value.name !== "string"
    || typeof value.bytes !== "number"
    || typeof value.sha256 !== "string"
    || !/^\d+\.(?:json|editorial-gallery-media-manifest\.json)$/u.test(value.name)
    || !isFileDigest({ bytes: value.bytes, sha256: value.sha256 })
  ) {
    return false;
  }
  const proof = value.proof;
  return proof === null
    || (
      isFileProof(proof)
      && proof.bytes === value.bytes
      && fixedEqual(proof.sha256, value.sha256)
    );
}

function isTransactionPhase(value: unknown): value is TransactionPhase {
  return value === "setup"
    || value === "prepared"
    || value === "publishing"
    || value === "rollback"
    || value === "cleanup";
}

function isTransactionOutcome(value: unknown): value is TransactionOutcome {
  return value === "pending" || value === "committed" || value === "rolled-back";
}

function isOperation(value: unknown): value is TransactionOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = Object.fromEntries(Object.entries(value));
  if (
    typeof record.kind !== "string"
    || typeof record.destination !== "string"
    || (
      record.state !== "prepared"
      && record.state !== "published"
      && record.state !== "rolled-back"
    )
  ) {
    return false;
  }
  if (record.kind === "create") {
    return hasExactKeys(record, ["kind", "destination", "staged", "stagedProof", "state"])
      && typeof record.staged === "string"
      && isFileProof(record.stagedProof);
  }
  if (record.kind === "replace") {
    return hasExactKeys(record, [
      "kind",
      "destination",
      "staged",
      "stagedProof",
      "backup",
      "backupProof",
      "state"
    ])
      && typeof record.staged === "string"
      && isFileProof(record.stagedProof)
      && typeof record.backup === "string"
      && isFileProof(record.backupProof);
  }
  return record.kind === "remove"
    && hasExactKeys(record, [
      "kind",
      "destination",
      "backup",
      "backupProof",
      "state"
    ])
    && typeof record.backup === "string"
    && isFileProof(record.backupProof);
}

function isTransactionPath(value: unknown) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 4_096
    && path.isAbsolute(value)
    && !value.includes("\0")
    && path.normalize(value) === value;
}

function isAllowedEditorialLivePath(roots: Roots, target: string) {
  return localeValues.some((locale) => {
    const root = path.join(roots.editorialRoot, locale);
    if (!isWithin(target, root) || target === root) {
      return false;
    }
    const relative = path.relative(root, target);
    return !relative.includes(path.sep) && /^\d+\.json$/u.test(relative);
  });
}

function isAllowedLivePath(roots: Roots, target: string) {
  if (target === roots.mediaManifest || isAllowedEditorialLivePath(roots, target)) {
    return true;
  }
  return (
    isWithin(target, roots.galleryRoot)
    && target !== roots.galleryRoot
    && /^\d+\.json$/u.test(path.basename(target))
  );
}

function relativeTransactionFile(target: string, directory: string, pattern: RegExp) {
  if (!isTransactionPath(target) || !isWithin(target, directory)) {
    return null;
  }
  const relative = path.relative(directory, target);
  return relative.length > 0
    && !relative.includes(path.sep)
    && path.basename(relative) === relative
    && pattern.test(relative)
    ? relative
    : null;
}

function journalUnsigned(transaction: Transaction, generation = transaction.generation) {
  return {
    schemaVersion: 1 as const,
    kind: "wordpress-editorial-promotion-transaction" as const,
    transactionId: transaction.transactionId,
    generation,
    phase: transaction.phase,
    outcome: transaction.outcome,
    repositoryRoot: transaction.roots.repositoryRoot,
    stagingRoot: transaction.stagingRoot,
    identity: transaction.identity,
    stagedArtifacts: transaction.stagedArtifacts,
    operations: transaction.operations
  };
}

function bootstrapUnsigned(
  location: TransactionLocation,
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  phase: "setup" | "cleanup",
  outcome: TransactionOutcome
) {
  return {
    schemaVersion: 1 as const,
    kind: "wordpress-editorial-promotion-bootstrap" as const,
    transactionId: location.transactionId,
    phase,
    outcome,
    repositoryRoot: roots.repositoryRoot,
    stagingRoot,
    identity
  };
}

function authenticatedJson(unsigned: unknown, key: Uint8Array) {
  return createHmac("sha256", key)
    .update(canonicalCandidateJson(unsigned), "utf8")
    .digest("hex");
}

function parseBootstrap(
  value: unknown,
  location: TransactionLocation,
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array
): PromotionBootstrap {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "transactionId",
      "phase",
      "outcome",
      "repositoryRoot",
      "stagingRoot",
      "identity",
      "authentication"
    ])
    || value.schemaVersion !== 1
    || value.kind !== "wordpress-editorial-promotion-bootstrap"
    || value.transactionId !== location.transactionId
    || (value.phase !== "setup" && value.phase !== "cleanup")
    || !isTransactionOutcome(value.outcome)
    || (value.phase === "setup" ? value.outcome !== "pending" : value.outcome === "pending")
    || value.repositoryRoot !== roots.repositoryRoot
    || value.stagingRoot !== stagingRoot
    || !isIdentity(value.identity)
    || !canonicalEquals(value.identity, identity)
    || typeof value.authentication !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.authentication)
  ) {
    fail("invalid-promotion-journal");
  }
  const unsigned = bootstrapUnsigned(
    location,
    roots,
    stagingRoot,
    value.identity,
    value.phase,
    value.outcome
  );
  if (!fixedEqual(authenticatedJson(unsigned, key), value.authentication)) {
    fail("invalid-promotion-journal");
  }
  return {
    schemaVersion: 1,
    kind: "wordpress-editorial-promotion-bootstrap",
    transactionId: value.transactionId,
    phase: value.phase,
    outcome: value.outcome,
    repositoryRoot: value.repositoryRoot,
    stagingRoot: value.stagingRoot,
    identity: value.identity,
    authentication: value.authentication
  };
}

function parseJournal(
  value: unknown,
  location: TransactionLocation,
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array,
  bootstrap: PromotionBootstrap
): PromotionJournal {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "transactionId",
      "generation",
      "phase",
      "outcome",
      "repositoryRoot",
      "stagingRoot",
      "identity",
      "stagedArtifacts",
      "operations",
      "authentication"
    ])
    || value.schemaVersion !== 1
    || value.kind !== "wordpress-editorial-promotion-transaction"
    || value.transactionId !== location.transactionId
    || typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || value.generation > 1_000_000
    || !isTransactionPhase(value.phase)
    || !isTransactionOutcome(value.outcome)
    || (value.phase === "cleanup" ? value.outcome === "pending" : value.outcome !== "pending")
    || value.repositoryRoot !== roots.repositoryRoot
    || value.stagingRoot !== stagingRoot
    || !isIdentity(value.identity)
    || !canonicalEquals(value.identity, identity)
    || !Array.isArray(value.stagedArtifacts)
    || value.stagedArtifacts.length > maxJournalArtifacts
    || !value.stagedArtifacts.every(isStagedArtifact)
    || !Array.isArray(value.operations)
    || value.operations.length > maxJournalOperations
    || !value.operations.every(isOperation)
    || typeof value.authentication !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.authentication)
  ) {
    fail("invalid-promotion-journal");
  }
  const unsigned = {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    transactionId: value.transactionId,
    generation: value.generation,
    phase: value.phase,
    outcome: value.outcome,
    repositoryRoot: value.repositoryRoot,
    stagingRoot: value.stagingRoot,
    identity: value.identity,
    stagedArtifacts: value.stagedArtifacts,
    operations: value.operations
  };
  if (
    !fixedEqual(authenticatedJson(unsigned, key), value.authentication)
    || !canonicalEquals(value.identity, bootstrap.identity)
    || (
      bootstrap.phase === "cleanup"
      && (value.phase !== "cleanup" || value.outcome !== bootstrap.outcome)
    )
  ) {
    fail("invalid-promotion-journal");
  }

  const artifacts = new Map(value.stagedArtifacts.map((artifact) => [artifact.name, artifact]));
  const staged = new Set<string>();
  const backups = new Set<string>();
  const destinations = new Set<string>();
  if (artifacts.size !== value.stagedArtifacts.length) {
    fail("invalid-promotion-journal");
  }
  for (const operation of value.operations) {
    if (
      !isTransactionPath(operation.destination)
      || !isAllowedLivePath(roots, operation.destination)
      || destinations.has(operation.destination)
    ) {
      fail("invalid-promotion-journal");
    }
    destinations.add(operation.destination);
    if (operation.kind === "remove") {
      const backupName = relativeTransactionFile(
        operation.backup,
        location.backups,
        /^\d+\.removal$/u
      );
      if (
        !isAllowedEditorialLivePath(roots, operation.destination)
        || backupName === null
        || backups.has(backupName)
      ) {
        fail("invalid-promotion-journal");
      }
      backups.add(backupName);
      continue;
    }
    const stagedName = relativeTransactionFile(
      operation.staged,
      location.records,
      /^\d+\.(?:json|editorial-gallery-media-manifest\.json)$/u
    );
    const artifact = stagedName === null ? undefined : artifacts.get(stagedName);
    if (
      stagedName === null
      || staged.has(stagedName)
      || artifact === undefined
      || artifact.proof === null
      || !canonicalEquals(artifact.proof, operation.stagedProof)
    ) {
      fail("invalid-promotion-journal");
    }
    staged.add(stagedName);
    if (operation.kind === "replace") {
      const backupName = relativeTransactionFile(
        operation.backup,
        location.backups,
        /^\d+\.replacement$/u
      );
      if (
        operation.destination !== roots.mediaManifest
        || backupName === null
        || backups.has(backupName)
      ) {
        fail("invalid-promotion-journal");
      }
      backups.add(backupName);
    }
  }
  return {
    schemaVersion: 1,
    kind: "wordpress-editorial-promotion-transaction",
    transactionId: value.transactionId,
    generation: value.generation,
    phase: value.phase,
    outcome: value.outcome,
    repositoryRoot: value.repositoryRoot,
    stagingRoot: value.stagingRoot,
    identity: value.identity,
    stagedArtifacts: value.stagedArtifacts.map((artifact) => ({ ...artifact })),
    operations: value.operations.map((operation) => ({ ...operation })),
    authentication: value.authentication
  };
}

async function writeBootstrap(
  location: TransactionLocation,
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array,
  phase: "setup" | "cleanup" = "setup",
  outcome: TransactionOutcome = "pending",
  replace = false
) {
  const existing = await existingStats(location.bootstrap);
  if ((!replace && existing !== null) || (replace && existing === null)) {
    fail("promotion-transaction-recovery-required");
  }
  if (replace) {
    parseBootstrap(
      await readPrivateJson(location.bootstrap, 16 * 1024),
      location,
      roots,
      stagingRoot,
      identity,
      key
    );
  }
  const unsigned = bootstrapUnsigned(location, roots, stagingRoot, identity, phase, outcome);
  const temporary = path.join(
    roots.migrationOutputRoot,
    `.editorial-promotion-${location.transactionId}.bootstrap.${randomBytes(16).toString("hex")}.tmp`
  );
  await writePrivateText(
    temporary,
    `${JSON.stringify({ ...unsigned, authentication: authenticatedJson(unsigned, key) })}\n`,
    "promotion-transaction-failed"
  );
  try {
    if (replace) {
      await rename(temporary, location.bootstrap);
      await syncDirectory(roots.migrationOutputRoot);
    } else {
      await link(temporary, location.bootstrap);
      await syncDirectory(roots.migrationOutputRoot);
      await unlink(temporary);
      await syncDirectory(roots.migrationOutputRoot);
    }
  } catch {
    fail("promotion-transaction-failed");
  }
}

function isBootstrapTemporaryName(location: TransactionLocation, name: string) {
  return new RegExp(
    `^\\.editorial-promotion-${location.transactionId}\\.bootstrap\\.[a-f0-9]{32}\\.tmp$`,
    "u"
  ).test(name);
}

function isJournalTemporaryName(name: string) {
  return /^\.journal\.[a-f0-9]{32}\.tmp$/u.test(name);
}

async function writeJournal(transaction: Transaction) {
  const generation = transaction.generation + 1;
  const unsigned = journalUnsigned(transaction, generation);
  const content = `${JSON.stringify({
    ...unsigned,
    authentication: authenticatedJson(unsigned, transaction.key)
  })}\n`;
  const current = await existingStats(transaction.journal);
  if (current === null && transaction.generation !== 0) {
    fail("invalid-promotion-journal");
  }
  if (
    current !== null
    && (
      !isRegularFile(current)
      || !isPrivateOwned(current)
      || (current.mode & 0o777) !== 0o600
    )
  ) {
    fail("promotion-transaction-failed");
  }
  const temporary = path.join(
    transaction.root,
    `.journal.${randomBytes(16).toString("hex")}.tmp`
  );
  await writePrivateText(temporary, content, "promotion-transaction-failed");
  try {
    await rename(temporary, transaction.journal);
    await syncDirectory(transaction.root);
    transaction.generation = generation;
  } catch {
    fail("promotion-transaction-failed");
  }
}

async function persistState(
  transaction: Transaction,
  phase: TransactionPhase,
  outcome: TransactionOutcome,
  injection?: Extract<
    FailureInjection,
    | "after-rollback-transaction-journal"
    | "after-cleanup-transaction-journal"
    | "after-prepared-transaction-journal"
    | "after-publishing-transaction-journal"
  >
) {
  const oldPhase = transaction.phase;
  const oldOutcome = transaction.outcome;
  transaction.phase = phase;
  transaction.outcome = outcome;
  try {
    await writeJournal(transaction);
  } catch (error) {
    transaction.phase = oldPhase;
    transaction.outcome = oldOutcome;
    throw error;
  }
  if (injection !== undefined) {
    interruptAt(transaction.failureInjection, injection);
  }
}

async function persistCleanupState(
  transaction: Transaction,
  outcome: Extract<TransactionOutcome, "committed" | "rolled-back">
) {
  await persistState(
    transaction,
    "cleanup",
    outcome,
    "after-cleanup-transaction-journal"
  );
  await writeBootstrap(
    transactionLocation(transaction.roots, transaction.stagingRoot),
    transaction.roots,
    transaction.stagingRoot,
    transaction.identity,
    transaction.key,
    "cleanup",
    outcome,
    true
  );
}

async function createTransaction(
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array,
  failureInjection: EditorialPublicationTestOptions["failureInjection"],
  artifacts: readonly StagedArtifactPlan[]
) {
  if (artifacts.length > maxJournalArtifacts) {
    fail("promotion-stage-failed");
  }
  const location = transactionLocation(roots, stagingRoot);
  await assertDirectoryChain(roots.repositoryRoot, roots.migrationOutputRoot, false);
  await writeBootstrap(location, roots, stagingRoot, identity, key);
  interruptAt(failureInjection, "after-transaction-bootstrap");
  try {
    await mkdir(location.root, { mode: 0o700 });
    await syncDirectory(roots.migrationOutputRoot);
  } catch {
    fail("promotion-transaction-recovery-required");
  }
  await assertPrivateDirectory(location.root);
  interruptAt(failureInjection, "after-transaction-root");
  try {
    await mkdir(location.records, { mode: 0o700 });
    await syncDirectory(location.root);
  } catch {
    fail("promotion-transaction-recovery-required");
  }
  await assertPrivateDirectory(location.records);
  interruptAt(failureInjection, "after-transaction-records-directory");
  try {
    await mkdir(location.backups, { mode: 0o700 });
    await syncDirectory(location.root);
  } catch {
    fail("promotion-transaction-recovery-required");
  }
  await assertPrivateDirectory(location.backups);
  interruptAt(failureInjection, "after-transaction-backups-directory");
  const transaction: Transaction = {
    roots,
    stagingRoot,
    identity,
    key,
    root: location.root,
    records: location.records,
    backups: location.backups,
    journal: location.journal,
    bootstrap: location.bootstrap,
    transactionId: location.transactionId,
    failureInjection,
    stagedArtifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      proof: null
    })),
    operations: [],
    phase: "setup",
    outcome: "pending",
    generation: 0,
    backupSequence: artifacts.length
  };
  await writeJournal(transaction);
  interruptAt(failureInjection, "after-initial-transaction-journal");
  return transaction;
}

async function boundedEntries(directory: string, maximum: number) {
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  const entries: Dirent[] = [];
  try {
    handle = await opendir(directory, { encoding: "utf8" });
    for await (const entry of handle) {
      if (entries.length >= maximum) {
        fail("invalid-promotion-journal");
      }
      entries.push(entry);
    }
    return entries;
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("invalid-promotion-journal");
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        if (
          error === null
          || typeof error !== "object"
          || !("code" in error)
          || error.code !== "ERR_DIR_CLOSED"
        ) {
          throw error;
        }
      }
    }
  }
}

async function matchesStagedArtifact(target: string, artifact: StagedArtifact) {
  const stats = await existingStats(target);
  if (
    stats === null
    || !isRegularFile(stats)
    || !isOwnedByCurrentUser(stats)
    || (stats.mode & 0o777) !== 0o644
  ) {
    return false;
  }
  return artifact.proof === null
    ? digestMatches(target, artifact)
    : proofMatches(target, artifact.proof);
}

async function validateTransactionTree(location: TransactionLocation, journal: PromotionJournal) {
  await assertPrivateDirectory(location.root);
  const journalStats = await existingStats(location.journal);
  if (
    journalStats === null
    || !isRegularFile(journalStats)
    || !isPrivateOwned(journalStats)
    || (journalStats.mode & 0o777) !== 0o600
  ) {
    fail("invalid-promotion-journal");
  }
  const recordsStats = await existingStats(location.records);
  const backupStats = await existingStats(location.backups);
  for (const stats of [recordsStats, backupStats]) {
    if (
      stats !== null
      && (
        stats.isSymbolicLink()
        || !stats.isDirectory()
        || !isPrivateOwned(stats)
        || (stats.mode & 0o777) !== 0o700
      )
    ) {
      fail("invalid-promotion-journal");
    }
  }
  if (journal.phase !== "cleanup" && (recordsStats === null || backupStats === null)) {
    fail("invalid-promotion-journal");
  }
  const rootEntries = await boundedEntries(location.root, maxJournalOperations + 3);
  const allowed = new Set([
    "journal.json",
    ...(recordsStats === null ? [] : ["records"]),
    ...(backupStats === null ? [] : ["backups"])
  ]);
  if (
    rootEntries.length !== allowed.size
    || rootEntries.some((entry) =>
      entry.isSymbolicLink()
      || !allowed.has(entry.name)
      || (entry.name === "journal.json" ? !entry.isFile() : !entry.isDirectory())
    )
  ) {
    fail("invalid-promotion-journal");
  }

  const artifacts = new Map(journal.stagedArtifacts.map((artifact) => [artifact.name, artifact]));
  if (recordsStats !== null) {
    const entries = await boundedEntries(location.records, maxJournalArtifacts + 1);
    for (const entry of entries) {
      const artifact = artifacts.get(entry.name);
      if (
        artifact === undefined
        || entry.isSymbolicLink()
        || !entry.isFile()
        || !await matchesStagedArtifact(path.join(location.records, entry.name), artifact)
      ) {
        fail("invalid-promotion-journal");
      }
    }
    if (
      journal.phase !== "cleanup"
      && [...artifacts.values()].some((artifact) =>
        artifact.proof !== null
        && !entries.some((entry) => entry.name === artifact.name)
      )
    ) {
      fail("invalid-promotion-journal");
    }
  }

  const expectedBackups = new Map<string, FileProof>();
  for (const operation of journal.operations) {
    if (operation.kind !== "create") {
      expectedBackups.set(path.basename(operation.backup), operation.backupProof);
    }
  }
  if (backupStats !== null) {
    const entries = await boundedEntries(location.backups, maxJournalOperations + 1);
    for (const entry of entries) {
      const proof = expectedBackups.get(entry.name);
      if (
        proof === undefined
        || entry.isSymbolicLink()
        || !entry.isFile()
        || !await proofMatches(path.join(location.backups, entry.name), proof)
      ) {
        fail("invalid-promotion-journal");
      }
    }
  }
}

function transactionFromJournal(
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array,
  location: TransactionLocation,
  journal: PromotionJournal,
  failureInjection: EditorialPublicationTestOptions["failureInjection"]
): Transaction {
  return {
    roots,
    stagingRoot,
    identity,
    key,
    root: location.root,
    records: location.records,
    backups: location.backups,
    journal: location.journal,
    bootstrap: location.bootstrap,
    transactionId: location.transactionId,
    failureInjection,
    stagedArtifacts: journal.stagedArtifacts.map((artifact) => ({ ...artifact })),
    operations: journal.operations.map((operation) => ({ ...operation })),
    phase: journal.phase,
    outcome: journal.outcome,
    generation: journal.generation,
    backupSequence: journal.stagedArtifacts.length
  };
}

type RecoveryAction = {
  readonly operation: TransactionOperation;
  readonly action: "none" | "preserve-conflict" | "remove-created" | "restore";
};

async function inspectRecoveryOperation(operation: TransactionOperation): Promise<RecoveryAction> {
  const destination = await existingStats(operation.destination);
  if (
    destination !== null
    && (!isRegularFile(destination) || !isOwnedByCurrentUser(destination))
  ) {
    fail("invalid-promotion-journal");
  }
  if (operation.kind === "create") {
    if (destination === null) {
      return { operation, action: "none" };
    }
    if (await proofMatches(operation.destination, operation.stagedProof)) {
      return { operation, action: "remove-created" };
    }
    if (operation.state === "prepared" || operation.state === "rolled-back") {
      return { operation, action: "preserve-conflict" };
    }
    fail("invalid-promotion-journal");
  }
  const backup = await existingStats(operation.backup);
  if (
    backup !== null
    && (
      !isRegularFile(backup)
      || !isOwnedByCurrentUser(backup)
      || !await proofMatches(operation.backup, operation.backupProof)
    )
  ) {
    fail("invalid-promotion-journal");
  }
  if (operation.kind === "remove") {
    if (backup !== null) {
      if (destination !== null) {
        fail("invalid-promotion-journal");
      }
      return { operation, action: "restore" };
    }
    if (destination !== null && await proofMatches(operation.destination, operation.backupProof)) {
      return { operation, action: "none" };
    }
    fail("invalid-promotion-journal");
  }
  if (backup !== null) {
    if (destination !== null && !await proofMatches(operation.destination, operation.stagedProof)) {
      fail("invalid-promotion-journal");
    }
    return { operation, action: "restore" };
  }
  if (destination !== null && await proofMatches(operation.destination, operation.backupProof)) {
    return { operation, action: "none" };
  }
  fail("invalid-promotion-journal");
}

async function executeRecoveryAction(
  action: RecoveryAction,
  failureInjection: EditorialPublicationTestOptions["failureInjection"]
) {
  if (action.action === "none" || action.action === "preserve-conflict") {
    return;
  }
  const { operation } = action;
  if (operation.kind === "create") {
    if (!await proofMatches(operation.destination, operation.stagedProof)) {
      fail("promotion-journal-recovery-failed");
    }
    await unlink(operation.destination);
    await syncDirectory(path.dirname(operation.destination));
    interruptAt(failureInjection, "after-rollback-create-unlink");
    return;
  }
  const backup = await existingStats(operation.backup);
  if (
    backup === null
    || !isRegularFile(backup)
    || !await proofMatches(operation.backup, operation.backupProof)
  ) {
    fail("promotion-journal-recovery-failed");
  }
  const destination = await existingStats(operation.destination);
  if (operation.kind === "remove") {
    if (destination !== null) {
      fail("promotion-journal-recovery-failed");
    }
    await rename(operation.backup, operation.destination);
    await syncDirectories([path.dirname(operation.destination), path.dirname(operation.backup)]);
    interruptAt(failureInjection, "after-rollback-backup-rename");
    return;
  }
  if (destination !== null) {
    if (!isRegularFile(destination) || !await proofMatches(operation.destination, operation.stagedProof)) {
      fail("promotion-journal-recovery-failed");
    }
    await unlink(operation.destination);
    await syncDirectory(path.dirname(operation.destination));
    interruptAt(failureInjection, "after-rollback-replacement-unlink");
  }
  await rename(operation.backup, operation.destination);
  await syncDirectories([path.dirname(operation.destination), path.dirname(operation.backup)]);
  interruptAt(failureInjection, "after-rollback-backup-rename");
}

async function rollbackOperation(transaction: Transaction, operation: TransactionOperation) {
  const action = await inspectRecoveryOperation(operation);
  await executeRecoveryAction(action, transaction.failureInjection);
  operation.state = "rolled-back";
  await writeJournal(transaction);
  if (action.action === "preserve-conflict") {
    interruptAt(transaction.failureInjection, "after-rollback-preserved-create-journal");
  }
}

async function rollbackTransaction(transaction: Transaction) {
  try {
    for (const operation of transaction.operations) {
      await inspectRecoveryOperation(operation);
    }
    if (transaction.phase !== "rollback") {
      await persistState(
        transaction,
        "rollback",
        "pending",
        "after-rollback-transaction-journal"
      );
    }
    for (const operation of [...transaction.operations].reverse()) {
      await rollbackOperation(transaction, operation);
    }
  } catch (error) {
    if (error instanceof EditorialPublicationInterruption || error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-rollback-failed");
  }
}

async function assertFinalLiveState(transaction: Transaction) {
  if (transaction.phase !== "cleanup") {
    fail("promotion-journal-recovery-failed");
  }
  for (const operation of transaction.operations) {
    if (transaction.outcome === "committed") {
      if (operation.state !== "published") {
        fail("promotion-journal-recovery-failed");
      }
      if (operation.kind === "remove") {
        if (await existingStats(operation.destination) !== null) {
          fail("promotion-journal-recovery-failed");
        }
        const backup = await existingStats(operation.backup);
        if (backup !== null && !await proofMatches(operation.backup, operation.backupProof)) {
          fail("promotion-journal-recovery-failed");
        }
      } else if (!await proofMatches(operation.destination, operation.stagedProof)) {
        fail("promotion-journal-recovery-failed");
      }
    } else if (
      transaction.outcome !== "rolled-back"
      || operation.state !== "rolled-back"
    ) {
      fail("promotion-journal-recovery-failed");
    } else if (operation.kind === "create") {
      const destination = await existingStats(operation.destination);
      if (
        destination !== null
        && (
          !isRegularFile(destination)
          || !isOwnedByCurrentUser(destination)
          || await proofMatches(operation.destination, operation.stagedProof)
        )
      ) {
        fail("promotion-journal-recovery-failed");
      }
    } else if (!await proofMatches(operation.destination, operation.backupProof)) {
      fail("promotion-journal-recovery-failed");
    }
  }
}

async function removeTransactionTree(transaction: Transaction) {
  if (
    transaction.phase !== "cleanup"
    || (transaction.outcome !== "committed" && transaction.outcome !== "rolled-back")
  ) {
    fail("promotion-transaction-cleanup-failed");
  }
  const location = transactionLocation(transaction.roots, transaction.stagingRoot);
  try {
    await assertPrivateDirectory(location.root);
    const bootstrap = parseBootstrap(
      await readPrivateJson(location.bootstrap, 16 * 1024),
      location,
      transaction.roots,
      transaction.stagingRoot,
      transaction.identity,
      transaction.key
    );
    const journal = parseJournal(
      await readPrivateJson(location.journal, maxJournalBytes),
      location,
      transaction.roots,
      transaction.stagingRoot,
      transaction.identity,
      transaction.key,
      bootstrap
    );
    if (
      journal.phase !== "cleanup"
      || journal.outcome !== transaction.outcome
      || journal.generation !== transaction.generation
    ) {
      fail("promotion-transaction-cleanup-failed");
    }
    await validateTransactionTree(location, journal);
    await assertFinalLiveState(transaction);
    const artifacts = new Map(journal.stagedArtifacts.map((artifact) => [artifact.name, artifact]));
    const recordsStats = await existingStats(location.records);
    if (recordsStats !== null) {
      const entries = await boundedEntries(location.records, maxJournalArtifacts + 1);
      for (const entry of entries) {
        const artifact = artifacts.get(entry.name);
        const target = path.join(location.records, entry.name);
        if (
          artifact === undefined
          || entry.isSymbolicLink()
          || !entry.isFile()
          || !await matchesStagedArtifact(target, artifact)
        ) {
          fail("promotion-transaction-cleanup-failed");
        }
        await unlink(target);
        await syncDirectory(location.records);
        interruptAt(transaction.failureInjection, "after-cleanup-staged-unlink");
      }
      await rmdir(location.records);
      await syncDirectory(location.root);
    }
    const expectedBackups = new Map<string, FileProof>();
    for (const operation of journal.operations) {
      if (operation.kind !== "create") {
        expectedBackups.set(path.basename(operation.backup), operation.backupProof);
      }
    }
    const backupStats = await existingStats(location.backups);
    if (backupStats !== null) {
      const entries = await boundedEntries(location.backups, maxJournalOperations + 1);
      for (const entry of entries) {
        const proof = expectedBackups.get(entry.name);
        const target = path.join(location.backups, entry.name);
        if (
          proof === undefined
          || entry.isSymbolicLink()
          || !entry.isFile()
          || !await proofMatches(target, proof)
        ) {
          fail("promotion-transaction-cleanup-failed");
        }
        await unlink(target);
        await syncDirectory(location.backups);
        interruptAt(transaction.failureInjection, "after-cleanup-backup-unlink");
      }
      await rmdir(location.backups);
      await syncDirectory(location.root);
    }
    await unlink(location.journal);
    await syncDirectory(location.root);
    interruptAt(transaction.failureInjection, "after-cleanup-journal-unlink");
    if ((await boundedEntries(location.root, 1)).length !== 0) {
      fail("promotion-transaction-cleanup-failed");
    }
    await rmdir(location.root);
    await syncDirectory(transaction.roots.migrationOutputRoot);
    if (bootstrap.phase !== "cleanup" || bootstrap.outcome !== transaction.outcome) {
      fail("promotion-transaction-cleanup-failed");
    }
    await unlink(location.bootstrap);
    await syncDirectory(transaction.roots.migrationOutputRoot);
  } catch (error) {
    if (error instanceof EditorialPublicationInterruption || error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-transaction-cleanup-failed");
  }
}

async function removeBootstrapOnlyTransaction(
  location: TransactionLocation,
  roots: Roots,
  bootstrap: PromotionBootstrap
) {
  const rootStats = await existingStats(location.root);
  if (rootStats === null) {
    if (
      bootstrap.phase !== "setup"
      && (
        bootstrap.phase !== "cleanup"
        || (bootstrap.outcome !== "committed" && bootstrap.outcome !== "rolled-back")
      )
    ) {
      fail("invalid-promotion-journal");
    }
    await unlink(location.bootstrap);
    await syncDirectory(roots.migrationOutputRoot);
    return;
  }
  await assertPrivateDirectory(location.root);
  if (await existingStats(location.journal) !== null) {
    fail("invalid-promotion-journal");
  }
  if (bootstrap.phase === "cleanup") {
    if ((await boundedEntries(location.root, 1)).length !== 0) {
      fail("invalid-promotion-journal");
    }
    await rmdir(location.root);
    await syncDirectory(roots.migrationOutputRoot);
    await unlink(location.bootstrap);
    await syncDirectory(roots.migrationOutputRoot);
    return;
  }
  for (const name of ["records", "backups"] as const) {
    const directory = path.join(location.root, name);
    const stats = await existingStats(directory);
    if (stats === null) {
      continue;
    }
    await assertPrivateDirectory(directory);
    if ((await boundedEntries(directory, 1)).length !== 0) {
      fail("invalid-promotion-journal");
    }
    await rmdir(directory);
    await syncDirectory(location.root);
  }
  if ((await boundedEntries(location.root, 1)).length !== 0) {
    fail("invalid-promotion-journal");
  }
  await rmdir(location.root);
  await syncDirectory(roots.migrationOutputRoot);
  if (bootstrap.phase !== "setup" || bootstrap.outcome !== "pending") {
    fail("invalid-promotion-journal");
  }
  await unlink(location.bootstrap);
  await syncDirectory(roots.migrationOutputRoot);
}

async function removeAuthenticatedBootstrapTemps(
  location: TransactionLocation,
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array
) {
  for (const entry of await boundedEntries(roots.migrationOutputRoot, 4_096)) {
    if (!isBootstrapTemporaryName(location, entry.name)) {
      continue;
    }
    const target = path.join(roots.migrationOutputRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail("invalid-promotion-journal");
    }
    parseBootstrap(
      await readPrivateJson(target, 16 * 1024),
      location,
      roots,
      stagingRoot,
      identity,
      key
    );
    await unlink(target);
    await syncDirectory(roots.migrationOutputRoot);
  }
}

async function removeAuthenticatedJournalTemps(
  location: TransactionLocation,
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array,
  bootstrap: PromotionBootstrap
) {
  for (const entry of await boundedEntries(location.root, maxJournalOperations + 4)) {
    if (!isJournalTemporaryName(entry.name)) {
      continue;
    }
    const target = path.join(location.root, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail("invalid-promotion-journal");
    }
    parseJournal(
      await readPrivateJson(target, maxJournalBytes),
      location,
      roots,
      stagingRoot,
      identity,
      key,
      bootstrap
    );
    await unlink(target);
    await syncDirectory(location.root);
  }
}

async function validateRecoveryDomain(roots: Roots, recipeRecords: readonly RecipeRecord[]) {
  try {
    const recipes = loadRecipeCatalogWithSources(path.join(roots.contentRoot, "recipes")).records;
    if (!canonicalEquals(recipes, recipeRecords)) {
      fail("recipe-catalog-changed");
    }
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-journal-recovery-failed");
  }
}

async function recoverTransaction(
  roots: Roots,
  stagingRoot: string,
  identity: TransactionIdentity,
  key: Uint8Array,
  recipeRecords: readonly RecipeRecord[],
  failureInjection: EditorialPublicationTestOptions["failureInjection"]
) {
  const location = transactionLocation(roots, stagingRoot);
  try {
    await removeAuthenticatedBootstrapTemps(location, roots, stagingRoot, identity, key);
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw new EditorialPublicationError("invalid-promotion-journal");
    }
    fail("invalid-promotion-journal");
  }
  const bootstrapStats = await existingStats(location.bootstrap);
  const rootStats = await existingStats(location.root);
  if (bootstrapStats === null && rootStats === null) {
    return;
  }
  if (bootstrapStats === null) {
    fail("invalid-promotion-journal");
  }
  let bootstrap: PromotionBootstrap;
  try {
    bootstrap = parseBootstrap(
      await readPrivateJson(location.bootstrap, 16 * 1024),
      location,
      roots,
      stagingRoot,
      identity,
      key
    );
  } catch {
    fail("invalid-promotion-journal");
  }
  if (rootStats === null) {
    if (bootstrap.phase === "cleanup") {
      await validateRecoveryDomain(roots, recipeRecords);
    }
    await removeBootstrapOnlyTransaction(location, roots, bootstrap);
    return;
  }
  const journalStats = await existingStats(location.journal);
  if (journalStats === null) {
    await assertPrivateDirectory(location.root);
    await removeAuthenticatedJournalTemps(
      location,
      roots,
      stagingRoot,
      identity,
      key,
      bootstrap
    );
    if (bootstrap.phase === "cleanup") {
      await validateRecoveryDomain(roots, recipeRecords);
    }
    await removeBootstrapOnlyTransaction(location, roots, bootstrap);
    return;
  }
  let journal: PromotionJournal;
  try {
    await assertPrivateDirectory(location.root);
    journal = parseJournal(
      await readPrivateJson(location.journal, maxJournalBytes),
      location,
      roots,
      stagingRoot,
      identity,
      key,
      bootstrap
    );
    await removeAuthenticatedJournalTemps(
      location,
      roots,
      stagingRoot,
      identity,
      key,
      bootstrap
    );
    await validateTransactionTree(location, journal);
    for (const operation of journal.operations) {
      await assertDirectoryChain(roots.repositoryRoot, path.dirname(operation.destination), false);
    }
  } catch {
    fail("invalid-promotion-journal");
  }
  const transaction = transactionFromJournal(
    roots,
    stagingRoot,
    identity,
    key,
    location,
    journal,
    failureInjection
  );
  try {
    if (transaction.phase === "cleanup") {
      await assertFinalLiveState(transaction);
      await validateRecoveryDomain(roots, recipeRecords);
      await removeTransactionTree(transaction);
      return;
    }
    for (const operation of transaction.operations) {
      await inspectRecoveryOperation(operation);
    }
    if (transaction.phase !== "rollback") {
      await persistState(
        transaction,
        "rollback",
        "pending",
        "after-rollback-transaction-journal"
      );
    }
    for (const operation of [...transaction.operations].reverse()) {
      await rollbackOperation(transaction, operation);
    }
    await validateRecoveryDomain(roots, recipeRecords);
    await persistCleanupState(transaction, "rolled-back");
    await removeTransactionTree(transaction);
  } catch (error) {
    if (error instanceof EditorialPublicationInterruption || error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-journal-recovery-failed");
  }
}

async function assertPromotionDomain(roots: Roots, stagingRoot: string) {
  const location = transactionLocation(roots, stagingRoot);
  for (const entry of await boundedEntries(roots.migrationOutputRoot, 4_096)) {
    if (
      entry.name === promotionLockName
      || entry.name === path.basename(stagingRoot)
    ) {
      continue;
    }
    if (!entry.name.startsWith(".editorial-promotion-")) {
      continue;
    }
    if (
      entry.name !== path.basename(location.root)
      && entry.name !== path.basename(location.bootstrap)
      && !isBootstrapTemporaryName(location, entry.name)
    ) {
      fail("promotion-transaction-recovery-required");
    }
  }
}

type PlannedRecord = {
  readonly record: EditorialPageRecord;
  readonly destination: string;
  readonly action: "create" | "reuse";
};

type PlannedRemoval = {
  readonly record: EditorialPageRecord;
  readonly destination: string;
};

type PlannedGallery = {
  readonly record: GalleryRecord;
  readonly destination: string;
  readonly action: "create" | "reuse";
} | null;

function editorialDestination(record: EditorialPageRecord, roots: Roots) {
  const fileName = `${record.source.postId}.json`;
  const directory = path.join(roots.editorialRoot, record.locale);
  const destination = path.resolve(directory, fileName);
  if (
    !/^[1-9]\d*\.json$/u.test(fileName)
    || !isWithin(destination, directory)
  ) {
    fail("unsafe-content-destination");
  }
  return destination;
}

function galleryDestination(record: GalleryRecord, roots: Roots) {
  const fileName = `${record.source.galleryId}.json`;
  const destination = path.resolve(roots.galleryRoot, fileName);
  if (!/^[1-9]\d*\.json$/u.test(fileName) || !isWithin(destination, roots.galleryRoot)) {
    fail("unsafe-content-destination");
  }
  return destination;
}

function routeKey(record: EditorialPageRecord) {
  return record.canonicalPath;
}

async function planRecords(
  records: readonly EditorialPageRecord[],
  publicationExcludedRecordIds: readonly string[],
  roots: Roots
): Promise<{
  readonly existing: readonly EditorialPageRecord[];
  readonly planned: readonly PlannedRecord[];
  readonly removals: readonly PlannedRemoval[];
  readonly retained: readonly EditorialPageRecord[];
}> {
  let loaded;
  try {
    loaded = loadEditorialCatalogWithSources(roots.editorialRoot);
  } catch {
    fail("editorial-content-collision");
  }
  const existingById = new Map(loaded.records.map((record, index) => [
    record.id,
    { record, destination: loaded.files[index]!.path }
  ]));
  const existingByRoute = new Map(loaded.records.map((record, index) => [
    routeKey(record),
    { record, destination: loaded.files[index]!.path }
  ]));
  const excluded = new Set(publicationExcludedRecordIds);
  if (
    excluded.size !== publicationExcludedRecordIds.length
    || [...excluded].some((id) => !/^wordpress:page:[1-9]\d*$/u.test(id))
  ) {
    fail("editorial-content-collision");
  }
  const removals = [...excluded]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((id): PlannedRemoval[] => {
      const existing = existingById.get(id);
      if (existing === undefined) {
        return [];
      }
      if (existing.record.id !== `wordpress:page:${existing.record.source.postId}`) {
        fail("editorial-content-collision");
      }
      if (!isAllowedEditorialLivePath(roots, existing.destination)) {
        fail("editorial-content-collision");
      }
      return [{
        record: existing.record,
        destination: existing.destination
      }];
    });
  const ids = new Set<string>();
  const routes = new Set<string>();
  const destinations = new Set<string>();
  const planned: PlannedRecord[] = [];
  for (const record of records) {
    const destination = editorialDestination(record, roots);
    if (
      excluded.has(record.id)
      || ids.has(record.id)
      || routes.has(routeKey(record))
      || destinations.has(destination)
    ) {
      fail("editorial-content-collision");
    }
    ids.add(record.id);
    routes.add(routeKey(record));
    destinations.add(destination);
    const existing = existingById.get(record.id) ?? existingByRoute.get(routeKey(record));
    if (existing !== undefined) {
      if (excluded.has(existing.record.id) || !canonicalEquals(existing.record, record)) {
        fail("editorial-content-collision");
      }
      planned.push({ record, destination: existing.destination, action: "reuse" });
      continue;
    }
    const stats = await existingStats(destination);
    if (stats !== null) {
      if (!isRegularFile(stats)) {
        fail("destination-file-conflict");
      }
      try {
        const parsed = await readRegularJson(destination);
        if (!canonicalEquals(parsed, record)) {
          fail("destination-file-conflict");
        }
      } catch (error) {
        if (error instanceof EditorialPublicationError) {
          throw error;
        }
        fail("destination-file-conflict");
      }
      planned.push({ record, destination, action: "reuse" });
      continue;
    }
    planned.push({ record, destination, action: "create" });
  }
  return {
    existing: loaded.records,
    planned,
    removals,
    retained: loaded.records.filter((record) => !excluded.has(record.id))
  };
}

async function planGallery(
  gallery: GalleryRecord | null,
  roots: Roots
): Promise<{ readonly planned: PlannedGallery; readonly existing: readonly GalleryRecord[] }> {
  let loaded;
  try {
    loaded = loadGalleryCatalogWithSources(roots.galleryRoot);
  } catch {
    fail("gallery-content-collision");
  }
  if (gallery === null) {
    return { planned: null, existing: loaded.records };
  }
  const destination = galleryDestination(gallery, roots);
  const existing = loaded.records[0];
  if (existing !== undefined) {
    if (!canonicalEquals(existing, gallery)) {
      fail("gallery-content-collision");
    }
    return {
      planned: {
        record: gallery,
        destination: loaded.files[0]!.path,
        action: "reuse"
      },
      existing: loaded.records
    };
  }
  const stats = await existingStats(destination);
  if (stats !== null) {
    if (!isRegularFile(stats)) {
      fail("destination-file-conflict");
    }
    try {
      if (!canonicalEquals(await readRegularJson(destination), gallery)) {
        fail("destination-file-conflict");
      }
    } catch (error) {
      if (error instanceof EditorialPublicationError) {
        throw error;
      }
      fail("destination-file-conflict");
    }
    return { planned: { record: gallery, destination, action: "reuse" }, existing: [] };
  }
  return { planned: { record: gallery, destination, action: "create" }, existing: [] };
}

function prospectiveEditorial(
  existing: readonly EditorialPageRecord[],
  planned: readonly PlannedRecord[]
) {
  const selected = new Set(planned.map((entry) => entry.record.id));
  return [
    ...existing.filter((record) => !selected.has(record.id)),
    ...planned.map((entry) => entry.record)
  ];
}

function prospectiveGalleries(existing: readonly GalleryRecord[], planned: PlannedGallery) {
  return planned === null ? existing : [planned.record];
}

function plannedPublicMedia(
  records: readonly EditorialPageRecord[],
  galleries: readonly GalleryRecord[]
) {
  const media = new Map<string, PublicMediaObject>();
  for (const object of [
    ...records.flatMap((record) => record.media ?? []),
    ...galleries.flatMap((record) => record.media ?? [])
  ]) {
    const existing = media.get(object.path);
    if (existing !== undefined && !canonicalEquals(existing, object)) {
      fail("editorial-media-collision");
    }
    media.set(object.path, object);
  }
  return media;
}

export type AuthenticatedEditorialMediaUploadPlan = {
  readonly entries: readonly EditorialGalleryMediaManifestEntry[];
  readonly repositoryRoot: string;
  copyToPrivateFile(key: string, destination: string): Promise<void>;
};

async function withAuthenticatedEditorialMediaEntries<T>(
  input: EditorialPublicationInput,
  selectedMedia: ReadonlyMap<string, PublicMediaObject>,
  callback: (plan: AuthenticatedEditorialMediaUploadPlan) => Promise<T>
): Promise<T> {
  const bindingByPath = new Map<string, EditorialPlannedMediaBinding>();
  for (const binding of input.plan.mediaBindings) {
    const object = selectedMedia.get(binding.publicPath);
    const existing = bindingByPath.get(binding.publicPath);
    if (object === undefined || existing !== undefined) {
      fail("editorial-media-binding-mismatch");
    }
    const sourceId = object.source.system === "wordpress"
      ? String(object.source.attachmentId)
      : String(object.source.imageId);
    const expectedKind = object.source.system === "wordpress"
      ? "wordpress-attachment"
      : "wordpress-bwg-image";
    if (binding.sourceId !== sourceId || binding.sourceKind !== expectedKind) {
      fail("editorial-media-binding-mismatch");
    }
    bindingByPath.set(binding.publicPath, binding);
  }
  if (bindingByPath.size !== selectedMedia.size) {
    fail("editorial-media-binding-mismatch");
  }
  let archivePaths: readonly string[];
  try {
    archivePaths = await resolveEditorialUploadArchives(input.uploadsDir, input.uploadArchives);
  } catch {
    fail("media-source-verification-failed");
  }
  const archives = new Map<number, VerifiedUploadArchive>();
  let callbackStarted = false;
  try {
    const currentInventories = await inventoryUploadArchives(archivePaths);
    for (const binding of bindingByPath.values()) {
      const inventory = currentInventories.summaries[binding.archiveIndex];
      if (
        inventory === undefined
        || inventory.index !== binding.archiveIndex
        || !fixedEqual(inventory.archiveSha256, binding.archiveSha256)
        || !fixedEqual(
          inventory.entryIndexContractSha256,
          binding.entryIndexContractSha256
        )
      ) {
        fail("media-source-verification-failed");
      }
    }
    const indexes = [...new Set(
      [...bindingByPath.values()].map((binding) => binding.archiveIndex)
    )].sort((left, right) => left - right);
    for (const index of indexes) {
      const archive = archivePaths[index];
      if (archive === undefined) {
        fail("editorial-media-binding-mismatch");
      }
      archives.set(index, await openVerifiedUploadArchive(archive));
    }
    const entries: EditorialGalleryMediaManifestEntry[] = [];
    const verifiedByKey = new Map<string, {
      readonly bytes: number;
      readonly keyedSha256: string;
      readonly sha256: string;
    }>();
    for (const key of [...bindingByPath.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      const binding = bindingByPath.get(key);
      const object = selectedMedia.get(key);
      if (binding === undefined || object === undefined) {
        fail("editorial-media-binding-mismatch");
      }
      const archive = archives.get(binding.archiveIndex);
      if (archive === undefined) {
        fail("editorial-media-binding-mismatch");
      }
      const keyedDigest = {
        key: input.fingerprintKey,
        context: `${binding.sourceKind}:${binding.sourceId}:${binding.publicPath}`
      };
      const sourceDimensions = binding.width === null || binding.height === null
        ? null
        : { width: binding.width, height: binding.height };
      const authenticated = sourceDimensions === null
        ? await (async () => {
            const headerChunks: Buffer[] = [];
            let headerBytes = 0;
            const sink = new Writable({
              write(chunk: Buffer, _encoding, done) {
                if (headerBytes < maxImageDimensionProbeBytes) {
                  const retained = chunk.subarray(
                    0,
                    maxImageDimensionProbeBytes - headerBytes
                  );
                  headerChunks.push(Buffer.from(retained));
                  headerBytes += retained.length;
                }
                done();
              }
            });
            const result = await archive.verifyEntry(binding.archivePath, sink, {
              keyedDigest
            });
            const parsedDimensions = await parseImageDimensions(
              Buffer.concat(headerChunks, headerBytes),
              object.mimeType
            );
            if (parsedDimensions === null) {
              fail("invalid-gallery-media-dimensions");
            }
            return { dimensions: parsedDimensions, verified: result };
          })()
        : {
            dimensions: sourceDimensions,
            verified: await hashVerifiedOpenUploadArchiveEntry(
              archive,
              binding.archivePath,
              { keyedDigest }
            )
          };
      const { dimensions: authenticatedDimensions, verified } = authenticated;
      if (verified.bytes <= 0 || verified.keyedSha256 === null) {
        fail("media-source-verification-failed");
      }
      verifiedByKey.set(key, {
        bytes: verified.bytes,
        keyedSha256: verified.keyedSha256,
        sha256: verified.sha256
      });
      entries.push({
        key,
        bytes: verified.bytes,
        sha256: verified.sha256,
        source: object.source,
        width: authenticatedDimensions.width,
        height: authenticatedDimensions.height
      });
    }
    callbackStarted = true;
    return await callback({
      entries,
      repositoryRoot: input.repositoryRoot,
      async copyToPrivateFile(key: string, destination: string) {
        const binding = bindingByPath.get(key);
        const expected = verifiedByKey.get(key);
        if (binding === undefined || expected === undefined) {
          fail("editorial-media-binding-mismatch");
        }
        const archive = archives.get(binding.archiveIndex);
        if (archive === undefined) {
          fail("editorial-media-binding-mismatch");
        }
        const copied = await copyVerifiedOpenUploadArchiveEntry(
          archive,
          binding.archivePath,
          destination,
          {
            keyedDigest: {
              key: input.fingerprintKey,
              context: `${binding.sourceKind}:${binding.sourceId}:${binding.publicPath}`
            }
          }
        );
        if (
          copied.keyedSha256 === null
          || copied.bytes !== expected.bytes
          || !fixedEqual(copied.keyedSha256, expected.keyedSha256)
          || !fixedEqual(copied.sha256, expected.sha256)
        ) {
          fail("editorial-media-binding-mismatch");
        }
      }
    });
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    if (callbackStarted) {
      throw error;
    }
    fail("media-source-verification-failed");
  } finally {
    await Promise.all([...archives.values()].map((archive) => archive.close()));
  }
}

type PlannedManifest = {
  readonly action: "create" | "replace" | "reuse";
  readonly destination: string;
  readonly expected: EditorialGalleryMediaManifest | null;
  readonly manifest: EditorialGalleryMediaManifest;
  readonly added: number;
  readonly removed: number;
  readonly reused: number;
  readonly updated: number;
};

function isDimensionEnrichment(
  existing: EditorialGalleryMediaManifestEntry,
  next: EditorialGalleryMediaManifestEntry
) {
  const {
    width: existingWidth,
    height: existingHeight,
    ...existingIdentity
  } = existing;
  const {
    width: nextWidth,
    height: nextHeight,
    ...nextIdentity
  } = next;
  return existingWidth === undefined
    && existingHeight === undefined
    && nextWidth !== undefined
    && nextHeight !== undefined
    && canonicalEquals(existingIdentity, nextIdentity);
}

async function planManifest(
  roots: Roots,
  input: EditorialPublicationInput,
  existingEditorial: readonly EditorialPageRecord[],
  existingGalleries: readonly GalleryRecord[],
  projectedEditorial: readonly EditorialPageRecord[],
  projectedGalleries: readonly GalleryRecord[],
  authenticated: readonly EditorialGalleryMediaManifestEntry[]
): Promise<PlannedManifest> {
  const stats = await existingStats(roots.mediaManifest);
  let existing: EditorialGalleryMediaManifest;
  let exists = false;
  if (stats === null) {
    existing = createEditorialGalleryMediaManifest([]);
  } else {
    if (!isRegularFile(stats)) {
      fail("editorial-media-manifest-conflict");
    }
    try {
      existing = loadEditorialGalleryMediaManifest(roots.mediaManifest);
      exists = true;
    } catch {
      fail("invalid-editorial-media-manifest");
    }
  }
  try {
    validateEditorialGalleryMediaManifestClosure(
      existingEditorial,
      existingGalleries,
      existing,
      { requireDimensions: false }
    );
  } catch {
    fail("invalid-editorial-media-manifest");
  }
  const projectedMedia = plannedPublicMedia(projectedEditorial, projectedGalleries);
  const selectedMedia = plannedPublicMedia(
    input.plan.records,
    input.plan.gallery === null ? [] : [input.plan.gallery]
  );
  for (const [key, object] of selectedMedia) {
    const projected = projectedMedia.get(key);
    if (projected === undefined || !canonicalEquals(projected, object)) {
      fail("editorial-media-collision");
    }
  }
  const entries = new Map(
    existing.entries
      .filter((entry) => projectedMedia.has(entry.key))
      .map((entry) => [entry.key, entry] as const)
  );
  let added = 0;
  const removed = existing.entries.length - entries.size;
  let reused = 0;
  let updated = 0;
  for (const entry of authenticated) {
    const old = entries.get(entry.key);
    if (old === undefined) {
      entries.set(entry.key, entry);
      added += 1;
    } else if (isDimensionEnrichment(old, entry)) {
      entries.set(entry.key, entry);
      updated += 1;
    } else if (!canonicalEquals(old, entry)) {
      fail("editorial-media-manifest-collision");
    } else {
      reused += 1;
    }
  }
  for (const [key, object] of projectedMedia) {
    const entry = entries.get(key);
    if (entry === undefined || !canonicalEquals(entry.source, object.source)) {
      fail("missing-editorial-media-manifest-entry");
    }
  }
  let manifest: EditorialGalleryMediaManifest;
  try {
    manifest = createEditorialGalleryMediaManifest([...entries.values()]);
    validateEditorialGalleryMediaManifestClosure(
      projectedEditorial,
      projectedGalleries,
      manifest
    );
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("invalid-editorial-media-manifest");
  }
  if (
    existing.entries.some((entry) => {
      const next = manifest.entries.find((candidate) => candidate.key === entry.key);
      return projectedMedia.has(entry.key)
        && (
          next === undefined
          || (!canonicalEquals(next, entry) && !isDimensionEnrichment(entry, next))
        );
    })
  ) {
    fail("editorial-media-manifest-collision");
  }
  return {
    action: !exists ? "create" : canonicalEquals(existing, manifest) ? "reuse" : "replace",
    destination: roots.mediaManifest,
    expected: exists ? existing : null,
    manifest,
    added,
    removed,
    reused,
    updated
  };
}

type StagedArtifactPlan = FileDigest & {
  readonly name: string;
  readonly destination: string;
  readonly content: string;
};

function artifactPlan(name: string, destination: string, content: string): StagedArtifactPlan {
  return {
    name,
    destination,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

type StagePlan = {
  readonly artifacts: readonly StagedArtifactPlan[];
  readonly records: ReadonlyMap<string, StagedArtifactPlan>;
  readonly gallery: StagedArtifactPlan | undefined;
  readonly mediaManifest: StagedArtifactPlan | undefined;
};

function createStagePlan(
  records: readonly PlannedRecord[],
  gallery: PlannedGallery,
  manifest: PlannedManifest
): StagePlan {
  const artifacts: StagedArtifactPlan[] = [];
  const stagedRecords = new Map<string, StagedArtifactPlan>();
  let sequence = 0;
  for (const entry of records) {
    if (entry.action === "reuse") {
      continue;
    }
    const artifact = artifactPlan(
      `${sequence += 1}.json`,
      entry.destination,
      `${JSON.stringify(entry.record, null, 2)}\n`
    );
    artifacts.push(artifact);
    stagedRecords.set(entry.destination, artifact);
  }
  let stagedGallery: StagedArtifactPlan | undefined;
  if (gallery !== null && gallery.action === "create") {
    stagedGallery = artifactPlan(
      `${sequence += 1}.json`,
      gallery.destination,
      `${JSON.stringify(gallery.record, null, 2)}\n`
    );
    artifacts.push(stagedGallery);
  }
  const stagedManifest = manifest.action === "reuse"
    ? undefined
    : artifactPlan(
      `${sequence += 1}.editorial-gallery-media-manifest.json`,
      manifest.destination,
      `${JSON.stringify(manifest.manifest, null, 2)}\n`
    );
  if (stagedManifest !== undefined) {
    artifacts.push(stagedManifest);
  }
  return {
    artifacts,
    records: stagedRecords,
    gallery: stagedGallery,
    mediaManifest: stagedManifest
  };
}

async function writeStagedText(destination: string, content: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o644);
    await handle.sync();
  } catch (error) {
    if (created) {
      try {
        await unlink(destination);
        await syncDirectory(path.dirname(destination));
      } catch {
        // Preserve the staging failure.
      }
    }
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-stage-failed");
  } finally {
    await handle?.close();
  }
}

type StagedPlan = {
  readonly records: ReadonlyMap<string, string>;
  readonly gallery: string | undefined;
  readonly mediaManifest: string | undefined;
};

async function stagePlan(transaction: Transaction, plan: StagePlan): Promise<StagedPlan> {
  const records = new Map<string, string>();
  let gallery: string | undefined;
  let mediaManifest: string | undefined;
  for (const artifactPlan of plan.artifacts) {
    const artifact = transaction.stagedArtifacts.find((item) => item.name === artifactPlan.name);
    if (artifact === undefined || artifact.proof !== null) {
      fail("promotion-stage-failed");
    }
    const staged = path.join(transaction.records, artifactPlan.name);
    await writeStagedText(staged, artifactPlan.content);
    await syncDirectory(transaction.records);
    interruptAt(transaction.failureInjection, "after-staged-artifact-write");
    const proof = await hashRegularFile(staged);
    if (
      proof.bytes !== artifactPlan.bytes
      || !fixedEqual(proof.sha256, artifactPlan.sha256)
    ) {
      fail("promotion-stage-failed");
    }
    artifact.proof = proof;
    await writeJournal(transaction);
    if (plan.records.has(artifactPlan.destination)) {
      records.set(artifactPlan.destination, staged);
    } else if (plan.gallery?.destination === artifactPlan.destination) {
      gallery = staged;
    } else if (plan.mediaManifest?.destination === artifactPlan.destination) {
      mediaManifest = staged;
    } else {
      fail("promotion-stage-failed");
    }
  }
  return { records, gallery, mediaManifest };
}

async function stagedProof(transaction: Transaction, staged: string) {
  const name = relativeTransactionFile(
    staged,
    transaction.records,
    /^\d+\.(?:json|editorial-gallery-media-manifest\.json)$/u
  );
  const artifact = name === null
    ? undefined
    : transaction.stagedArtifacts.find((item) => item.name === name);
  if (
    artifact === undefined
    || artifact.proof === null
    || !await matchesStagedArtifact(staged, artifact)
  ) {
    fail("promotion-stage-failed");
  }
  return artifact.proof;
}

async function publishCreate(transaction: Transaction, staged: string, destination: string) {
  const stagedFileProof = await stagedProof(transaction, staged);
  await assertDirectoryChain(transaction.roots.repositoryRoot, path.dirname(destination), false);
  if (await existingStats(destination) !== null) {
    fail("destination-file-conflict");
  }
  const operation: TransactionOperation = {
    kind: "create",
    destination,
    staged,
    stagedProof: stagedFileProof,
    state: "prepared"
  };
  transaction.operations.push(operation);
  await writeJournal(transaction);
  interruptAt(transaction.failureInjection, "before-create-link");
  try {
    await link(staged, destination);
    await syncDirectory(path.dirname(destination));
  } catch {
    fail("destination-file-conflict");
  }
  interruptAt(transaction.failureInjection, "after-create-link");
  operation.state = "published";
  await writeJournal(transaction);
}

async function publishRemoval(transaction: Transaction, removal: PlannedRemoval) {
  let existing: unknown;
  try {
    existing = await readRegularJson(removal.destination);
  } catch {
    fail("editorial-content-collision");
  }
  if (!canonicalEquals(existing, removal.record)) {
    fail("editorial-content-collision");
  }
  const backupProof = await hashRegularFile(removal.destination);
  const backup = path.join(
    transaction.backups,
    `${transaction.backupSequence += 1}.removal`
  );
  const operation: TransactionOperation = {
    kind: "remove",
    destination: removal.destination,
    backup,
    backupProof,
    state: "prepared"
  };
  transaction.operations.push(operation);
  await writeJournal(transaction);
  try {
    await rename(removal.destination, backup);
    await syncDirectories([path.dirname(removal.destination), transaction.backups]);
  } catch {
    fail("editorial-content-removal-failed");
  }
  operation.state = "published";
  await writeJournal(transaction);
}

async function publishReplacement(
  transaction: Transaction,
  staged: string,
  manifest: PlannedManifest
) {
  if (manifest.expected === null || manifest.action !== "replace") {
    fail("editorial-media-manifest-conflict");
  }
  let existing: EditorialGalleryMediaManifest;
  try {
    existing = parseEditorialGalleryMediaManifest(await readRegularJson(manifest.destination));
  } catch {
    fail("editorial-media-manifest-conflict");
  }
  if (!canonicalEquals(existing, manifest.expected)) {
    fail("editorial-media-manifest-conflict");
  }
  const stagedFileProof = await stagedProof(transaction, staged);
  const backupProof = await hashRegularFile(manifest.destination);
  const backup = path.join(
    transaction.backups,
    `${transaction.backupSequence += 1}.replacement`
  );
  const operation: TransactionOperation = {
    kind: "replace",
    destination: manifest.destination,
    staged,
    stagedProof: stagedFileProof,
    backup,
    backupProof,
    state: "prepared"
  };
  transaction.operations.push(operation);
  await writeJournal(transaction);
  try {
    await rename(manifest.destination, backup);
    await syncDirectories([path.dirname(manifest.destination), transaction.backups]);
    interruptAt(transaction.failureInjection, "after-live-move-before-replacement-link");
    await link(staged, manifest.destination);
    await syncDirectory(path.dirname(manifest.destination));
    interruptAt(transaction.failureInjection, "after-replacement-link");
  } catch (error) {
    if (error instanceof EditorialPublicationInterruption) {
      throw error;
    }
    fail("editorial-media-manifest-replacement-failed");
  }
  operation.state = "published";
  await writeJournal(transaction);
}

async function validateProspective(
  roots: Roots,
  recipeRecords: readonly RecipeRecord[],
  editorial: readonly EditorialPageRecord[],
  galleries: readonly GalleryRecord[],
  manifest: EditorialGalleryMediaManifest,
  staged: StagedPlan | null
) {
  try {
    const currentRecipes = loadRecipeCatalogWithSources(path.join(roots.contentRoot, "recipes")).records;
    if (!canonicalEquals(currentRecipes, recipeRecords)) {
      fail("recipe-catalog-changed");
    }
    validatePublicContentCatalogs(editorial, galleries, {
      recipeRecords: currentRecipes,
      reservedPaths: getReservedPublicPaths(currentRecipes)
    });
    validateEditorialGalleryMediaManifestClosure(editorial, galleries, manifest);
    if (staged !== null) {
      for (const file of [...staged.records.values(), staged.gallery, staged.mediaManifest]) {
        if (file === undefined) {
          continue;
        }
        await readRegularJson(file);
      }
    }
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("invalid-prospective-public-content");
  }
}

async function validatePublished(
  roots: Roots,
  recipeRecords: readonly RecipeRecord[],
  selected: readonly EditorialPageRecord[],
  gallery: GalleryRecord | null,
  removals: readonly PlannedRemoval[]
) {
  try {
    const currentRecipes = loadRecipeCatalogWithSources(path.join(roots.contentRoot, "recipes")).records;
    if (!canonicalEquals(currentRecipes, recipeRecords)) {
      fail("recipe-catalog-changed");
    }
    const editorial = loadEditorialCatalogWithSources(roots.editorialRoot).records;
    const galleries = loadGalleryCatalogWithSources(roots.galleryRoot).records;
    validatePublicContentCatalogs(editorial, galleries, {
      recipeRecords: currentRecipes,
      reservedPaths: getReservedPublicPaths(currentRecipes)
    });
    const manifest = loadEditorialGalleryMediaManifest(roots.mediaManifest);
    validateEditorialGalleryMediaManifestClosure(editorial, galleries, manifest);
    const actual = new Map(editorial.map((record) => [record.id, record] as const));
    if (
      selected.some((record) => !canonicalEquals(actual.get(record.id), record))
      || removals.some((removal) => actual.has(removal.record.id))
      || (
        gallery !== null
        && !canonicalEquals(galleries[0], gallery)
      )
    ) {
      fail("promoted-catalog-mismatch");
    }
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("invalid-promoted-public-content");
  }
}

type PreparedPublication = {
  readonly records: readonly PlannedRecord[];
  readonly removals: readonly PlannedRemoval[];
  readonly gallery: PlannedGallery;
  readonly manifest: PlannedManifest;
  readonly projectedEditorial: readonly EditorialPageRecord[];
  readonly projectedGalleries: readonly GalleryRecord[];
};

async function preparePublication(
  roots: Roots,
  input: EditorialPublicationInput,
  authenticated: readonly EditorialGalleryMediaManifestEntry[]
): Promise<PreparedPublication> {
  const records = await planRecords(
    input.plan.records,
    input.plan.publicationExcludedRecordIds,
    roots
  );
  const gallery = await planGallery(input.plan.gallery, roots);
  const projectedEditorial = prospectiveEditorial(records.retained, records.planned);
  const projectedGalleries = prospectiveGalleries(gallery.existing, gallery.planned);
  const manifest = await planManifest(
    roots,
    input,
    records.existing,
    gallery.existing,
    projectedEditorial,
    projectedGalleries,
    authenticated
  );
  return {
    records: records.planned,
    removals: records.removals,
    gallery: gallery.planned,
    manifest,
    projectedEditorial,
    projectedGalleries
  };
}

/**
 * Revalidates source-bound media while proving that the current public
 * editorial records and manifest are exactly the authenticated promotion plan.
 */
export async function withAuthenticatedEditorialPublicationMediaPlan<T>(
  roots: Roots,
  input: EditorialPublicationInput,
  callback: (plan: AuthenticatedEditorialMediaUploadPlan) => Promise<T>
): Promise<T> {
  if (input.write) {
    fail("invalid-media-plan-mode");
  }
  const identity = transactionIdentity(input);
  await assertPromotionDomain(roots, input.stagingRoot);
  await recoverTransaction(
    roots,
    input.stagingRoot,
    identity,
    input.fingerprintKey,
    input.recipeRecords,
    input.failureInjection
  );
  const selectedMedia = plannedPublicMedia(
    input.plan.records,
    input.plan.gallery === null ? [] : [input.plan.gallery]
  );
  return withAuthenticatedEditorialMediaEntries(
    input,
    selectedMedia,
    async (media) => {
      const prepared = await preparePublication(roots, input, media.entries);
      let publishedGalleryCount: number;
      try {
        publishedGalleryCount = loadGalleryCatalogWithSources(roots.galleryRoot).records.length;
      } catch {
        fail("published-editorial-media-mismatch");
      }
      await validateProspective(
        roots,
        input.recipeRecords,
        prepared.projectedEditorial,
        prepared.projectedGalleries,
        prepared.manifest.manifest,
        null
      );
      if (
        prepared.records.length !== input.plan.records.length
        || !prepared.records.every((record) => record.action === "reuse")
        || prepared.projectedEditorial.length !== input.plan.records.length
        || prepared.removals.length !== 0
        || (
          input.plan.gallery === null
            ? (
              prepared.gallery !== null
              || prepared.projectedGalleries.length !== 0
              || publishedGalleryCount !== 0
            )
            : (
              prepared.gallery?.action !== "reuse"
              || prepared.projectedGalleries.length !== 1
              || publishedGalleryCount !== 1
            )
        )
        || prepared.manifest.action !== "reuse"
      ) {
        fail("published-editorial-media-mismatch");
      }
      return callback(media);
    }
  );
}

async function applyPublication(
  roots: Roots,
  input: EditorialPublicationInput,
  identity: TransactionIdentity,
  prepared: PreparedPublication
) {
  await assertDirectoryChain(roots.repositoryRoot, roots.contentRoot, false);
  await assertDirectoryChain(roots.contentRoot, roots.editorialRoot, true);
  for (const locale of localeValues) {
    await assertDirectoryChain(roots.editorialRoot, path.join(roots.editorialRoot, locale), true);
  }
  await assertDirectoryChain(roots.contentRoot, roots.galleryRoot, true);
  const stage = createStagePlan(prepared.records, prepared.gallery, prepared.manifest);
  const transaction = await createTransaction(
    roots,
    input.stagingRoot,
    identity,
    input.fingerprintKey,
    input.failureInjection,
    stage.artifacts
  );
  try {
    const staged = await stagePlan(transaction, stage);
    await validateProspective(
      roots,
      input.recipeRecords,
      prepared.projectedEditorial,
      prepared.projectedGalleries,
      prepared.manifest.manifest,
      staged
    );
    await persistState(
      transaction,
      "prepared",
      "pending",
      "after-prepared-transaction-journal"
    );
    await persistState(
      transaction,
      "publishing",
      "pending",
      "after-publishing-transaction-journal"
    );
    let publications = 0;
    const recordPublication = () => {
      publications += 1;
      if (hasFailureInjection(input.failureInjection, "after-first-publication") && publications === 1) {
        fail("injected-promotion-failure");
      }
      if (
        hasFailureInjection(input.failureInjection, "after-some-new-files-publish")
        && publications === 1
      ) {
        interrupt();
      }
    };
    const publish = async (stagedFile: string, destination: string) => {
      await publishCreate(transaction, stagedFile, destination);
      recordPublication();
    };
    for (const record of prepared.records) {
      if (record.action === "create") {
        const stagedFile = staged.records.get(record.destination);
        if (stagedFile === undefined) {
          fail("promotion-stage-failed");
        }
        await publish(stagedFile, record.destination);
      }
    }
    for (const removal of prepared.removals) {
      await publishRemoval(transaction, removal);
      recordPublication();
    }
    if (prepared.gallery !== null && prepared.gallery.action === "create") {
      if (staged.gallery === undefined) {
        fail("promotion-stage-failed");
      }
      await publish(staged.gallery, prepared.gallery.destination);
    }
    if (prepared.manifest.action === "create") {
      if (staged.mediaManifest === undefined) {
        fail("promotion-stage-failed");
      }
      await publish(staged.mediaManifest, prepared.manifest.destination);
    } else if (prepared.manifest.action === "replace") {
      if (staged.mediaManifest === undefined) {
        fail("promotion-stage-failed");
      }
      await publishReplacement(transaction, staged.mediaManifest, prepared.manifest);
    }
    await validatePublished(
      roots,
      input.recipeRecords,
      input.plan.records,
      input.plan.gallery,
      prepared.removals
    );
    await persistCleanupState(transaction, "committed");
    await removeTransactionTree(transaction);
  } catch (error) {
    if (error instanceof EditorialPublicationInterruption) {
      throw error;
    }
    if (transaction.phase === "cleanup" && transaction.outcome === "committed") {
      if (error instanceof EditorialPublicationError) {
        throw error;
      }
      fail("promotion-transaction-failed");
    }
    try {
      await rollbackTransaction(transaction);
      await validateRecoveryDomain(roots, input.recipeRecords);
      await persistCleanupState(transaction, "rolled-back");
      await removeTransactionTree(transaction);
    } catch (rollbackError) {
      if (rollbackError instanceof EditorialPublicationInterruption) {
        throw rollbackError;
      }
      fail("promotion-rollback-failed");
    }
    if (error instanceof EditorialPublicationError) {
      throw error;
    }
    fail("promotion-transaction-failed");
  }
}

function transactionIdentity(input: EditorialPublicationInput): TransactionIdentity {
  return {
    source: {
      sqlDecompressedSha256: input.sourceManifest.source.sqlDecompressedSha256,
      manifestSha256: sha256Canonical(input.sourceManifest)
    },
    contract: {
      importerContractVersion: editorialImportContractVersion,
      publicMediaManifestVersion: 1
    },
    planSha256: sha256Canonical({
      records: input.plan.records,
      gallery: input.plan.gallery,
      mediaBindings: input.plan.mediaBindings,
      publicationExcludedRecordIds: input.plan.publicationExcludedRecordIds
    })
  };
}

export async function publishEditorialPromotion(
  roots: Roots,
  input: EditorialPublicationInput
): Promise<EditorialPublicationSummary> {
  const identity = transactionIdentity(input);
  await assertPromotionDomain(roots, input.stagingRoot);
  await recoverTransaction(
    roots,
    input.stagingRoot,
    identity,
    input.fingerprintKey,
    input.recipeRecords,
    input.failureInjection
  );
  const selectedMedia = plannedPublicMedia(
    input.plan.records,
    input.plan.gallery === null ? [] : [input.plan.gallery]
  );
  return withAuthenticatedEditorialMediaEntries(
    input,
    selectedMedia,
    async (media) => {
      const prepared = await preparePublication(roots, input, media.entries);
      await validateProspective(
        roots,
        input.recipeRecords,
        prepared.projectedEditorial,
        prepared.projectedGalleries,
        prepared.manifest.manifest,
        null
      );
      if (input.write) {
        await applyPublication(roots, input, identity, prepared);
      }
      return {
        records: {
          created: prepared.records.filter((entry) => entry.action === "create").length,
          removed: prepared.removals.length,
          reused: prepared.records.filter((entry) => entry.action === "reuse").length,
          galleriesCreated: prepared.gallery?.action === "create" ? 1 : 0,
          galleriesReused: prepared.gallery?.action === "reuse" ? 1 : 0
        },
        media: {
          addedToManifest: prepared.manifest.added,
          removedFromManifest: prepared.manifest.removed,
          reusedFromManifest: prepared.manifest.reused,
          updatedInManifest: prepared.manifest.updated
        }
      };
    }
  );
}
