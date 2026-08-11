import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants, realpathSync, type Dirent } from "node:fs";
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
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  loadRecipeCatalogWithSources,
  validateCatalog
} from "../../src/content/catalog";
import {
  localeValues,
  recipeRecordSchema,
  type Locale,
  type RecipeRecord
} from "../../src/content/schema";
import { createStaticWebAppConfig } from "../../src/content/staticwebapp";
import {
  validateCatalogBehavior,
  validateContent,
  validateMediaPaths
} from "../../src/content/validation";
import {
  copyVerifiedOpenUploadArchiveEntry,
  hashVerifiedOpenUploadArchiveEntry,
  openVerifiedUploadArchive,
  type VerifiedUploadArchive
} from "./uploads-media";
import {
  createRecipeMediaManifest,
  loadRecipeMediaManifest,
  parseRecipeMediaManifest,
  validateRecipeMediaManifestClosure,
  type RecipeMediaManifest,
  type RecipeMediaManifestEntry
} from "../../src/content/media-manifest";
import {
  isWordPressRecipeMediaObjectKey,
  parseWordPressRecipeMediaObjectKey
} from "../../src/content/media";
import {
  wprmImportContractVersion,
  type CandidateOutcome,
  type WprmStagedMediaBinding,
  type WprmStagedMediaBindings
} from "./wprm-import-contracts";
import { normalizeWprmAttachmentFile } from "./wprm-import-map";
import { runWprmBulkImport } from "./wprm-import-runner";
import {
  canonicalCandidateJson,
  fingerprintCandidate,
  readFingerprintKey
} from "./wprm-import-stage";
import { normalizeWprmRichText } from "./html-to-text";
import { resolveWprmUploadArchives } from "./wprm-import-source";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultPromotionRepositoryRoot = realpathSync(path.resolve(moduleDirectory, "../.."));
const execFile = promisify(execFileCallback);

const legacyPrototypeSeed = {
  contentRelativePath: "content/recipes/en/meatballs-soup.json",
  contentIndexBlob: "3f4c33037dc7cc1f2047dbf9347c9701d43a8b16",
  contentSha256: "3e2a5a05d95a600d1d0719d6a7ccaef446702feedf24561af62ad1ce79250167",
  id: "wordpress:wprm:2980",
  locale: "en" as const,
  slug: "meatballs-soup",
  source: {
    system: "wordpress" as const,
    postId: null,
    recipeId: "2980",
    postType: null,
    plugin: "wprm" as const,
    sourceSlug: null,
    createdAt: null,
    modifiedAt: null,
    editorialPostId: null,
    editorialPostType: null,
    editorialSourceSlug: null,
    editorialCreatedAt: null,
    editorialModifiedAt: null
  },
  targetId: "wordpress:wprm:21681",
  targetRecipeId: "21681",
  placeholders: [
    {
      relativePath: "public/recipes/meatballs-soup/hero.png",
      indexBlob: "dc108ea68f09319ea7ce5d216a976afd8b369de6",
      sha256: "4ab768300b509056624a00f608544dcff8a29e2596b64ffbb3cc2faab1f773d1"
    },
    {
      relativePath: "public/recipes/meatballs-soup/steps/01-meatball-mix.png",
      indexBlob: "a5c25bb15573caa8e55a4a9dee89839ae45828b8",
      sha256: "26242860ffc4ffcc5052252cc7a1e4afefe96d4d0d671573260e862a920d3c0d"
    }
  ]
} as const;

export type WprmPrototypeSeed = {
  readonly contentRelativePath: string;
  readonly contentIndexBlob: string;
  readonly contentSha256: string;
  readonly id: string;
  readonly locale: Locale;
  readonly slug: string;
  readonly source: RecipeRecord["source"];
  readonly targetId: string;
  readonly targetRecipeId: string;
  readonly placeholders: readonly {
    readonly relativePath: string;
    readonly indexBlob: string;
    readonly sha256: string;
  }[];
};

type OutcomeCounts = {
  readonly ready: number;
  readonly review: number;
  readonly error: number;
};

type PromotionRoots = {
  readonly repositoryRoot: string;
  readonly contentRoot: string;
  readonly mediaRoot: string;
  readonly mediaManifest: string;
  readonly migrationOutputRoot: string;
};

type StagingPaths = {
  readonly root: string;
  readonly candidates: string;
  readonly marker: string;
  readonly manifest: string;
  readonly mediaBindings: string;
};

type PlannedRecord = {
  readonly record: RecipeRecord;
  readonly destination: string;
  readonly action:
    | "create"
    | "reuse"
    | "replace-normalized-display-text"
    | "replace-prototype";
};

type PlannedMedia = {
  readonly attachmentId: string;
  readonly archiveIndex: number;
  readonly archivePath: string;
  readonly key: string;
  readonly sourcePath: string;
  readonly binding: WprmStagedMediaBinding;
  readonly bytes: number;
  readonly sha256: string;
  readonly action: "create" | "reuse";
};

type PlannedMediaPreparation = {
  readonly planned: readonly PlannedMedia[];
  readonly referenced: number;
  readonly archives: ReadonlyMap<number, VerifiedUploadArchive>;
};

type PlannedMediaManifest = {
  readonly action: "create" | "replace" | "reuse";
  readonly destination: string;
  readonly expected: RecipeMediaManifest | null;
  readonly manifest: RecipeMediaManifest;
};

type PromotionFailureInjection =
  | "after-first-publication"
  | "after-normalized-display-text-replacement"
  | "after-prototype-replacement"
  | "after-live-move-before-replacement-link"
  | "after-some-new-files-publish"
  | "after-promotion-lock"
  | "after-transaction-bootstrap"
  | "after-transaction-root"
  | "after-transaction-records-directory"
  | "after-transaction-backups-directory"
  | "after-initial-transaction-journal"
  | "after-staged-artifact-write"
  | "after-prepared-transaction-journal"
  | "after-publishing-transaction-journal"
  | "after-create-link"
  | "after-replacement-live-move"
  | "after-replacement-link"
  | "after-remove-live-move"
  | "after-rollback-transaction-journal"
  | "after-rollback-create-unlink"
  | "after-rollback-replacement-unlink"
  | "after-rollback-backup-rename"
  | "after-cleanup-transaction-journal"
  | "after-cleanup-staged-unlink"
  | "after-cleanup-backup-unlink"
  | "after-cleanup-journal-unlink";

export type WprmPromotionOptions = {
  readonly database: string;
  readonly fingerprintKeyFile: string;
  readonly stagingDir: string;
  readonly expected: OutcomeCounts;
  readonly uploadsDir?: string;
  readonly uploadArchives?: readonly string[];
  readonly write?: boolean;
  /**
   * Test-only fault injection. It is deliberately not accepted by the CLI.
   */
  readonly failureInjection?: PromotionFailureInjection | readonly PromotionFailureInjection[];
  /**
   * Test-only synchronization hook used to model an independent contender for
   * the repository-scoped promotion lock.
   */
  readonly onPromotionLockAcquired?: () => Promise<void>;
  /**
   * Test-only prototype metadata for disposable repository fixtures.
   */
  readonly prototypeSeed?: WprmPrototypeSeed;
  /**
   * Tests must use a disposable repository-shaped directory. The CLI passes
   * the physical root of this repository explicitly.
   */
  readonly repositoryRoot: string;
};

export type WprmPromotionResult = {
  readonly schemaVersion: 1;
  readonly kind: "wprm-promotion-result";
  readonly mode: "dry-run" | "write";
  readonly candidates: OutcomeCounts;
  readonly translation: {
    readonly eligible: number;
    readonly excluded: number;
    readonly blockedGroups: number;
    readonly reviewPeers: number;
    readonly errorPeers: number;
  };
  readonly records: {
    readonly byLocale: Readonly<Record<Locale, number>>;
    readonly created: number;
    readonly replacedNormalizedDisplayText: number;
    readonly replacedPrototype: number;
    readonly reused: number;
  };
  readonly media: {
    readonly referenced: number;
    readonly unique: number;
    readonly addedToManifest: number;
    readonly reusedFromManifest: number;
  };
  readonly redirects: {
    readonly published: 0;
  };
};

export type AuthenticatedWprmMediaUploadEntry = {
  readonly bytes: number;
  readonly key: string;
  readonly sha256: string;
  readonly sourceAttachmentId: string;
};

export type AuthenticatedWprmMediaPlan = {
  readonly entries: readonly AuthenticatedWprmMediaUploadEntry[];
  readonly manifest: RecipeMediaManifest;
  copyToPrivateFile(key: string, destination: string): Promise<void>;
};

export class WprmPromotionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The WPRM promotion failed.");
    this.name = "WprmPromotionError";
    this.code = code;
  }
}

class WprmPromotionInterruption extends Error {
  readonly code = "injected-promotion-interruption";

  constructor() {
    super("The WPRM promotion was interrupted.");
    this.name = "WprmPromotionInterruption";
  }
}

function fail(code: string): never {
  throw new WprmPromotionError(code);
}

function interruptPromotion() {
  throw new WprmPromotionInterruption();
}

function hasFailureInjection(
  configured: WprmPromotionOptions["failureInjection"] | undefined,
  point: PromotionFailureInjection
) {
  return Array.isArray(configured)
    ? configured.includes(point)
    : configured === point;
}

function interruptAt(
  configured: WprmPromotionOptions["failureInjection"] | undefined,
  point: PromotionFailureInjection
) {
  if (hasFailureInjection(configured, point)) {
    interruptPromotion();
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

function isPrivateOwned(stats: { readonly mode: number; readonly uid?: number }) {
  if ((stats.mode & 0o077) !== 0) {
    return false;
  }
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

function isRegularFile(stats: { isFile(): boolean; isSymbolicLink(): boolean }) {
  return stats.isFile() && !stats.isSymbolicLink();
}

function sortedNumericIds(values: Iterable<string>) {
  return [...values].sort((left, right) => {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber
      ? -1
      : leftNumber > rightNumber
        ? 1
        : left.localeCompare(right);
  });
}

function canonicalEquals(left: unknown, right: unknown) {
  return canonicalCandidateJson(left) === canonicalCandidateJson(right);
}

function provenanceEquals(left: RecipeRecord, right: RecipeRecord) {
  return left.id === right.id
    && left.locale === right.locale
    && left.slug === right.slug
    && canonicalEquals(left.source, right.source);
}

function fixedEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function sha256Canonical(value: unknown) {
  return createHash("sha256")
    .update(canonicalCandidateJson(value), "utf8")
    .digest("hex");
}

function validateExpectedCounts(expected: OutcomeCounts) {
  for (const count of Object.values(expected)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      fail("invalid-expected-count");
    }
  }
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

async function assertDirectoryChain(
  root: string,
  destination: string,
  createMissing: boolean
) {
  if (!isWithin(destination, root)) {
    fail("unsafe-destination");
  }
  const relative = path.relative(root, destination);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === "..") {
    if (relative === "") {
      const stats = await existingStats(root);
      if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
        fail("unsafe-destination");
      }
      return;
    }
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
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
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

async function readPrivateFile(target: string, maxBytes = 16 * 1024 * 1024) {
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
    const handleStats = await handle.stat();
    if (
      !handleStats.isFile()
      || !isPrivateOwned(handleStats)
      || (handleStats.mode & 0o777) !== 0o600
    ) {
      fail("unsafe-staging");
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("unsafe-staging");
  } finally {
    await handle?.close();
  }
}

async function readPrivateJson(target: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readPrivateFile(target)).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("invalid-staging-json");
  }
  return parsed;
}

async function readPrivateJsonBounded(target: string, maxBytes: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      (await readPrivateFile(target, maxBytes)).toString("utf8")
    ) as unknown;
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("invalid-promotion-journal");
  }
  return parsed;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCurrentMarker(value: unknown): value is {
  readonly schemaVersion: 2;
  readonly kind: "wprm-bulk-staging";
  readonly sqlDecompressedSha256: string;
  readonly importerContractVersion: typeof wprmImportContractVersion;
  readonly mediaBindingVersion: 1;
} {
  return hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "importerContractVersion",
    "mediaBindingVersion"
  ])
    && value.schemaVersion === 2
    && value.kind === "wprm-bulk-staging"
    && typeof value.sqlDecompressedSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sqlDecompressedSha256)
    && value.importerContractVersion === wprmImportContractVersion
    && value.mediaBindingVersion === 1;
}

function isLegacyV3Marker(value: unknown) {
  return hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "importerContractVersion"
  ])
    && value.schemaVersion === 1
    && value.kind === "wprm-bulk-staging"
    && value.importerContractVersion === "wprm-bulk-import-v3";
}

async function resolveRoots(options: WprmPromotionOptions): Promise<PromotionRoots> {
  if (
    typeof options.repositoryRoot !== "string"
    || options.repositoryRoot.length === 0
  ) {
    fail("missing-repository-root");
  }
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(path.resolve(options.repositoryRoot));
  } catch {
    fail("invalid-repository-root");
  }
  const stats = await existingStats(repositoryRoot);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("invalid-repository-root");
  }
  return {
    repositoryRoot,
    contentRoot: path.join(repositoryRoot, "content", "recipes"),
    mediaRoot: path.join(repositoryRoot, "public", "recipes"),
    mediaManifest: path.join(repositoryRoot, "content", "media-manifest.json"),
    migrationOutputRoot: path.join(repositoryRoot, "migration-output")
  };
}

async function resolveStagingPaths(
  roots: PromotionRoots,
  stagingDir: string
): Promise<StagingPaths> {
  const root = path.isAbsolute(stagingDir)
    ? path.resolve(stagingDir)
    : path.resolve(roots.repositoryRoot, stagingDir);
  if (!isWithin(root, roots.migrationOutputRoot) || root === roots.migrationOutputRoot) {
    fail("unsafe-staging");
  }
  await assertDirectoryChain(roots.repositoryRoot, root, false);
  const candidates = path.join(root, "candidates");
  await assertDirectoryChain(root, candidates, false);
  await assertPrivateDirectory(root);
  await assertPrivateDirectory(candidates);
  return {
    root,
    candidates,
    marker: path.join(root, ".wprm-staging.json"),
    manifest: path.join(root, "manifest.json"),
    mediaBindings: path.join(root, "media-bindings.json")
  };
}

async function candidateFileNames(staging: StagingPaths) {
  let entries: Array<{
    readonly name: string;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await readdir(staging.candidates, {
      encoding: "utf8",
      withFileTypes: true
    });
  } catch {
    fail("unsafe-staging");
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || !/^\d+\.json$/u.test(entry.name)
    ) {
      fail("unsafe-staging");
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => {
    const leftId = BigInt(left.slice(0, -5));
    const rightId = BigInt(right.slice(0, -5));
    return leftId < rightId ? -1 : leftId > rightId ? 1 : left.localeCompare(right);
  });
}

function countsFor(outcomes: readonly CandidateOutcome[]): OutcomeCounts {
  return {
    ready: outcomes.filter((outcome) => outcome.status === "ready").length,
    review: outcomes.filter((outcome) => outcome.status === "review").length,
    error: outcomes.filter((outcome) => outcome.status === "error").length
  };
}

function sameCounts(left: OutcomeCounts, right: OutcomeCounts) {
  return left.ready === right.ready
    && left.review === right.review
    && left.error === right.error;
}

function validateCandidateRecord(
  value: unknown,
  expected: CandidateOutcome,
  key: Uint8Array
) {
  const parsed = recipeRecordSchema.safeParse(value);
  if (!parsed.success || expected.record === null || expected.fingerprint === null) {
    fail("invalid-staged-candidate");
  }
  const record = parsed.data;
  if (
    record.id !== `wordpress:wprm:${expected.recipeId}`
    || record.source.recipeId !== expected.recipeId
    || record.locale !== expected.locale
  ) {
    fail("staged-candidate-source-mismatch");
  }
  if (!fixedEqual(fingerprintCandidate(key, record), expected.fingerprint)) {
    fail("staged-candidate-hmac-mismatch");
  }
  if (!canonicalEquals(record, expected.record)) {
    fail("staged-candidate-source-mismatch");
  }
  if (record.redirectFrom.length !== 0) {
    fail("unproven-redirect");
  }
  return record;
}

async function authenticateCandidates(
  staging: StagingPaths,
  outcomes: readonly CandidateOutcome[],
  key: Uint8Array
) {
  const expected = new Map(
    outcomes
      .filter((outcome) => outcome.record !== null)
      .map((outcome) => [outcome.recipeId, outcome] as const)
  );
  const names = await candidateFileNames(staging);
  const expectedNames = sortedNumericIds(expected.keys()).map((id) => `${id}.json`);
  if (
    names.length !== expectedNames.length
    || names.some((name, index) => name !== expectedNames[index])
  ) {
    fail("staged-candidate-set-mismatch");
  }
  const authenticated = new Map<string, RecipeRecord>();
  for (const recipeId of sortedNumericIds(expected.keys())) {
    const outcome = expected.get(recipeId);
    if (outcome === undefined) {
      fail("staged-candidate-set-mismatch");
    }
    const candidate = await readPrivateJson(path.join(staging.candidates, `${recipeId}.json`));
    authenticated.set(recipeId, validateCandidateRecord(candidate, outcome, key));
  }
  return authenticated;
}

function isStagedMediaBindings(value: unknown): value is WprmStagedMediaBindings {
  if (
    !hasExactKeys(value, ["schemaVersion", "kind", "entries"])
    || value.schemaVersion !== 1
    || value.kind !== "wprm-staged-media-bindings"
    || !Array.isArray(value.entries)
  ) {
    return false;
  }
  let previous: string | undefined;
  for (const entry of value.entries) {
    if (
      !hasExactKeys(entry, ["attachmentId", "bytes", "keyedSha256"])
      || typeof entry.attachmentId !== "string"
      || !/^\d+$/u.test(entry.attachmentId)
      || typeof entry.bytes !== "number"
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.keyedSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.keyedSha256)
      || (previous !== undefined && BigInt(previous) >= BigInt(entry.attachmentId))
    ) {
      return false;
    }
    previous = entry.attachmentId;
  }
  return true;
}

async function authenticateMediaBindings(staging: StagingPaths) {
  const parsed = await readPrivateJson(staging.mediaBindings);
  if (!isStagedMediaBindings(parsed)) {
    fail("invalid-staged-media-bindings");
  }
  return new Map(parsed.entries.map((entry) => [entry.attachmentId, entry] as const));
}

export function validatePromotionTranslationClosure(
  selected: readonly RecipeRecord[],
  outcomes: readonly CandidateOutcome[],
  existing: readonly RecipeRecord[],
  sourceTranslationGroups?: ReadonlyMap<string, string | null>
) {
  const groups = sourceTranslationGroups ?? new Map(
    outcomes.map((outcome) => [
      outcome.recipeId,
      outcome.record?.translationGroupId ?? null
    ] as const)
  );
  const selectedIds = new Set(selected.map((record) => record.source.recipeId));
  const allByGroup = new Map<string, CandidateOutcome[]>();
  for (const outcome of outcomes) {
    const groupId = groups.get(outcome.recipeId);
    if (groupId === undefined) {
      fail("source-translation-group-missing");
    }
    if (groupId === null) {
      continue;
    }
    const members = allByGroup.get(groupId) ?? [];
    members.push(outcome);
    allByGroup.set(groupId, members);
  }
  const selectedGroups = new Set(
    selected
      .map((record) => record.translationGroupId)
      .filter((group): group is string => group !== null)
  );
  for (const record of selected) {
    const sourceGroup = groups.get(record.source.recipeId);
    if (sourceGroup === undefined || sourceGroup !== record.translationGroupId) {
      fail("source-translation-group-mismatch");
    }
    if (record.translationGroupId === null) {
      continue;
    }
    const members = allByGroup.get(record.translationGroupId);
    if (
      members === undefined
      || members.some(
        (member) => member.status !== "ready" || !selectedIds.has(member.recipeId)
      )
    ) {
      fail("incomplete-translation-closure");
    }
  }
  for (const record of existing) {
    if (
      record.translationGroupId !== null
      && selectedGroups.has(record.translationGroupId)
      && !selectedIds.has(record.source.recipeId)
    ) {
      fail("translation-group-collision");
    }
  }
}

export function classifyPromotionTranslationClosure(
  selected: readonly RecipeRecord[],
  outcomes: readonly CandidateOutcome[],
  existing: readonly RecipeRecord[],
  sourceTranslationGroups: ReadonlyMap<string, string | null>
) {
  const selectedIds = new Set(selected.map((record) => record.source.recipeId));
  const membersByGroup = new Map<string, CandidateOutcome[]>();
  for (const outcome of outcomes) {
    const groupId = sourceTranslationGroups.get(outcome.recipeId);
    if (groupId === undefined) {
      fail("source-translation-group-missing");
    }
    if (groupId === null) {
      continue;
    }
    const members = membersByGroup.get(groupId) ?? [];
    members.push(outcome);
    membersByGroup.set(groupId, members);
  }
  const blocked = new Map<string, CandidateOutcome[]>();
  for (const record of selected) {
    const groupId = sourceTranslationGroups.get(record.source.recipeId);
    if (groupId === undefined || groupId !== record.translationGroupId) {
      fail("source-translation-group-mismatch");
    }
    if (groupId === null) {
      continue;
    }
    const members = membersByGroup.get(groupId);
    if (
      members === undefined
      || members.some(
        (member) => member.status !== "ready" || !selectedIds.has(member.recipeId)
      )
    ) {
      blocked.set(groupId, members ?? []);
    }
  }
  const eligible = selected.filter((record) =>
    record.translationGroupId === null
    || !blocked.has(record.translationGroupId)
  );
  validatePromotionTranslationClosure(
    eligible,
    outcomes,
    existing,
    sourceTranslationGroups
  );
  const blockedMembers = [...blocked.values()].flat();
  return {
    selected: eligible,
    excluded: selected.length - eligible.length,
    blockedGroups: blocked.size,
    reviewPeers: blockedMembers.filter((member) => member.status === "review").length,
    errorPeers: blockedMembers.filter((member) => member.status === "error").length
  };
}

function contentDestination(record: RecipeRecord, contentRoot: string) {
  const directory = path.join(contentRoot, record.locale);
  const fileName = `${record.slug}.json`;
  if (
    path.basename(fileName) !== fileName
    || fileName === ".json"
    || fileName.includes(path.sep)
  ) {
    fail("unsafe-content-destination");
  }
  const destination = path.resolve(directory, fileName);
  if (!isWithin(destination, directory)) {
    fail("unsafe-content-destination");
  }
  return destination;
}

async function readRegularJson(target: string) {
  const stats = await existingStats(target);
  if (stats === null || !isRegularFile(stats)) {
    fail("destination-file-conflict");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile()) {
      fail("destination-file-conflict");
    }
    return JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("destination-file-conflict");
  } finally {
    await handle?.close();
  }
}

function isAuthorizedPrototypeReplacement(
  record: RecipeRecord,
  prototypeSeed: WprmPrototypeSeed
) {
  return record.id === prototypeSeed.targetId
    && record.locale === prototypeSeed.locale
    && record.slug === prototypeSeed.slug
    && record.source.system === "wordpress"
    && record.source.plugin === "wprm"
    && record.source.recipeId === prototypeSeed.targetRecipeId;
}

function normalizeExistingDisplayText(record: RecipeRecord) {
  const normalizeOptional = (value: string | null) => normalizeWprmRichText(value, {
    maxInputBytes: 1_048_576
  });
  const normalizeRequired = (value: string) => {
    const normalized = normalizeOptional(value);
    if (normalized === null) {
      fail("normalized-display-text-replacement-failed");
    }
    return normalized;
  };
  const normalizeQuantity = (
    quantity: RecipeRecord["recipe"]["servings"]
  ) => quantity === null
    ? null
    : {
      ...quantity,
      raw: normalizeRequired(quantity.raw),
      unit: normalizeOptional(quantity.unit)
    };
  const normalizeDuration = (
    duration: RecipeRecord["recipe"]["times"]["prep"]
  ) => duration === null
    ? null
    : {
      ...duration,
      raw: normalizeRequired(duration.raw)
    };
  const recipe = record.recipe;
  return recipeRecordSchema.parse({
    ...record,
    title: normalizeRequired(record.title),
    description: normalizeOptional(record.description),
    seo: record.seo === null
      ? null
      : {
        title: normalizeOptional(record.seo.title),
        description: normalizeOptional(record.seo.description)
      },
    taxonomies: record.taxonomies.map((taxonomy) => ({
      ...taxonomy,
      name: normalizeRequired(taxonomy.name)
    })),
    recipe: {
      ...recipe,
      notes: normalizeOptional(recipe.notes),
      servings: normalizeQuantity(recipe.servings),
      nutrition: recipe.nutrition === undefined || recipe.nutrition === null
        ? recipe.nutrition
        : {
          ...recipe.nutrition,
          calories: recipe.nutrition.calories === null
            ? null
            : {
              ...recipe.nutrition.calories,
              raw: normalizeRequired(recipe.nutrition.calories.raw)
            },
          servingSize: recipe.nutrition.servingSize === null
            ? null
            : {
              ...recipe.nutrition.servingSize,
              raw: normalizeRequired(recipe.nutrition.servingSize.raw)
            },
          servingUnit: normalizeOptional(recipe.nutrition.servingUnit)
        },
      equipment: recipe.equipment === undefined || recipe.equipment === null
        ? recipe.equipment
        : recipe.equipment.map((equipment) => ({
          ...equipment,
          name: normalizeRequired(equipment.name),
          amount: normalizeOptional(equipment.amount),
          notes: normalizeOptional(equipment.notes)
        })),
      times: {
        ...recipe.times,
        prep: normalizeDuration(recipe.times.prep),
        cook: normalizeDuration(recipe.times.cook),
        rest: normalizeDuration(recipe.times.rest),
        total: normalizeDuration(recipe.times.total),
        custom: recipe.times.custom === null
          ? null
          : {
            label: normalizeOptional(recipe.times.custom.label),
            duration: {
              ...recipe.times.custom.duration,
              raw: normalizeRequired(recipe.times.custom.duration.raw)
            }
          }
      },
      ingredientGroups: recipe.ingredientGroups.map((group) => ({
        ...group,
        name: normalizeOptional(group.name),
        items: group.items.map((item) => ({
          ...item,
          raw: normalizeRequired(item.raw),
          quantity: normalizeQuantity(item.quantity),
          name: normalizeRequired(item.name),
          ...(item.pluralName === undefined
            ? {}
            : { pluralName: normalizeRequired(item.pluralName) }),
          notes: normalizeOptional(item.notes)
        }))
      })),
      instructionGroups: recipe.instructionGroups.map((group) => ({
        ...group,
        name: normalizeOptional(group.name),
        steps: group.steps.map((step) => ({
          ...step,
          text: normalizeRequired(step.text)
        }))
      }))
    },
    media: record.media.map((media) => ({
      ...media,
      alt: normalizeOptional(media.alt)
    }))
  });
}

function isAuthorizedDisplayTextNormalizationReplacement(
  existing: RecipeRecord,
  candidate: RecipeRecord
) {
  if (!provenanceEquals(existing, candidate)) {
    return false;
  }
  try {
    return canonicalEquals(normalizeExistingDisplayText(existing), candidate);
  } catch {
    return false;
  }
}

async function planRecords(
  selected: readonly RecipeRecord[],
  roots: PromotionRoots,
  prototypeSeed: WprmPrototypeSeed
): Promise<PlannedRecord[]> {
  const loaded = loadRecipeCatalogWithSources(roots.contentRoot);
  const existingById = new Map(loaded.records.map((record, index) => [
    record.id,
    { record, source: loaded.files[index]!.path }
  ]));
  const existingBySlug = new Map(loaded.records.map((record, index) => [
    `${record.locale}:${record.slug}`,
    { record, source: loaded.files[index]!.path }
  ]));
  const planned: PlannedRecord[] = [];
  const destinations = new Set<string>();
  const ids = new Set<string>();
  const localizedSlugs = new Set<string>();
  const replacedExistingIds = new Set<string>();
  const legacyDestination = path.join(
    roots.repositoryRoot,
    prototypeSeed.contentRelativePath
  );

  for (const record of selected) {
    const destination = contentDestination(record, roots.contentRoot);
    const localizedSlug = `${record.locale}:${record.slug}`;
    if (
      destinations.has(destination)
      || ids.has(record.id)
      || localizedSlugs.has(localizedSlug)
    ) {
      fail("promotion-content-collision");
    }
    destinations.add(destination);
    ids.add(record.id);
    localizedSlugs.add(localizedSlug);
    const prototypeReplacement = destination === legacyDestination
      && isAuthorizedPrototypeReplacement(record, prototypeSeed);

    const existingId = existingById.get(record.id);
    const existingSlug = existingBySlug.get(localizedSlug);
    for (const existing of [existingId, existingSlug]) {
      if (existing === undefined) {
        continue;
      }
      if (
        prototypeReplacement
        && existing.source === destination
        && existing.record.id === prototypeSeed.id
      ) {
        continue;
      }
      if (
        existing.source !== destination
        || !provenanceEquals(existing.record, record)
        || (
          !canonicalEquals(existing.record, record)
          && !isAuthorizedDisplayTextNormalizationReplacement(existing.record, record)
        )
      ) {
        fail("promotion-content-collision");
      }
    }

    const targetStats = await existingStats(destination);
    if (targetStats === null) {
      planned.push({ record, destination, action: "create" });
      continue;
    }
    if (prototypeReplacement) {
      if (!isRegularFile(targetStats)) {
        fail("destination-file-conflict");
      }
      const existingTarget = recipeRecordSchema.safeParse(await readRegularJson(destination));
      if (
        existingTarget.success
        && canonicalEquals(existingTarget.data, record)
        && provenanceEquals(existingTarget.data, record)
      ) {
        planned.push({ record, destination, action: "reuse" });
        continue;
      }
      if (
        existingTarget.success
        && provenanceEquals(existingTarget.data, record)
        && isAuthorizedDisplayTextNormalizationReplacement(existingTarget.data, record)
      ) {
        planned.push({ record, destination, action: "replace-normalized-display-text" });
        continue;
      }
      await verifyLegacyPrototypeSeed(roots, destination, prototypeSeed);
      planned.push({ record, destination, action: "replace-prototype" });
      replacedExistingIds.add(prototypeSeed.id);
      continue;
    }
    if (!isRegularFile(targetStats)) {
      fail("destination-file-conflict");
    }
    const existingTarget = recipeRecordSchema.safeParse(await readRegularJson(destination));
    if (!existingTarget.success || !provenanceEquals(existingTarget.data, record)) {
      fail("destination-file-conflict");
    }
    if (canonicalEquals(existingTarget.data, record)) {
      planned.push({ record, destination, action: "reuse" });
      continue;
    }
    if (isAuthorizedDisplayTextNormalizationReplacement(existingTarget.data, record)) {
      planned.push({ record, destination, action: "replace-normalized-display-text" });
      continue;
    }
    fail("destination-file-conflict");
  }

  validateCatalog([
    ...loaded.records.filter((record) =>
      !ids.has(record.id) && !replacedExistingIds.has(record.id)
    ),
    ...selected
  ]);
  return planned;
}

async function hashRegularFile(target: string) {
  const stats = await existingStats(target);
  if (stats === null || !isRegularFile(stats)) {
    fail("destination-file-conflict");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile()) {
      fail("destination-file-conflict");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < handleStats.size) {
      const result = await handle.read(buffer, 0, buffer.byteLength, position);
      if (result.bytesRead === 0) {
        fail("destination-file-conflict");
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    return {
      bytes: handleStats.size,
      dev: handleStats.dev,
      ino: handleStats.ino,
      sha256: hash.digest("hex")
    };
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("destination-file-conflict");
  } finally {
    await handle?.close();
  }
}

async function verifyTrackedPrototypeFile(
  roots: PromotionRoots,
  relativePath: string,
  expectedIndexBlob: string,
  expectedSha256: string
) {
  const target = path.resolve(roots.repositoryRoot, relativePath);
  if (!isWithin(target, roots.repositoryRoot)) {
    fail("prototype-seed-mismatch");
  }
  let observed;
  try {
    observed = await hashRegularFile(target);
  } catch {
    fail("prototype-seed-mismatch");
  }
  if (!fixedEqual(observed.sha256, expectedSha256)) {
    fail("prototype-seed-mismatch");
  }
  try {
    const { stdout } = await execFile(
      "git",
      [
        "-C",
        roots.repositoryRoot,
        "ls-files",
        "--stage",
        "--",
        relativePath
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024
      }
    );
    if (stdout !== `100644 ${expectedIndexBlob} 0\t${relativePath}\n`) {
      fail("prototype-seed-mismatch");
    }
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("prototype-seed-mismatch");
  }
}

async function verifyLegacyPrototypePlaceholders(
  roots: PromotionRoots,
  prototypeSeed: WprmPrototypeSeed
) {
  for (const placeholder of prototypeSeed.placeholders) {
    await verifyTrackedPrototypeFile(
      roots,
      placeholder.relativePath,
      placeholder.indexBlob,
      placeholder.sha256
    );
  }
}

async function verifyLegacyPrototypeSeed(
  roots: PromotionRoots,
  destination: string,
  prototypeSeed: WprmPrototypeSeed
) {
  if (
    destination !== path.join(roots.repositoryRoot, prototypeSeed.contentRelativePath)
  ) {
    fail("prototype-seed-mismatch");
  }
  await verifyTrackedPrototypeFile(
    roots,
    prototypeSeed.contentRelativePath,
    prototypeSeed.contentIndexBlob,
    prototypeSeed.contentSha256
  );
  let parsed;
  try {
    parsed = recipeRecordSchema.parse(await readRegularJson(destination));
  } catch {
    fail("prototype-seed-mismatch");
  }
  if (
    parsed.id !== prototypeSeed.id
    || parsed.locale !== prototypeSeed.locale
    || parsed.slug !== prototypeSeed.slug
    || !canonicalEquals(parsed.source, prototypeSeed.source)
  ) {
    fail("prototype-seed-mismatch");
  }
  await verifyLegacyPrototypePlaceholders(roots, prototypeSeed);
}

function getReferencedMediaIds(record: RecipeRecord) {
  return new Set([
    record.recipe.heroMediaId,
    ...record.recipe.instructionGroups.flatMap((group) =>
      group.steps.map((step) => step.mediaId)
    )
  ].filter((value): value is string => value !== null));
}

function mediaBindingIds(records: readonly RecipeRecord[]) {
  const result = new Set<string>();
  for (const record of records) {
    for (const media of record.media) {
      if (media.sourceId === null || !/^\d+$/u.test(media.sourceId)) {
        fail("invalid-media-provenance");
      }
      result.add(media.sourceId);
    }
  }
  return result;
}

async function planMedia(
  records: readonly RecipeRecord[],
  archivePaths: readonly string[],
  snapshot: Awaited<ReturnType<typeof runWprmBulkImport>>["snapshot"],
  bindings: ReadonlyMap<string, WprmStagedMediaBinding>,
  key: Uint8Array,
  expectedBindingIds: ReadonlySet<string>,
  existingManifest: RecipeMediaManifest
): Promise<PlannedMediaPreparation> {
  const required = new Map<
    string,
    Omit<PlannedMedia, "action" | "bytes" | "sha256">
  >();
  let referenced = 0;
  for (const record of records) {
    const referencedIds = getReferencedMediaIds(record);
    if (referencedIds.size !== record.media.length) {
      fail("unreferenced-media");
    }
    for (const media of record.media) {
      referenced += 1;
      if (!referencedIds.has(media.id) || media.sourceId === null || !/^\d+$/u.test(media.sourceId)) {
        fail("invalid-media-provenance");
      }
      const sourceId = media.sourceId;
      if (media.id !== `wordpress-attachment:${sourceId}`) {
        fail("invalid-media-provenance");
      }
      const attachment = snapshot.graph.attachments.get(sourceId);
      const metadata = snapshot.metadata.attachments.get(sourceId);
      const sourcePath = normalizeWprmAttachmentFile(metadata?.attachedFile ?? null);
      if (attachment === undefined || metadata === undefined || sourcePath === null) {
        fail("invalid-media-provenance");
      }
      const extension = path.posix.extname(sourcePath).toLowerCase();
      const expectedPath = `/recipes/media/wordpress/${sourceId}${extension}`;
      if (media.path !== expectedPath) {
        fail("invalid-media-destination");
      }
      const archiveIndexes = snapshot.uploads.uploadPathArchives.get(sourcePath);
      if (
        snapshot.uploads.uploadPathCounts.get(sourcePath) !== 1
        || archiveIndexes === undefined
        || archiveIndexes.size !== 1
      ) {
        fail("invalid-media-provenance");
      }
      const archiveIndex = [...archiveIndexes][0];
      const archivePath = archiveIndex === undefined ? undefined : archivePaths[archiveIndex];
      if (archiveIndex === undefined || archivePath === undefined) {
        fail("invalid-media-provenance");
      }
      const binding = bindings.get(sourceId);
      if (binding === undefined || binding.attachmentId !== sourceId) {
        fail("staged-media-binding-set-mismatch");
      }
      const prior = required.get(expectedPath);
      const descriptor = {
        attachmentId: sourceId,
        archiveIndex,
        archivePath,
        key: expectedPath,
        sourcePath,
        binding
      };
      if (
        prior !== undefined
        && (
          prior.attachmentId !== descriptor.attachmentId
          || prior.archiveIndex !== descriptor.archiveIndex
          || prior.archivePath !== descriptor.archivePath
          || prior.sourcePath !== descriptor.sourcePath
          || prior.binding !== descriptor.binding
        )
      ) {
        fail("promotion-media-collision");
      }
      required.set(expectedPath, descriptor);
    }
  }

  const requiredIds = new Set([...required.values()].map((entry) => entry.attachmentId));
  if (
    requiredIds.size > expectedBindingIds.size
    || [...bindings.keys()].length !== expectedBindingIds.size
    || [...bindings.keys()].some((attachmentId) => !expectedBindingIds.has(attachmentId))
  ) {
    fail("staged-media-binding-set-mismatch");
  }

  const neededArchiveIndexes = [...new Set(
    [...required.values()].map((entry) => entry.archiveIndex)
  )].sort((left, right) => left - right);
  const opened = new Map<number, VerifiedUploadArchive>();
  try {
    for (const archiveIndex of neededArchiveIndexes) {
      const archivePath = archivePaths[archiveIndex];
      if (archivePath === undefined) {
        fail("invalid-media-provenance");
      }
      opened.set(archiveIndex, await openVerifiedUploadArchive(archivePath));
    }

    const planned: PlannedMedia[] = [];
    const existingEntries = new Map(
      existingManifest.entries.map((entry) => [entry.key, entry] as const)
    );
    for (const objectKey of [...required.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      const descriptor = required.get(objectKey);
      if (descriptor === undefined) {
        fail("promotion-media-collision");
      }
      const archive = opened.get(descriptor.archiveIndex);
      if (archive === undefined) {
        fail("invalid-media-provenance");
      }
      const source = await hashVerifiedOpenUploadArchiveEntry(
        archive,
        descriptor.sourcePath,
        {
          keyedDigest: {
            key,
            context: descriptor.attachmentId
          }
        }
      );
      if (
        source.keyedSha256 === null
        || source.bytes !== descriptor.binding.bytes
        || !fixedEqual(source.keyedSha256, descriptor.binding.keyedSha256)
      ) {
        fail("staged-media-binding-mismatch");
      }
      const existing = existingEntries.get(objectKey);
      if (
        existing !== undefined
        && (
          existing.sourceAttachmentId !== descriptor.attachmentId
          || source.bytes !== existing.bytes
          || !fixedEqual(source.sha256, existing.sha256)
        )
      ) {
        fail("media-manifest-collision");
      }
      planned.push({
        ...descriptor,
        bytes: source.bytes,
        sha256: source.sha256,
        action: existing === undefined ? "create" : "reuse"
      });
    }
    return { planned, referenced, archives: opened };
  } catch (error) {
    await Promise.all([...opened.values()].map((archive) => archive.close()));
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("media-source-verification-failed");
  }
}

async function loadExistingMediaManifest(roots: PromotionRoots) {
  const stats = await existingStats(roots.mediaManifest);
  if (stats === null) {
    return {
      manifest: createRecipeMediaManifest([]),
      exists: false
    };
  }
  if (!isRegularFile(stats)) {
    fail("media-manifest-conflict");
  }
  try {
    return {
      manifest: loadRecipeMediaManifest(roots.mediaManifest),
      exists: true
    };
  } catch {
    fail("invalid-media-manifest");
  }
}

function createProspectiveMediaManifest(
  catalog: readonly RecipeRecord[],
  plannedMedia: readonly PlannedMedia[],
  existingManifest: RecipeMediaManifest
) {
  const planned = new Map(plannedMedia.map((entry) => [entry.key, entry] as const));
  const existing = new Map(
    existingManifest.entries.map((entry) => [entry.key, entry] as const)
  );
  const entries = new Map<string, RecipeMediaManifestEntry>();

  for (const record of catalog) {
    for (const media of record.media) {
      if (!isWordPressRecipeMediaObjectKey(media.path)) {
        continue;
      }
      const key = parseWordPressRecipeMediaObjectKey(media.path);
      if (
        media.sourceId === null
        || media.sourceId !== key.attachmentId
        || media.id !== `wordpress-attachment:${key.attachmentId}`
      ) {
        fail("invalid-media-provenance");
      }
      const plannedEntry = planned.get(media.path);
      const existingEntry = existing.get(media.path);
      const entry = plannedEntry === undefined
        ? existingEntry
        : {
          key: plannedEntry.key,
          bytes: plannedEntry.bytes,
          sha256: plannedEntry.sha256,
          sourceAttachmentId: plannedEntry.attachmentId
        };
      if (entry === undefined) {
        fail("missing-media-manifest-entry");
      }
      const prior = entries.get(entry.key);
      if (
        prior !== undefined
        && (
          prior.bytes !== entry.bytes
          || !fixedEqual(prior.sha256, entry.sha256)
          || prior.sourceAttachmentId !== entry.sourceAttachmentId
        )
      ) {
        fail("media-manifest-collision");
      }
      entries.set(entry.key, entry);
    }
  }

  try {
    return createRecipeMediaManifest([...entries.values()]);
  } catch {
    fail("invalid-media-manifest");
  }
}

function planMediaManifest(
  roots: PromotionRoots,
  existing: RecipeMediaManifest,
  exists: boolean,
  prospective: RecipeMediaManifest
): PlannedMediaManifest {
  return {
    action: exists
      ? canonicalEquals(existing, prospective) ? "reuse" : "replace"
      : "create",
    destination: roots.mediaManifest,
    expected: exists ? existing : null,
    manifest: prospective
  };
}

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

type FileProof = {
  readonly bytes: number;
  readonly dev: number;
  readonly ino: number;
  readonly sha256: string;
};

type FileDigest = {
  readonly bytes: number;
  readonly sha256: string;
};

type StagedArtifact = FileDigest & {
  readonly name: string;
  proof: FileProof | null;
};

type StagedArtifactPlan = FileDigest & {
  readonly destination: string;
  readonly name: string;
  readonly content: string;
};

type TransactionPhase =
  | "setup"
  | "prepared"
  | "publishing"
  | "rollback"
  | "cleanup";

type TransactionOutcome = "pending" | "committed" | "rolled-back";

type PromotionTransactionIdentity = {
  readonly source: {
    readonly sqlDecompressedSha256: string;
    readonly manifestSha256: string;
  };
  readonly contract: {
    readonly importerContractVersion: typeof wprmImportContractVersion;
    readonly mediaBindingVersion: 1;
  };
  readonly prototypeSeedSha256: string;
};

type PromotionTransaction = {
  readonly roots: PromotionRoots;
  readonly root: string;
  readonly stagedRecords: string;
  readonly backups: string;
  readonly journal: string;
  readonly bootstrap: string;
  readonly transactionId: string;
  readonly stagingRoot: string;
  readonly identity: PromotionTransactionIdentity;
  readonly key: Uint8Array;
  readonly failureInjection: WprmPromotionOptions["failureInjection"] | undefined;
  readonly stagedArtifacts: StagedArtifact[];
  readonly operations: TransactionOperation[];
  phase: TransactionPhase;
  outcome: TransactionOutcome;
  generation: number;
  backupSequence: number;
};

type PromotionTransactionLocation = {
  readonly root: string;
  readonly stagedRecords: string;
  readonly backups: string;
  readonly journal: string;
  readonly bootstrap: string;
  readonly transactionId: string;
};

const promotionJournalSchemaVersion = 3 as const;
const promotionBootstrapSchemaVersion = 1 as const;
const maxPromotionJournalBytes = 1_048_576;
const maxPromotionJournalOperations = 1_024;
const maxPromotionJournalPathBytes = 4_096;
const maxPromotionJournalArtifacts = 1_024;

type StagedPromotionPlan = {
  readonly records: ReadonlyMap<string, string>;
  readonly mediaManifest: string | undefined;
};

function promotionTransactionLocation(
  roots: PromotionRoots,
  stagingRoot: string
): PromotionTransactionLocation {
  const transactionId = createHash("sha256")
    .update(`${roots.repositoryRoot}\0${stagingRoot}`, "utf8")
    .digest("hex");
  const root = path.join(
    roots.migrationOutputRoot,
    `.wprm-promotion-${transactionId}`
  );
  return {
    root,
    stagedRecords: path.join(root, "records"),
    backups: path.join(root, "backups"),
    journal: path.join(root, "journal.json"),
    bootstrap: path.join(
      roots.migrationOutputRoot,
      `.wprm-promotion-${transactionId}.bootstrap.json`
    ),
    transactionId
  };
}

async function syncDirectory(directory: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isDirectory()) {
      fail("promotion-transaction-failed");
    }
    try {
      await handle.sync();
    } catch (error) {
      const code = error !== null
        && typeof error === "object"
        && "code" in error
        ? error.code
        : undefined;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") {
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof WprmPromotionError) {
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

type PromotionLock = {
  readonly root: string;
  readonly owner: string;
  readonly token: string;
  readonly parent: string;
};

const promotionLockName = ".wprm-promotion.lock";

function isPromotionLockOwner(value: unknown): value is {
  readonly schemaVersion: 1;
  readonly kind: "wprm-promotion-lock";
  readonly token: string;
} {
  return hasExactKeys(value, ["schemaVersion", "kind", "token"])
    && value.schemaVersion === 1
    && value.kind === "wprm-promotion-lock"
    && typeof value.token === "string"
    && /^[a-f0-9]{64}$/u.test(value.token);
}

async function writePrivateText(
  target: string,
  content: string,
  failureCode: string
) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail(failureCode);
  } finally {
    await handle?.close();
  }
}

async function acquirePromotionLock(
  roots: PromotionRoots
): Promise<PromotionLock> {
  await assertDirectoryChain(
    roots.repositoryRoot,
    roots.migrationOutputRoot,
    false
  );
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
        kind: "wprm-promotion-lock",
        token
      })}\n`,
      "promotion-lock-failed"
    );
    await syncDirectory(root);
    return {
      root,
      owner,
      token,
      parent: roots.migrationOutputRoot
    };
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-lock-failed");
  }
}

async function releasePromotionLock(lock: PromotionLock) {
  try {
    await assertPrivateDirectory(lock.root);
    const entries = await readdir(lock.root, {
      encoding: "utf8",
      withFileTypes: true
    });
    if (
      entries.length !== 1
      || entries[0]?.name !== "owner.json"
      || entries[0].isSymbolicLink()
      || !entries[0].isFile()
    ) {
      fail("promotion-lock-release-failed");
    }
    let owner: unknown;
    try {
      owner = JSON.parse((await readPrivateFile(lock.owner, 4 * 1024)).toString("utf8"));
    } catch {
      fail("promotion-lock-release-failed");
    }
    if (!isPromotionLockOwner(owner) || !fixedEqual(owner.token, lock.token)) {
      fail("promotion-lock-release-failed");
    }
    await unlink(lock.owner);
    await syncDirectory(lock.root);
    await rmdir(lock.root);
    await syncDirectory(lock.parent);
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-lock-release-failed");
  }
}

async function withPromotionLock<T>(
  roots: PromotionRoots,
  options: WprmPromotionOptions,
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

function transactionJournalUnsigned(
  transaction: PromotionTransaction,
  generation = transaction.generation
) {
  return {
    schemaVersion: promotionJournalSchemaVersion,
    kind: "wprm-promotion-transaction" as const,
    transactionId: transaction.transactionId,
    generation,
    phase: transaction.phase,
    outcome: transaction.outcome,
    repositoryRoot: transaction.roots.repositoryRoot,
    stagingRoot: transaction.stagingRoot,
    source: transaction.identity.source,
    contract: transaction.identity.contract,
    prototypeSeedSha256: transaction.identity.prototypeSeedSha256,
    stagedArtifacts: transaction.stagedArtifacts,
    operations: transaction.operations
  };
}

async function writePrivateTransactionJournal(transaction: PromotionTransaction) {
  const generation = transaction.generation + 1;
  const unsigned = transactionJournalUnsigned(transaction, generation);
  const authentication = createHmac("sha256", transaction.key)
    .update(canonicalCandidateJson(unsigned), "utf8")
    .digest("hex");
  const content = `${JSON.stringify({
    ...unsigned,
    authentication
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
  if (current !== null) {
    try {
      const location = transactionLocation(transaction);
      parsePromotionTransactionJournal(
        await readPrivateJsonBounded(transaction.journal, maxPromotionJournalBytes),
        transaction.roots,
        transaction.stagingRoot,
        transaction.identity,
        transaction.key,
        location,
        await readPromotionBootstrap(
          location,
          transaction.roots,
          transaction.stagingRoot,
          transaction.identity,
          transaction.key
        )
      );
    } catch {
      fail("invalid-promotion-journal");
    }
  }
  const temporary = path.join(
    transaction.root,
    `.journal.${randomBytes(16).toString("hex")}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (created) {
      try {
        await unlink(temporary);
        await syncDirectory(transaction.root);
      } catch {
        // Preserve the journal failure.
      }
    }
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-transaction-failed");
  } finally {
    await handle?.close();
  }
  try {
    await rename(temporary, transaction.journal);
    await syncDirectory(transaction.root);
    transaction.generation = generation;
  } catch {
    fail("promotion-transaction-failed");
  }
}

type PromotionTransactionBootstrap = {
  readonly schemaVersion: typeof promotionBootstrapSchemaVersion;
  readonly kind: "wprm-promotion-bootstrap";
  readonly transactionId: string;
  readonly phase: "setup" | "cleanup";
  readonly outcome: TransactionOutcome;
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly source: PromotionTransactionIdentity["source"];
  readonly contract: PromotionTransactionIdentity["contract"];
  readonly prototypeSeedSha256: string;
  readonly authentication: string;
};

function transactionBootstrapUnsigned(
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  phase: "setup" | "cleanup",
  outcome: TransactionOutcome
) {
  return {
    schemaVersion: promotionBootstrapSchemaVersion,
    kind: "wprm-promotion-bootstrap" as const,
    transactionId: location.transactionId,
    phase,
    outcome,
    repositoryRoot: roots.repositoryRoot,
    stagingRoot,
    source: identity.source,
    contract: identity.contract,
    prototypeSeedSha256: identity.prototypeSeedSha256
  };
}

function parsePromotionTransactionBootstrap(
  value: unknown,
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array
): PromotionTransactionBootstrap {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "kind",
      "transactionId",
      "phase",
      "outcome",
      "repositoryRoot",
      "stagingRoot",
      "source",
      "contract",
      "prototypeSeedSha256",
      "authentication"
    ])
    || value.schemaVersion !== promotionBootstrapSchemaVersion
    || value.kind !== "wprm-promotion-bootstrap"
    || value.transactionId !== location.transactionId
    || (value.phase !== "setup" && value.phase !== "cleanup")
    || (
      value.outcome !== "pending"
      && value.outcome !== "committed"
      && value.outcome !== "rolled-back"
    )
    || (
      value.phase === "cleanup"
        ? value.outcome === "pending"
        : value.outcome !== "pending"
    )
    || value.repositoryRoot !== roots.repositoryRoot
    || value.stagingRoot !== stagingRoot
    || !isPromotionTransactionSource(value.source)
    || !isPromotionTransactionContract(value.contract)
    || typeof value.prototypeSeedSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.prototypeSeedSha256)
    || typeof value.authentication !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.authentication)
  ) {
    fail("invalid-promotion-journal");
  }
  const unsigned = transactionBootstrapUnsigned(
    location,
    roots,
    stagingRoot,
    {
      source: value.source,
      contract: value.contract,
      prototypeSeedSha256: value.prototypeSeedSha256
    },
    value.phase,
    value.outcome
  );
  const expectedAuthentication = createHmac("sha256", key)
    .update(canonicalCandidateJson(unsigned), "utf8")
    .digest("hex");
  if (
    !fixedEqual(expectedAuthentication, value.authentication)
    || !canonicalEquals(value.source, identity.source)
    || !canonicalEquals(value.contract, identity.contract)
    || value.prototypeSeedSha256 !== identity.prototypeSeedSha256
  ) {
    fail("invalid-promotion-journal");
  }
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    transactionId: value.transactionId,
    phase: value.phase,
    outcome: value.outcome,
    repositoryRoot: value.repositoryRoot,
    stagingRoot: value.stagingRoot,
    source: value.source,
    contract: value.contract,
    prototypeSeedSha256: value.prototypeSeedSha256,
    authentication: value.authentication
  };
}

function bootstrapTemporaryName(location: PromotionTransactionLocation, nonce: string) {
  return `.wprm-promotion-${location.transactionId}.bootstrap.${nonce}.tmp`;
}

function isBootstrapTemporaryName(
  location: PromotionTransactionLocation,
  name: string
) {
  return new RegExp(
    `^\\.wprm-promotion-${location.transactionId}\\.bootstrap\\.[a-f0-9]{32}\\.tmp$`,
    "u"
  ).test(name);
}

async function writePromotionTransactionBootstrap(
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  phase: "setup" | "cleanup" = "setup",
  outcome: TransactionOutcome = "pending",
  replace = false
) {
  const currentBootstrap = await existingStats(location.bootstrap);
  const currentRoot = await existingStats(location.root);
  if (
    (!replace && (currentBootstrap !== null || currentRoot !== null))
    || (replace && currentBootstrap === null)
  ) {
    fail("promotion-transaction-recovery-required");
  }
  if (replace) {
    try {
      parsePromotionTransactionBootstrap(
        await readPrivateJsonBounded(location.bootstrap, 16 * 1024),
        location,
        roots,
        stagingRoot,
        identity,
        key
      );
    } catch {
      fail("invalid-promotion-journal");
    }
  }
  const unsigned = transactionBootstrapUnsigned(
    location,
    roots,
    stagingRoot,
    identity,
    phase,
    outcome
  );
  const authentication = createHmac("sha256", key)
    .update(canonicalCandidateJson(unsigned), "utf8")
    .digest("hex");
  const temporary = path.join(
    roots.migrationOutputRoot,
    bootstrapTemporaryName(location, randomBytes(16).toString("hex"))
  );
  await writePrivateText(
    temporary,
    `${JSON.stringify({ ...unsigned, authentication })}\n`,
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

async function persistPromotionTransactionCleanupBootstrap(
  transaction: PromotionTransaction
) {
  if (
    transaction.phase !== "cleanup"
    || (transaction.outcome !== "committed" && transaction.outcome !== "rolled-back")
  ) {
    fail("promotion-transaction-failed");
  }
  await writePromotionTransactionBootstrap(
    {
      root: transaction.root,
      stagedRecords: transaction.stagedRecords,
      backups: transaction.backups,
      journal: transaction.journal,
      bootstrap: transaction.bootstrap,
      transactionId: transaction.transactionId
    },
    transaction.roots,
    transaction.stagingRoot,
    transaction.identity,
    transaction.key,
    "cleanup",
    transaction.outcome,
    true
  );
}

async function createPromotionTransaction(
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  failureInjection: WprmPromotionOptions["failureInjection"] | undefined,
  stagedArtifactPlans: readonly StagedArtifactPlan[]
) {
  const location = promotionTransactionLocation(roots, stagingRoot);
  await assertDirectoryChain(
    roots.repositoryRoot,
    roots.migrationOutputRoot,
    false
  );
  if (stagedArtifactPlans.length > maxPromotionJournalArtifacts) {
    fail("promotion-stage-failed");
  }
  await writePromotionTransactionBootstrap(
    location,
    roots,
    stagingRoot,
    identity,
    key
  );
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
    await mkdir(location.stagedRecords, { mode: 0o700 });
    await syncDirectory(location.root);
  } catch {
    fail("promotion-transaction-recovery-required");
  }
  await assertPrivateDirectory(location.stagedRecords);
  interruptAt(failureInjection, "after-transaction-records-directory");
  try {
    await mkdir(location.backups, { mode: 0o700 });
    await syncDirectory(location.root);
  } catch {
    fail("promotion-transaction-recovery-required");
  }
  await assertPrivateDirectory(location.backups);
  interruptAt(failureInjection, "after-transaction-backups-directory");
  const transaction: PromotionTransaction = {
    roots,
    root: location.root,
    stagedRecords: location.stagedRecords,
    backups: location.backups,
    journal: location.journal,
    bootstrap: location.bootstrap,
    transactionId: location.transactionId,
    stagingRoot,
    identity,
    key,
    failureInjection,
    stagedArtifacts: stagedArtifactPlans.map((artifact) => ({
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      proof: null
    })),
    operations: [],
    phase: "setup",
    outcome: "pending",
    generation: 0,
    backupSequence: stagedArtifactPlans.length
  };
  await writePrivateTransactionJournal(transaction);
  interruptAt(failureInjection, "after-initial-transaction-journal");
  return transaction;
}

type PromotionTransactionJournal = {
  readonly schemaVersion: typeof promotionJournalSchemaVersion;
  readonly kind: "wprm-promotion-transaction";
  readonly transactionId: string;
  readonly generation: number;
  readonly phase: TransactionPhase;
  readonly outcome: TransactionOutcome;
  readonly repositoryRoot: string;
  readonly stagingRoot: string;
  readonly source: PromotionTransactionIdentity["source"];
  readonly contract: PromotionTransactionIdentity["contract"];
  readonly prototypeSeedSha256: string;
  readonly stagedArtifacts: readonly StagedArtifact[];
  readonly operations: readonly TransactionOperation[];
  readonly authentication: string;
};

function isFileProof(value: unknown): value is FileProof {
  return hasExactKeys(value, ["bytes", "dev", "ino", "sha256"])
    && typeof value.bytes === "number"
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.dev === "number"
    && Number.isSafeInteger(value.dev)
    && value.dev >= 0
    && typeof value.ino === "number"
    && Number.isSafeInteger(value.ino)
    && value.ino >= 0
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function isFileDigest(value: unknown): value is FileDigest {
  return hasExactKeys(value, ["bytes", "sha256"])
    && typeof value.bytes === "number"
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 0
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function isStagedArtifact(value: unknown): value is StagedArtifact {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && hasExactKeys(value, ["name", "bytes", "sha256", "proof"])
    && typeof value.name === "string"
    && typeof value.sha256 === "string"
    && /^\d+\.(?:json|media-manifest\.json)$/u.test(value.name)
    && isFileDigest({
      bytes: value.bytes,
      sha256: value.sha256
    })
    && (value.proof === null || isFileProof(value.proof))
    && (
      value.proof === null
      || (
        value.proof.bytes === value.bytes
        && fixedEqual(value.proof.sha256, value.sha256)
      )
    );
}

function isPromotionTransactionSource(
  value: unknown
): value is PromotionTransactionIdentity["source"] {
  return hasExactKeys(value, ["sqlDecompressedSha256", "manifestSha256"])
    && typeof value.sqlDecompressedSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sqlDecompressedSha256)
    && typeof value.manifestSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.manifestSha256);
}

function isPromotionTransactionContract(
  value: unknown
): value is PromotionTransactionIdentity["contract"] {
  return hasExactKeys(value, [
    "importerContractVersion",
    "mediaBindingVersion"
  ])
    && value.importerContractVersion === wprmImportContractVersion
    && value.mediaBindingVersion === 1;
}

function isTransactionOperation(value: unknown): value is TransactionOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
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
    return hasExactKeys(record, [
      "kind",
      "destination",
      "staged",
      "stagedProof",
      "state"
    ])
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
  if (record.kind === "remove") {
    return hasExactKeys(record, [
      "kind",
      "destination",
      "backup",
      "backupProof",
      "state"
    ])
      && typeof record.backup === "string"
      && isFileProof(record.backupProof);
  }
  return false;
}

function isTransactionPath(value: unknown) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxPromotionJournalPathBytes
    && path.isAbsolute(value)
    && !value.includes("\0")
    && path.normalize(value) === value;
}

function isAllowedLiveTransactionPath(roots: PromotionRoots, target: string) {
  return target === roots.mediaManifest
    || (
      isWithin(target, roots.contentRoot)
      && target !== roots.contentRoot
      && path.extname(target) === ".json"
    )
    || (
      isWithin(target, roots.mediaRoot)
      && target !== roots.mediaRoot
    );
}

function transactionRelativeFile(
  target: string,
  directory: string,
  pattern: RegExp
) {
  if (!isTransactionPath(target) || !isWithin(target, directory)) {
    return null;
  }
  const relative = path.relative(directory, target);
  if (
    relative.length === 0
    || relative.includes(path.sep)
    || path.basename(relative) !== relative
    || !pattern.test(relative)
  ) {
    return null;
  }
  return relative;
}

function parsePromotionTransactionJournal(
  value: unknown,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  location: PromotionTransactionLocation,
  bootstrap: PromotionTransactionBootstrap
): PromotionTransactionJournal {
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
      "source",
      "contract",
      "prototypeSeedSha256",
      "stagedArtifacts",
      "operations",
      "authentication"
    ])
    || value.schemaVersion !== promotionJournalSchemaVersion
    || value.kind !== "wprm-promotion-transaction"
    || value.transactionId !== location.transactionId
    || typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || value.generation > 1_000_000
    || (
      value.phase !== "setup"
      && value.phase !== "prepared"
      && value.phase !== "publishing"
      && value.phase !== "rollback"
      && value.phase !== "cleanup"
    )
    || (
      value.outcome !== "pending"
      && value.outcome !== "committed"
      && value.outcome !== "rolled-back"
    )
    || (
      value.phase === "cleanup"
        ? value.outcome === "pending"
        : value.outcome !== "pending"
    )
    || value.repositoryRoot !== roots.repositoryRoot
    || value.stagingRoot !== stagingRoot
    || !isPromotionTransactionSource(value.source)
    || !isPromotionTransactionContract(value.contract)
    || typeof value.prototypeSeedSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.prototypeSeedSha256)
    || !Array.isArray(value.stagedArtifacts)
    || value.stagedArtifacts.length > maxPromotionJournalArtifacts
    || !value.stagedArtifacts.every(isStagedArtifact)
    || !Array.isArray(value.operations)
    || value.operations.length > maxPromotionJournalOperations
    || !value.operations.every(isTransactionOperation)
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
    source: value.source,
    contract: value.contract,
    prototypeSeedSha256: value.prototypeSeedSha256,
    stagedArtifacts: value.stagedArtifacts,
    operations: value.operations
  };
  const expectedAuthentication = createHmac("sha256", key)
    .update(canonicalCandidateJson(unsigned), "utf8")
    .digest("hex");
  if (!fixedEqual(expectedAuthentication, value.authentication)) {
    fail("invalid-promotion-journal");
  }
  if (
    !canonicalEquals(value.source, identity.source)
    || !canonicalEquals(value.contract, identity.contract)
    || value.prototypeSeedSha256 !== identity.prototypeSeedSha256
    || !canonicalEquals(value.source, bootstrap.source)
    || !canonicalEquals(value.contract, bootstrap.contract)
    || value.prototypeSeedSha256 !== bootstrap.prototypeSeedSha256
    || (
      bootstrap.phase === "cleanup"
      && (
        value.phase !== "cleanup"
        || value.outcome !== bootstrap.outcome
      )
    )
  ) {
    fail("invalid-promotion-journal");
  }
  if (
    (
      value.phase === "cleanup"
      && value.outcome === "committed"
      && value.operations.some((operation) => operation.state !== "published")
    )
    || (
      value.phase === "cleanup"
      && value.outcome === "rolled-back"
      && value.operations.some((operation) => operation.state !== "rolled-back")
    )
    || (
      value.phase !== "rollback"
      && value.phase !== "cleanup"
      && value.operations.some((operation) => operation.state === "rolled-back")
    )
  ) {
    fail("invalid-promotion-journal");
  }

  const destinations = new Set<string>();
  const staged = new Set<string>();
  const backups = new Set<string>();
  const artifacts = new Map(
    value.stagedArtifacts.map((artifact) => [artifact.name, artifact] as const)
  );
  if (artifacts.size !== value.stagedArtifacts.length) {
    fail("invalid-promotion-journal");
  }
  for (const operation of value.operations) {
    if (
      !isTransactionPath(operation.destination)
      || !isAllowedLiveTransactionPath(roots, operation.destination)
      || destinations.has(operation.destination)
    ) {
      fail("invalid-promotion-journal");
    }
    destinations.add(operation.destination);

    if (operation.kind === "create" || operation.kind === "replace") {
      const stagedName = transactionRelativeFile(
        operation.staged,
        location.stagedRecords,
        /^\d+\.(?:json|media-manifest\.json)$/u
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
    }
    if (operation.kind === "replace" || operation.kind === "remove") {
      const backupName = transactionRelativeFile(
        operation.backup,
        location.backups,
        operation.kind === "replace"
          ? /^\d+\.replacement$/u
          : /^\d+\.prototype-placeholder$/u
      );
      if (backupName === null || backups.has(backupName)) {
        fail("invalid-promotion-journal");
      }
      backups.add(backupName);
    }
    if (
      operation.kind === "remove"
      && !isWithin(operation.destination, roots.mediaRoot)
    ) {
      fail("invalid-promotion-journal");
    }
  }

  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    transactionId: value.transactionId,
    generation: value.generation,
    phase: value.phase,
    outcome: value.outcome,
    repositoryRoot: value.repositoryRoot,
    stagingRoot: value.stagingRoot,
    source: value.source,
    contract: value.contract,
    prototypeSeedSha256: value.prototypeSeedSha256,
    stagedArtifacts: value.stagedArtifacts.map((artifact) => ({
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      proof: artifact.proof === null
        ? null
        : {
          bytes: artifact.proof.bytes,
          dev: artifact.proof.dev,
          ino: artifact.proof.ino,
          sha256: artifact.proof.sha256
        }
    })),
    operations: value.operations.map((operation) => ({ ...operation })),
    authentication: value.authentication
  };
}

function isOwnedByCurrentUser(stats: { readonly uid?: number }) {
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

async function boundedPromotionDirectoryEntries(
  directory: string,
  maximum: number
) {
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
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("invalid-promotion-journal");
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error) {
        if (
          !error
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

async function validatePromotionTransactionTree(
  location: PromotionTransactionLocation,
  journal: PromotionTransactionJournal
) {
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
  const stagedDirectoryStats = await existingStats(location.stagedRecords);
  const backupDirectoryStats = await existingStats(location.backups);
  for (const stats of [stagedDirectoryStats, backupDirectoryStats]) {
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
  if (
    journal.phase !== "cleanup"
    && (stagedDirectoryStats === null || backupDirectoryStats === null)
  ) {
    fail("invalid-promotion-journal");
  }
  const expectedStaged = new Map(
    journal.stagedArtifacts.map((artifact) => [artifact.name, artifact] as const)
  );
  const expectedBackups = new Map(
    journal.operations
      .filter((operation) => operation.kind === "replace" || operation.kind === "remove")
      .map((operation) => [
        path.basename(operation.backup),
        operation.backupProof
      ] as const)
  );
  if (
    expectedBackups.size !== journal.operations.filter(
      (operation) => operation.kind === "replace" || operation.kind === "remove"
    ).length
  ) {
    fail("invalid-promotion-journal");
  }
  let rootEntries: Dirent[];
  try {
    rootEntries = await boundedPromotionDirectoryEntries(
      location.root,
      maxPromotionJournalOperations + 3
    );
  } catch {
    fail("invalid-promotion-journal");
  }
  const expectedRootNames = new Set([
    "journal.json",
    ...(stagedDirectoryStats === null ? [] : ["records"]),
    ...(backupDirectoryStats === null ? [] : ["backups"])
  ]);
  if (
    rootEntries.length > maxPromotionJournalOperations + 3
    || rootEntries.some(
      (entry) =>
        entry.isSymbolicLink()
        || !expectedRootNames.has(entry.name)
        || (
          entry.name === "journal.json"
            ? !entry.isFile()
            : !entry.isDirectory()
        )
    )
    || rootEntries.length !== expectedRootNames.size
  ) {
    fail("invalid-promotion-journal");
  }

  if (stagedDirectoryStats !== null) {
    const stagedEntries = await boundedPromotionDirectoryEntries(
      location.stagedRecords,
      maxPromotionJournalArtifacts + 1
    );
    for (const entry of stagedEntries) {
      const artifact = expectedStaged.get(entry.name);
      const target = path.join(location.stagedRecords, entry.name);
      if (
        artifact === undefined
        || entry.isSymbolicLink()
        || !entry.isFile()
        || !(await matchesStagedArtifact(target, artifact))
      ) {
        fail("invalid-promotion-journal");
      }
    }
  }

  if (backupDirectoryStats !== null) {
    const backupEntries = await boundedPromotionDirectoryEntries(
      location.backups,
      maxPromotionJournalOperations + 1
    );
    for (const entry of backupEntries) {
      const proof = expectedBackups.get(entry.name);
      const target = path.join(location.backups, entry.name);
      const stats = await existingStats(target);
      if (
        proof === undefined
        || entry.isSymbolicLink()
        || !entry.isFile()
        || stats === null
        || !isRegularFile(stats)
        || !isOwnedByCurrentUser(stats)
        || !await proofMatches(target, proof)
      ) {
        fail("invalid-promotion-journal");
      }
    }
  }
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

type PromotionRecoveryAction = {
  readonly operation: TransactionOperation;
  readonly action: "none" | "remove-created" | "restore";
};

async function inspectPromotionRecoveryOperation(
  operation: TransactionOperation
): Promise<PromotionRecoveryAction> {
  const destinationStats = await existingStats(operation.destination);
  if (
    destinationStats !== null
    && (
      !isRegularFile(destinationStats)
      || !isOwnedByCurrentUser(destinationStats)
    )
  ) {
    fail("invalid-promotion-journal");
  }
  if (operation.kind === "create") {
    if (destinationStats === null) {
      return { operation, action: "none" };
    }
    if (!await proofMatches(operation.destination, operation.stagedProof)) {
      fail("invalid-promotion-journal");
    }
    return { operation, action: "remove-created" };
  }

  const backupStats = await existingStats(operation.backup);
  if (backupStats !== null && (
    !isRegularFile(backupStats)
    || !isOwnedByCurrentUser(backupStats)
    || !await proofMatches(operation.backup, operation.backupProof)
  )) {
    fail("invalid-promotion-journal");
  }
  if (operation.kind === "replace") {
    if (backupStats !== null) {
      if (
        destinationStats !== null
        && !await proofMatches(operation.destination, operation.stagedProof)
      ) {
        fail("invalid-promotion-journal");
      }
      return { operation, action: "restore" };
    }
    if (
      destinationStats !== null
      && await proofMatches(operation.destination, operation.backupProof)
    ) {
      return { operation, action: "none" };
    }
    fail("invalid-promotion-journal");
  }

  if (backupStats !== null) {
    if (destinationStats !== null) {
      fail("invalid-promotion-journal");
    }
    return { operation, action: "restore" };
  }
  if (
    destinationStats !== null
    && await proofMatches(operation.destination, operation.backupProof)
  ) {
    return { operation, action: "none" };
  }
  fail("invalid-promotion-journal");
}

async function executePromotionRecoveryAction(
  action: PromotionRecoveryAction,
  failureInjection: WprmPromotionOptions["failureInjection"] | undefined
) {
  if (action.action === "none") {
    return;
  }
  const { operation } = action;
  if (operation.kind === "create") {
    const destinationStats = await existingStats(operation.destination);
    if (destinationStats === null) {
      return;
    }
    if (!isRegularFile(destinationStats) || !isOwnedByCurrentUser(destinationStats)) {
      fail("promotion-journal-recovery-failed");
    }
    if (!await proofMatches(operation.destination, operation.stagedProof)) {
      fail("promotion-journal-recovery-failed");
    }
    await unlink(operation.destination);
    await syncDirectory(path.dirname(operation.destination));
    interruptAt(failureInjection, "after-rollback-create-unlink");
    return;
  }

  const backupStats = await existingStats(operation.backup);
  if (
    backupStats === null
    || !isRegularFile(backupStats)
    || !isOwnedByCurrentUser(backupStats)
    || !await proofMatches(operation.backup, operation.backupProof)
  ) {
    fail("promotion-journal-recovery-failed");
  }
  if (operation.kind === "replace") {
    const destinationStats = await existingStats(operation.destination);
    if (destinationStats !== null) {
      if (!isRegularFile(destinationStats) || !isOwnedByCurrentUser(destinationStats)) {
        fail("promotion-journal-recovery-failed");
      }
      if (!await proofMatches(operation.destination, operation.stagedProof)) {
        fail("promotion-journal-recovery-failed");
      }
      await unlink(operation.destination);
      await syncDirectory(path.dirname(operation.destination));
      interruptAt(failureInjection, "after-rollback-replacement-unlink");
    }
  } else {
    const destinationStats = await existingStats(operation.destination);
    if (destinationStats !== null) {
      fail("promotion-journal-recovery-failed");
    }
  }
  if (await existingStats(operation.destination) !== null) {
    fail("promotion-journal-recovery-failed");
  }
  await rename(operation.backup, operation.destination);
  await syncDirectory(path.dirname(operation.destination));
  await syncDirectory(path.dirname(operation.backup));
  interruptAt(failureInjection, "after-rollback-backup-rename");
}

async function validateRestoredPromotionCatalog(
  roots: PromotionRoots,
  requirePublishedBehavior = false
) {
  try {
    const loaded = loadRecipeCatalogWithSources(roots.contentRoot);
    validateCatalog(loaded.records);
    const manifestStats = await existingStats(roots.mediaManifest);
    const mediaManifest = manifestStats === null
      ? createRecipeMediaManifest([])
      : loadRecipeMediaManifest(roots.mediaManifest);
    validateMediaPaths(
      loaded.records,
      path.join(roots.repositoryRoot, "public"),
      mediaManifest
    );
    validateRecipeMediaManifestClosure(loaded.records, mediaManifest);
    if (requirePublishedBehavior) {
      validateCatalogBehavior(loaded.records);
      createStaticWebAppConfig(loaded.records);
    }
  } catch {
    fail("promotion-journal-recovery-failed");
  }
}

function transactionLocation(
  transaction: PromotionTransaction
): PromotionTransactionLocation {
  return {
    root: transaction.root,
    stagedRecords: transaction.stagedRecords,
    backups: transaction.backups,
    journal: transaction.journal,
    bootstrap: transaction.bootstrap,
    transactionId: transaction.transactionId
  };
}

async function removePrivatePromotionTree(transaction: PromotionTransaction) {
  if (
    transaction.phase !== "cleanup"
    || (transaction.outcome !== "committed" && transaction.outcome !== "rolled-back")
  ) {
    fail("promotion-transaction-cleanup-failed");
  }
  const location = transactionLocation(transaction);
  try {
    await assertPrivateDirectory(location.root);
    const current = parsePromotionTransactionJournal(
      await readPrivateJsonBounded(location.journal, maxPromotionJournalBytes),
      transaction.roots,
      transaction.stagingRoot,
      transaction.identity,
      transaction.key,
      location,
      parsePromotionTransactionBootstrap(
        await readPrivateJsonBounded(location.bootstrap, 16 * 1024),
        location,
        transaction.roots,
        transaction.stagingRoot,
        transaction.identity,
        transaction.key
      )
    );
    if (
      current.phase !== transaction.phase
      || current.outcome !== transaction.outcome
      || current.generation !== transaction.generation
    ) {
      fail("promotion-transaction-cleanup-failed");
    }
    await validatePromotionTransactionTree(location, current);

    const artifacts = new Map(
      current.stagedArtifacts.map((artifact) => [artifact.name, artifact] as const)
    );
    const stagedStats = await existingStats(location.stagedRecords);
    if (stagedStats !== null) {
      await assertPrivateDirectory(location.stagedRecords);
      const entries = await boundedPromotionDirectoryEntries(
        location.stagedRecords,
        maxPromotionJournalArtifacts + 1
      );
      for (const entry of entries) {
        const artifact = artifacts.get(entry.name);
        const target = path.join(location.stagedRecords, entry.name);
        if (
          artifact === undefined
          || entry.isSymbolicLink()
          || !entry.isFile()
          || !await matchesStagedArtifact(target, artifact)
        ) {
          fail("promotion-transaction-cleanup-failed");
        }
        await unlink(target);
        await syncDirectory(location.stagedRecords);
        interruptAt(transaction.failureInjection, "after-cleanup-staged-unlink");
      }
      await rmdir(location.stagedRecords);
      await syncDirectory(location.root);
    }

    const backups = new Map(
      current.operations
        .filter((operation) => operation.kind === "replace" || operation.kind === "remove")
        .map((operation) => [
          path.basename(operation.backup),
          operation.backupProof
        ] as const)
    );
    const backupStats = await existingStats(location.backups);
    if (backupStats !== null) {
      await assertPrivateDirectory(location.backups);
      const entries = await boundedPromotionDirectoryEntries(
        location.backups,
        maxPromotionJournalOperations + 1
      );
      for (const entry of entries) {
        const expected = backups.get(entry.name);
        const target = path.join(location.backups, entry.name);
        const stats = await existingStats(target);
        if (
          expected === undefined
          || entry.isSymbolicLink()
          || !entry.isFile()
          || stats === null
          || !isRegularFile(stats)
          || !isOwnedByCurrentUser(stats)
          || !await proofMatches(target, expected)
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

    const journalStats = await existingStats(location.journal);
    if (
      journalStats === null
      || !isRegularFile(journalStats)
      || !isPrivateOwned(journalStats)
      || (journalStats.mode & 0o777) !== 0o600
    ) {
      fail("promotion-transaction-cleanup-failed");
    }
    await unlink(location.journal);
    await syncDirectory(location.root);
    interruptAt(transaction.failureInjection, "after-cleanup-journal-unlink");
    const remaining = await boundedPromotionDirectoryEntries(location.root, 1);
    if (remaining.length !== 0) {
      fail("promotion-transaction-cleanup-failed");
    }
    await rmdir(location.root);
    await syncDirectory(transaction.roots.migrationOutputRoot);
    const bootstrap = parsePromotionTransactionBootstrap(
      await readPrivateJsonBounded(location.bootstrap, 16 * 1024),
      location,
      transaction.roots,
      transaction.stagingRoot,
      transaction.identity,
      transaction.key
    );
    if (
      bootstrap.phase !== "cleanup"
      || bootstrap.outcome !== transaction.outcome
    ) {
      fail("promotion-transaction-cleanup-failed");
    }
    await unlink(location.bootstrap);
    await syncDirectory(transaction.roots.migrationOutputRoot);
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-transaction-cleanup-failed");
  }
}

function isJournalTemporaryName(name: string) {
  return /^\.journal\.[a-f0-9]{32}\.tmp$/u.test(name);
}

async function readPromotionBootstrap(
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array
) {
  return parsePromotionTransactionBootstrap(
    await readPrivateJsonBounded(location.bootstrap, 16 * 1024),
    location,
    roots,
    stagingRoot,
    identity,
    key
  );
}

async function removeAuthenticatedBootstrapTemps(
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array
) {
  const entries = await boundedPromotionDirectoryEntries(
    roots.migrationOutputRoot,
    4_096
  );
  for (const entry of entries) {
    if (!isBootstrapTemporaryName(location, entry.name)) {
      continue;
    }
    const target = path.join(roots.migrationOutputRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail("invalid-promotion-journal");
    }
    parsePromotionTransactionBootstrap(
      await readPrivateJsonBounded(target, 16 * 1024),
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
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  bootstrap: PromotionTransactionBootstrap
) {
  const entries = await boundedPromotionDirectoryEntries(
    location.root,
    maxPromotionJournalOperations + 4
  );
  for (const entry of entries) {
    if (!isJournalTemporaryName(entry.name)) {
      continue;
    }
    const target = path.join(location.root, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail("invalid-promotion-journal");
    }
    parsePromotionTransactionJournal(
      await readPrivateJsonBounded(target, maxPromotionJournalBytes),
      roots,
      stagingRoot,
      identity,
      key,
      location,
      bootstrap
    );
    await unlink(target);
    await syncDirectory(location.root);
  }
}

async function removeBootstrapOnlyTransaction(
  location: PromotionTransactionLocation,
  roots: PromotionRoots,
  bootstrap: PromotionTransactionBootstrap
) {
  const rootStats = await existingStats(location.root);
  if (rootStats === null) {
    await unlink(location.bootstrap);
    await syncDirectory(roots.migrationOutputRoot);
    return;
  }
  await assertPrivateDirectory(location.root);
  const journalStats = await existingStats(location.journal);
  if (journalStats !== null) {
    fail("invalid-promotion-journal");
  }
  const rootEntries = await boundedPromotionDirectoryEntries(location.root, 4);
  if (bootstrap.phase === "cleanup") {
    if (rootEntries.length !== 0) {
      fail("invalid-promotion-journal");
    }
    await rmdir(location.root);
    await syncDirectory(roots.migrationOutputRoot);
    await unlink(location.bootstrap);
    await syncDirectory(roots.migrationOutputRoot);
    return;
  }
  if (
    rootEntries.some(
      (entry) =>
        entry.isSymbolicLink()
        || !entry.isDirectory()
        || (entry.name !== "records" && entry.name !== "backups")
    )
  ) {
    fail("invalid-promotion-journal");
  }
  for (const name of ["records", "backups"] as const) {
    const directory = path.join(location.root, name);
    const stats = await existingStats(directory);
    if (stats === null) {
      continue;
    }
    await assertPrivateDirectory(directory);
    if ((await boundedPromotionDirectoryEntries(directory, 1)).length !== 0) {
      fail("invalid-promotion-journal");
    }
    await rmdir(directory);
    await syncDirectory(location.root);
  }
  if ((await boundedPromotionDirectoryEntries(location.root, 1)).length !== 0) {
    fail("invalid-promotion-journal");
  }
  await rmdir(location.root);
  await syncDirectory(roots.migrationOutputRoot);
  await unlink(location.bootstrap);
  await syncDirectory(roots.migrationOutputRoot);
}

function transactionFromJournal(
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  location: PromotionTransactionLocation,
  journal: PromotionTransactionJournal,
  failureInjection: WprmPromotionOptions["failureInjection"] | undefined
): PromotionTransaction {
  return {
    roots,
    root: location.root,
    stagedRecords: location.stagedRecords,
    backups: location.backups,
    journal: location.journal,
    bootstrap: location.bootstrap,
    transactionId: location.transactionId,
    stagingRoot,
    identity,
    key,
    failureInjection,
    stagedArtifacts: journal.stagedArtifacts.map((artifact) => ({
      name: artifact.name,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      proof: artifact.proof === null
        ? null
        : {
          bytes: artifact.proof.bytes,
          dev: artifact.proof.dev,
          ino: artifact.proof.ino,
          sha256: artifact.proof.sha256
        }
    })),
    operations: journal.operations.map((operation) => ({ ...operation })),
    phase: journal.phase,
    outcome: journal.outcome,
    generation: journal.generation,
    backupSequence: journal.stagedArtifacts.length
  };
}

async function persistTransactionState(
  transaction: PromotionTransaction,
  phase: TransactionPhase,
  outcome: TransactionOutcome,
  interruptionPoint:
    | "after-rollback-transaction-journal"
    | "after-cleanup-transaction-journal"
    | "after-prepared-transaction-journal"
    | "after-publishing-transaction-journal"
    | undefined = undefined
) {
  const previousPhase = transaction.phase;
  const previousOutcome = transaction.outcome;
  transaction.phase = phase;
  transaction.outcome = outcome;
  try {
    await writePrivateTransactionJournal(transaction);
  } catch (error) {
    transaction.phase = previousPhase;
    transaction.outcome = previousOutcome;
    throw error;
  }
  if (interruptionPoint !== undefined) {
    interruptAt(transaction.failureInjection, interruptionPoint);
  }
}

async function persistTransactionCleanupState(
  transaction: PromotionTransaction,
  outcome: Extract<TransactionOutcome, "committed" | "rolled-back">
) {
  await persistTransactionState(
    transaction,
    "cleanup",
    outcome,
    "after-cleanup-transaction-journal"
  );
  await persistPromotionTransactionCleanupBootstrap(transaction);
}

async function rollbackPromotionOperation(
  transaction: PromotionTransaction,
  operation: TransactionOperation
) {
  const action = await inspectPromotionRecoveryOperation(operation);
  await executePromotionRecoveryAction(action, transaction.failureInjection);
  operation.state = "rolled-back";
  await writePrivateTransactionJournal(transaction);
}

async function recoverPromotionTransaction(
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  failureInjection: WprmPromotionOptions["failureInjection"] | undefined
) {
  const location = promotionTransactionLocation(roots, stagingRoot);
  try {
    await removeAuthenticatedBootstrapTemps(
      location,
      roots,
      stagingRoot,
      identity,
      key
    );
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw new WprmPromotionError("invalid-promotion-journal");
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
  let bootstrap: PromotionTransactionBootstrap;
  try {
    bootstrap = await readPromotionBootstrap(
      location,
      roots,
      stagingRoot,
      identity,
      key
    );
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw new WprmPromotionError("invalid-promotion-journal");
    }
    fail("invalid-promotion-journal");
  }
  if (rootStats === null) {
    try {
      await removeBootstrapOnlyTransaction(location, roots, bootstrap);
      return;
    } catch (error) {
      if (error instanceof WprmPromotionError) {
        throw new WprmPromotionError("invalid-promotion-journal");
      }
      fail("invalid-promotion-journal");
    }
  }

  const journalStats = await existingStats(location.journal);
  if (journalStats === null) {
    try {
      await assertPrivateDirectory(location.root);
      await removeAuthenticatedJournalTemps(
        location,
        roots,
        stagingRoot,
        identity,
        key,
        bootstrap
      );
      await removeBootstrapOnlyTransaction(location, roots, bootstrap);
      return;
    } catch (error) {
      if (error instanceof WprmPromotionError) {
        throw new WprmPromotionError("invalid-promotion-journal");
      }
      fail("invalid-promotion-journal");
    }
  }

  let journal: PromotionTransactionJournal;
  try {
    await assertPrivateDirectory(location.root);
    journal = parsePromotionTransactionJournal(
      await readPrivateJsonBounded(location.journal, maxPromotionJournalBytes),
      roots,
      stagingRoot,
      identity,
      key,
      location,
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
    await validatePromotionTransactionTree(location, journal);
    for (const operation of journal.operations) {
      await assertDirectoryChain(
        roots.repositoryRoot,
        path.dirname(operation.destination),
        false
      );
    }
    if (journal.phase !== "cleanup") {
      for (const operation of journal.operations) {
        await inspectPromotionRecoveryOperation(operation);
      }
    }
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw new WprmPromotionError("invalid-promotion-journal");
    }
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
      await persistPromotionTransactionCleanupBootstrap(transaction);
      await validateRestoredPromotionCatalog(
        roots,
        transaction.outcome === "committed"
      );
      await removePrivatePromotionTree(transaction);
      return;
    }
    if (transaction.phase !== "rollback") {
      await persistTransactionState(
        transaction,
        "rollback",
        "pending",
        "after-rollback-transaction-journal"
      );
    }
    for (const operation of [...transaction.operations].reverse()) {
      await rollbackPromotionOperation(transaction, operation);
    }
    await validateRestoredPromotionCatalog(roots);
    await persistTransactionCleanupState(transaction, "rolled-back");
    await removePrivatePromotionTree(transaction);
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-journal-recovery-failed");
  }
}

async function assertPromotionDomain(
  roots: PromotionRoots,
  stagingRoot: string
) {
  const location = promotionTransactionLocation(roots, stagingRoot);
  const entries = await boundedPromotionDirectoryEntries(
    roots.migrationOutputRoot,
    4_096
  );
  for (const entry of entries) {
    if (!entry.name.startsWith(".wprm-promotion-")) {
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

async function writeStagedText(destination: string, content: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      destination,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
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
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-stage-failed");
  } finally {
    await handle?.close();
  }
}

type PromotionStagePlan = {
  readonly artifacts: readonly StagedArtifactPlan[];
  readonly records: ReadonlyMap<string, StagedArtifactPlan>;
  readonly mediaManifest: StagedArtifactPlan | undefined;
};

function stagedArtifactPlan(
  name: string,
  destination: string,
  content: string
): StagedArtifactPlan {
  return {
    name,
    destination,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

function createPromotionStagePlan(
  records: readonly PlannedRecord[],
  mediaManifest: PlannedMediaManifest
): PromotionStagePlan {
  const artifacts: StagedArtifactPlan[] = [];
  const stagedRecords = new Map<string, StagedArtifactPlan>();
  let sequence = 0;
  for (const entry of records) {
    if (entry.action === "reuse") {
      continue;
    }
    const artifact = stagedArtifactPlan(
      `${sequence += 1}.json`,
      entry.destination,
      `${JSON.stringify(entry.record, null, 2)}\n`
    );
    artifacts.push(artifact);
    stagedRecords.set(entry.destination, artifact);
  }
  const stagedMediaManifest = mediaManifest.action === "reuse"
    ? undefined
    : stagedArtifactPlan(
      `${sequence += 1}.media-manifest.json`,
      mediaManifest.destination,
      `${JSON.stringify(mediaManifest.manifest, null, 2)}\n`
    );
  if (stagedMediaManifest !== undefined) {
    artifacts.push(stagedMediaManifest);
  }
  return {
    artifacts,
    records: stagedRecords,
    mediaManifest: stagedMediaManifest
  };
}

async function stagePromotionPlan(
  transaction: PromotionTransaction,
  plan: PromotionStagePlan
): Promise<StagedPromotionPlan> {
  const stagedRecords = new Map<string, string>();
  for (const artifactPlan of plan.artifacts) {
    const artifact = transaction.stagedArtifacts.find(
      (candidate) => candidate.name === artifactPlan.name
    );
    if (artifact === undefined || artifact.proof !== null) {
      fail("promotion-stage-failed");
    }
    const staged = path.join(transaction.stagedRecords, artifactPlan.name);
    await writeStagedText(staged, artifactPlan.content);
    await syncDirectory(transaction.stagedRecords);
    interruptAt(transaction.failureInjection, "after-staged-artifact-write");
    const proof = await hashRegularFile(staged);
    if (
      proof.bytes !== artifactPlan.bytes
      || !fixedEqual(proof.sha256, artifactPlan.sha256)
    ) {
      fail("promotion-stage-failed");
    }
    artifact.proof = proof;
    await writePrivateTransactionJournal(transaction);
    if (plan.records.has(artifactPlan.destination)) {
      stagedRecords.set(artifactPlan.destination, staged);
    }
  }
  const stagedMediaManifest = plan.mediaManifest === undefined
    ? undefined
    : path.join(transaction.stagedRecords, plan.mediaManifest.name);
  return { records: stagedRecords, mediaManifest: stagedMediaManifest };
}

function prospectiveCatalog(
  roots: PromotionRoots,
  records: readonly PlannedRecord[],
  prototypeSeed: WprmPrototypeSeed
) {
  const loaded = loadRecipeCatalogWithSources(roots.contentRoot);
  const selectedIds = new Set(records.map((entry) => entry.record.id));
  const replacedIds = new Set<string>(
    records
      .filter((entry) => entry.action === "replace-prototype")
      .map(() => prototypeSeed.id)
  );
  return [
    ...loaded.records.filter((record) =>
      !selectedIds.has(record.id) && !replacedIds.has(record.id)
    ),
    ...records.map((entry) => entry.record)
  ];
}

async function validateProspectivePromotion(
  roots: PromotionRoots,
  records: readonly PlannedRecord[],
  staged: StagedPromotionPlan,
  prototypeSeed: WprmPrototypeSeed,
  mediaManifest: PlannedMediaManifest
) {
  try {
    const catalog = prospectiveCatalog(roots, records, prototypeSeed);
    validateCatalog(catalog);
    validateMediaPaths(
      catalog,
      path.join(roots.repositoryRoot, "public"),
      mediaManifest.manifest
    );
    validateRecipeMediaManifestClosure(catalog, mediaManifest.manifest);
    if (staged.mediaManifest !== undefined) {
      const parsed = parseRecipeMediaManifest(await readRegularJson(staged.mediaManifest));
      if (!canonicalEquals(parsed, mediaManifest.manifest)) {
        fail("promotion-stage-failed");
      }
    }
    validateCatalogBehavior(catalog);
    createStaticWebAppConfig(catalog);
  } catch (error) {
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("invalid-prospective-catalog");
  }
}

async function stagedProofForTransaction(
  transaction: PromotionTransaction,
  staged: string
) {
  const name = transactionRelativeFile(
    staged,
    transaction.stagedRecords,
    /^\d+\.(?:json|media-manifest\.json)$/u
  );
  const artifact = name === null
    ? undefined
    : transaction.stagedArtifacts.find((candidate) => candidate.name === name);
  if (
    artifact === undefined
    || artifact.proof === null
    || !await matchesStagedArtifact(staged, artifact)
  ) {
    fail("promotion-stage-failed");
  }
  return artifact.proof;
}

async function publishCreate(
  transaction: PromotionTransaction,
  staged: string,
  destination: string
) {
  const stagedProof = await stagedProofForTransaction(transaction, staged);
  const operation: TransactionOperation = {
    kind: "create",
    destination,
    staged,
    stagedProof,
    state: "prepared"
  };
  transaction.operations.push(operation);
  await writePrivateTransactionJournal(transaction);
  try {
    await assertDirectoryChain(
      transaction.roots.repositoryRoot,
      path.dirname(destination),
      false
    );
    await link(staged, destination);
    await syncDirectory(path.dirname(destination));
  } catch {
    fail("destination-file-conflict");
  }
  interruptAt(transaction.failureInjection, "after-create-link");
  operation.state = "published";
  await writePrivateTransactionJournal(transaction);
}

async function publishReplacement(
  transaction: PromotionTransaction,
  staged: string,
  destination: string,
  failureCode: string
) {
  const targetStats = await existingStats(destination);
  if (targetStats === null || !isRegularFile(targetStats)) {
    fail(failureCode);
  }
  const stagedProof = await stagedProofForTransaction(transaction, staged);
  const backupProof = await hashRegularFile(destination);
  const backup = path.join(
    transaction.backups,
    `${transaction.backupSequence += 1}.replacement`
  );
  await assertPrivateDirectory(transaction.backups);
  if (await existingStats(backup) !== null) {
    fail("promotion-transaction-failed");
  }
  const operation: TransactionOperation = {
    kind: "replace",
    destination,
    staged,
    stagedProof,
    backup,
    backupProof,
    state: "prepared"
  };
  transaction.operations.push(operation);
  await writePrivateTransactionJournal(transaction);
  try {
    await rename(destination, backup);
    await syncDirectories([
      path.dirname(destination),
      transaction.backups
    ]);
    interruptAt(
      transaction.failureInjection,
      "after-live-move-before-replacement-link"
    );
    interruptAt(transaction.failureInjection, "after-replacement-live-move");
    await link(staged, destination);
    await syncDirectory(path.dirname(destination));
    interruptAt(transaction.failureInjection, "after-replacement-link");
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    fail(failureCode);
  }
  operation.state = "published";
  await writePrivateTransactionJournal(transaction);
}

async function publishPrototypeReplacement(
  transaction: PromotionTransaction,
  staged: string,
  destination: string,
  prototypeSeed: WprmPrototypeSeed
) {
  await verifyLegacyPrototypeSeed(transaction.roots, destination, prototypeSeed);
  await publishReplacement(
    transaction,
    staged,
    destination,
    "prototype-seed-replacement-failed"
  );
}

async function publishMediaManifest(
  transaction: PromotionTransaction,
  staged: string,
  mediaManifest: PlannedMediaManifest
) {
  if (mediaManifest.action === "create") {
    await publishCreate(transaction, staged, mediaManifest.destination);
    return;
  }
  if (mediaManifest.action !== "replace" || mediaManifest.expected === null) {
    fail("media-manifest-conflict");
  }
  let actual: RecipeMediaManifest;
  try {
    actual = parseRecipeMediaManifest(
      await readRegularJson(mediaManifest.destination)
    );
  } catch {
    fail("media-manifest-conflict");
  }
  if (!canonicalEquals(actual, mediaManifest.expected)) {
    fail("media-manifest-conflict");
  }
  await publishReplacement(
    transaction,
    staged,
    mediaManifest.destination,
    "media-manifest-replacement-failed"
  );
}

async function removePrototypePlaceholder(
  transaction: PromotionTransaction,
  relativePath: string,
  expectedIndexBlob: string,
  expectedSha256: string
) {
  await verifyTrackedPrototypeFile(
    transaction.roots,
    relativePath,
    expectedIndexBlob,
    expectedSha256
  );
  const destination = path.join(transaction.roots.repositoryRoot, relativePath);
  const backupProof = await hashRegularFile(destination);
  const backup = path.join(
    transaction.backups,
    `${transaction.backupSequence += 1}.prototype-placeholder`
  );
  await assertPrivateDirectory(transaction.backups);
  if (await existingStats(backup) !== null) {
    fail("promotion-transaction-failed");
  }
  const operation: TransactionOperation = {
    kind: "remove",
    destination,
    backup,
    backupProof,
    state: "prepared"
  };
  transaction.operations.push(operation);
  await writePrivateTransactionJournal(transaction);
  try {
    await rename(destination, backup);
    await syncDirectories([
      path.dirname(destination),
      transaction.backups
    ]);
    interruptAt(transaction.failureInjection, "after-remove-live-move");
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    fail("prototype-placeholder-removal-failed");
  }
  operation.state = "published";
  await writePrivateTransactionJournal(transaction);
}

async function rollbackPromotionTransaction(transaction: PromotionTransaction) {
  try {
    for (const operation of transaction.operations) {
      await inspectPromotionRecoveryOperation(operation);
    }
    if (transaction.phase !== "rollback") {
      await persistTransactionState(
        transaction,
        "rollback",
        "pending",
        "after-rollback-transaction-journal"
      );
    }
    for (const operation of [...transaction.operations].reverse()) {
      await rollbackPromotionOperation(transaction, operation);
    }
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-rollback-failed");
  }
}

async function discardPromotionTransaction(transaction: PromotionTransaction) {
  try {
    await removePrivatePromotionTree(transaction);
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    fail("promotion-transaction-cleanup-failed");
  }
}

async function applyPlan(
  records: readonly PlannedRecord[],
  roots: PromotionRoots,
  stagingRoot: string,
  identity: PromotionTransactionIdentity,
  key: Uint8Array,
  selected: readonly RecipeRecord[],
  failureInjection: WprmPromotionOptions["failureInjection"] | undefined,
  prototypeSeed: WprmPrototypeSeed,
  mediaManifest: PlannedMediaManifest
) {
  await assertDirectoryChain(roots.repositoryRoot, roots.contentRoot, true);
  for (const locale of localeValues) {
    await assertDirectoryChain(roots.contentRoot, path.join(roots.contentRoot, locale), true);
  }
  const stagePlan = createPromotionStagePlan(records, mediaManifest);
  const transaction = await createPromotionTransaction(
    roots,
    stagingRoot,
    identity,
    key,
    failureInjection,
    stagePlan.artifacts
  );
  try {
    const staged = await stagePromotionPlan(transaction, stagePlan);
    await validateProspectivePromotion(
      roots,
      records,
      staged,
      prototypeSeed,
      mediaManifest
    );
    await persistTransactionState(
      transaction,
      "prepared",
      "pending",
      "after-prepared-transaction-journal"
    );
    await persistTransactionState(
      transaction,
      "publishing",
      "pending",
      "after-publishing-transaction-journal"
    );
    let published = 0;
    const publish = async (stagedFile: string, destination: string) => {
      await publishCreate(transaction, stagedFile, destination);
      published += 1;
      if (hasFailureInjection(failureInjection, "after-first-publication") && published === 1) {
        fail("injected-promotion-failure");
      }
      if (hasFailureInjection(failureInjection, "after-some-new-files-publish") && published === 1) {
        interruptPromotion();
      }
    };
    for (const entry of records) {
      if (entry.action === "reuse") {
        continue;
      }
      const stagedFile = staged.records.get(entry.destination);
      if (stagedFile === undefined) {
        fail("promotion-stage-failed");
      }
      if (entry.action === "replace-prototype") {
        await publishPrototypeReplacement(
          transaction,
          stagedFile,
          entry.destination,
          prototypeSeed
        );
        if (hasFailureInjection(failureInjection, "after-prototype-replacement")) {
          fail("injected-promotion-failure");
        }
      } else if (entry.action === "replace-normalized-display-text") {
        await publishReplacement(
          transaction,
          stagedFile,
          entry.destination,
          "normalized-display-text-replacement-failed"
        );
        if (hasFailureInjection(failureInjection, "after-normalized-display-text-replacement")) {
          fail("injected-promotion-failure");
        }
      } else {
        await publish(stagedFile, entry.destination);
      }
    }
    if (mediaManifest.action !== "reuse") {
      if (staged.mediaManifest === undefined) {
        fail("promotion-stage-failed");
      }
      await publishMediaManifest(transaction, staged.mediaManifest, mediaManifest);
    }
    if (records.some((entry) => entry.action === "replace-prototype")) {
      for (const placeholder of prototypeSeed.placeholders) {
        await removePrototypePlaceholder(
          transaction,
          placeholder.relativePath,
          placeholder.indexBlob,
          placeholder.sha256
        );
      }
    }
    validatePromotedCatalog(roots, selected);
    await persistTransactionCleanupState(transaction, "committed");
    await discardPromotionTransaction(transaction);
  } catch (error) {
    if (error instanceof WprmPromotionInterruption) {
      throw error;
    }
    if (
      transaction.phase === "cleanup"
      && transaction.outcome === "committed"
    ) {
      if (error instanceof WprmPromotionError) {
        throw error;
      }
      fail("promotion-transaction-failed");
    }
    try {
      await rollbackPromotionTransaction(transaction);
    } catch (rollbackError) {
      if (rollbackError instanceof WprmPromotionInterruption) {
        throw rollbackError;
      }
      fail("promotion-rollback-failed");
    }
    try {
      await validateRestoredPromotionCatalog(roots);
      await persistTransactionCleanupState(transaction, "rolled-back");
      await discardPromotionTransaction(transaction);
    } catch (cleanupError) {
      if (cleanupError instanceof WprmPromotionInterruption) {
        throw cleanupError;
      }
      // The original write failure remains authoritative after a completed rollback.
    }
    if (error instanceof WprmPromotionError) {
      throw error;
    }
    fail("promotion-transaction-failed");
  }
}

function validatePromotedCatalog(
  roots: PromotionRoots,
  selected: readonly RecipeRecord[]
) {
  const loaded = validateContent({
    mediaManifestPath: roots.mediaManifest,
    recipesRoot: roots.contentRoot,
    publicRoot: path.join(roots.repositoryRoot, "public")
  });
  const catalog = loaded.records;
  const selectedIds = new Set(selected.map((record) => record.id));
  const promoted = catalog.filter((record) => selectedIds.has(record.id));
  if (promoted.length !== selected.length) {
    fail("promoted-catalog-mismatch");
  }
  try {
    validateCatalogBehavior(catalog);
  } catch {
    fail("invalid-promoted-catalog-behavior");
  }
  for (const record of promoted) {
    if (record.redirectFrom.length !== 0) {
      fail("unproven-redirect");
    }
  }
  createStaticWebAppConfig(catalog);
}

function localeCounts(records: readonly RecipeRecord[]) {
  const result: Record<Locale, number> = {
    en: 0,
    fr: 0,
    ru: 0
  };
  for (const record of records) {
    result[record.locale] += 1;
  }
  return result;
}

type PreparedWprmPromotion = {
  readonly actualCounts: OutcomeCounts;
  readonly key: Uint8Array;
  readonly media: PlannedMediaPreparation;
  readonly mediaManifest: PlannedMediaManifest;
  readonly prototypeSeed: WprmPrototypeSeed;
  readonly records: readonly PlannedRecord[];
  readonly roots: PromotionRoots;
  readonly selected: readonly RecipeRecord[];
  readonly stagingRoot: string;
  readonly transactionIdentity: PromotionTransactionIdentity;
  readonly translation: ReturnType<typeof classifyPromotionTranslationClosure>;
};

async function prepareWprmPromotion(
  options: WprmPromotionOptions,
  roots: PromotionRoots
): Promise<PreparedWprmPromotion> {
  validateExpectedCounts(options.expected);
  if (
    roots.repositoryRoot === defaultPromotionRepositoryRoot
    && (
      options.failureInjection !== undefined
      || options.prototypeSeed !== undefined
      || options.onPromotionLockAcquired !== undefined
    )
  ) {
    fail("test-only-option");
  }
  const prototypeSeed = options.prototypeSeed ?? legacyPrototypeSeed;
  const staging = await resolveStagingPaths(roots, options.stagingDir);
  await assertPromotionDomain(roots, staging.root);
  const marker = await readPrivateJson(staging.marker);
  if (isLegacyV3Marker(marker)) {
    fail("staging-media-binding-upgrade-required");
  }
  if (!isCurrentMarker(marker)) {
    fail("invalid-staging-marker");
  }
  const key = await readFingerprintKey(options.fingerprintKeyFile);
  const archives = await resolveWprmUploadArchives(
    options.uploadsDir,
    options.uploadArchives
  );
  let fresh: Awaited<ReturnType<typeof runWprmBulkImport>>;
  try {
    fresh = await runWprmBulkImport({
      database: options.database,
      uploadArchives: archives,
      fingerprintKeyFile: options.fingerprintKeyFile,
      dryRun: true
    });
  } catch {
    fail("source-verification-failed");
  }
  if (
    marker.sqlDecompressedSha256 !== fresh.manifest.source.sqlDecompressedSha256
    || marker.importerContractVersion !== wprmImportContractVersion
    || marker.mediaBindingVersion !== 1
  ) {
    fail("staging-source-or-contract-mismatch");
  }
  const transactionIdentity: PromotionTransactionIdentity = {
    source: {
      sqlDecompressedSha256: fresh.manifest.source.sqlDecompressedSha256,
      manifestSha256: sha256Canonical(fresh.manifest)
    },
    contract: {
      importerContractVersion: wprmImportContractVersion,
      mediaBindingVersion: 1
    },
    prototypeSeedSha256: sha256Canonical(prototypeSeed)
  };
  await recoverPromotionTransaction(
    roots,
    staging.root,
    transactionIdentity,
    key,
    options.failureInjection
  );
  const stagedManifest = await readPrivateJson(staging.manifest);
  if (!canonicalEquals(stagedManifest, fresh.manifest)) {
    fail("staging-manifest-mismatch");
  }
  const actualCounts = countsFor(fresh.outcomes);
  if (!sameCounts(actualCounts, options.expected)) {
    fail("unexpected-candidate-count");
  }
  const authenticated = await authenticateCandidates(staging, fresh.outcomes, key);
  const mediaBindings = await authenticateMediaBindings(staging);
  const readySelected = sortedNumericIds(
    fresh.outcomes
      .filter((outcome) => outcome.status === "ready")
      .map((outcome) => outcome.recipeId)
  ).map((recipeId) => {
    const record = authenticated.get(recipeId);
    if (record === undefined) {
      fail("staged-candidate-set-mismatch");
    }
    return record;
  });
  if (readySelected.length !== options.expected.ready) {
    fail("unexpected-candidate-count");
  }
  await assertDirectoryChain(roots.repositoryRoot, roots.contentRoot, false);
  await assertDirectoryChain(roots.repositoryRoot, roots.mediaRoot, false);
  const translation = classifyPromotionTranslationClosure(
    readySelected,
    fresh.outcomes,
    loadRecipeCatalogWithSources(roots.contentRoot).records,
    fresh.sourceTranslationGroups
  );
  const selected = translation.selected;
  const records = await planRecords(selected, roots, prototypeSeed);
  const existingMediaManifest = await loadExistingMediaManifest(roots);
  const media = await planMedia(
    selected,
    archives,
    fresh.snapshot,
    mediaBindings,
    key,
    mediaBindingIds(readySelected),
    existingMediaManifest.manifest
  );
  try {
    const prospectiveMediaManifest = createProspectiveMediaManifest(
      prospectiveCatalog(roots, records, prototypeSeed),
      media.planned,
      existingMediaManifest.manifest
    );
    const mediaManifest = planMediaManifest(
      roots,
      existingMediaManifest.manifest,
      existingMediaManifest.exists,
      prospectiveMediaManifest
    );

    return {
      actualCounts,
      key,
      media,
      mediaManifest,
      prototypeSeed,
      records,
      roots,
      selected,
      stagingRoot: staging.root,
      transactionIdentity,
      translation
    };
  } catch (error) {
    await Promise.all([...media.archives.values()].map((archive) => archive.close()));
    throw error;
  }
}

function promotionResult(
  prepared: PreparedWprmPromotion,
  write: boolean
): WprmPromotionResult {
  return {
    schemaVersion: 1,
    kind: "wprm-promotion-result",
    mode: write ? "write" : "dry-run",
    candidates: prepared.actualCounts,
    translation: {
      eligible: prepared.selected.length,
      excluded: prepared.translation.excluded,
      blockedGroups: prepared.translation.blockedGroups,
      reviewPeers: prepared.translation.reviewPeers,
      errorPeers: prepared.translation.errorPeers
    },
    records: {
      byLocale: localeCounts(prepared.selected),
      created: prepared.records.filter((entry) => entry.action === "create").length,
      replacedNormalizedDisplayText: prepared.records.filter(
        (entry) => entry.action === "replace-normalized-display-text"
      ).length,
      replacedPrototype: prepared.records.filter(
        (entry) => entry.action === "replace-prototype"
      ).length,
      reused: prepared.records.filter((entry) => entry.action === "reuse").length
    },
    media: {
      referenced: prepared.media.referenced,
      unique: prepared.media.planned.length,
      addedToManifest: prepared.media.planned.filter(
        (entry) => entry.action === "create"
      ).length,
      reusedFromManifest: prepared.media.planned.filter(
        (entry) => entry.action === "reuse"
      ).length
    },
    redirects: {
      published: 0
    }
  };
}

function authenticatedMediaPlan(
  prepared: PreparedWprmPromotion
): AuthenticatedWprmMediaPlan {
  const entries = prepared.media.planned.map((entry) => ({
    bytes: entry.bytes,
    key: entry.key,
    sha256: entry.sha256,
    sourceAttachmentId: entry.attachmentId
  }));
  const byKey = new Map(prepared.media.planned.map((entry) => [entry.key, entry] as const));

  return {
    entries,
    manifest: prepared.mediaManifest.manifest,
    async copyToPrivateFile(objectKey: string, destination: string) {
      const entry = byKey.get(objectKey);
      if (entry === undefined) {
        fail("unknown-media-object-key");
      }
      const archive = prepared.media.archives.get(entry.archiveIndex);
      if (archive === undefined) {
        fail("invalid-media-provenance");
      }
      const copied = await copyVerifiedOpenUploadArchiveEntry(
        archive,
        entry.sourcePath,
        destination,
        {
          keyedDigest: {
            key: prepared.key,
            context: entry.attachmentId
          }
        }
      );
      if (
        copied.keyedSha256 === null
        || copied.bytes !== entry.bytes
        || !fixedEqual(copied.keyedSha256, entry.binding.keyedSha256)
        || !fixedEqual(copied.sha256, entry.sha256)
      ) {
        fail("staged-media-binding-mismatch");
      }
    }
  };
}

export async function withAuthenticatedWprmMediaPlan<T>(
  options: WprmPromotionOptions,
  callback: (plan: AuthenticatedWprmMediaPlan) => Promise<T>
) {
  if (options.write === true) {
    fail("invalid-media-plan-mode");
  }
  const roots = await resolveRoots(options);
  return withPromotionLock(roots, options, async () => {
    const prepared = await prepareWprmPromotion(options, roots);
    try {
      return await callback(authenticatedMediaPlan(prepared));
    } finally {
      await Promise.all([...prepared.media.archives.values()].map((archive) => archive.close()));
    }
  });
}

export async function promoteWprmStaging(
  options: WprmPromotionOptions
): Promise<WprmPromotionResult> {
  const roots = await resolveRoots(options);
  return withPromotionLock(roots, options, async () => {
    const prepared = await prepareWprmPromotion(options, roots);
    try {
      if (options.write === true) {
        await applyPlan(
          prepared.records,
          prepared.roots,
          prepared.stagingRoot,
          prepared.transactionIdentity,
          prepared.key,
          prepared.selected,
          options.failureInjection,
          prepared.prototypeSeed,
          prepared.mediaManifest
        );
      }
      return promotionResult(prepared, options.write === true);
    } finally {
      await Promise.all([...prepared.media.archives.values()].map((archive) => archive.close()));
    }
  });
}

export function serializeWprmPromotionResult(result: WprmPromotionResult) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
