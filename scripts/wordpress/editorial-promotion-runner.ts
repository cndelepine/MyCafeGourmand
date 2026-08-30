import { timingSafeEqual } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecipeCatalogWithSources } from "../../src/content/catalog";
import {
  editorialImportContractVersion,
  EditorialImportError,
  type EditorialCandidateOutcome,
  type EditorialGalleryOutcome,
  type EditorialSafeManifest
} from "./editorial-import-contracts";
import {
  fingerprintEditorialCandidate,
  editorialFingerprintKey
} from "./editorial-import-stage";
import {
  runEditorialImport
} from "./editorial-import-runner";
import {
  EditorialPromotionError,
  planEditorialPromotion,
  type EditorialPromotionPlan,
  type EditorialPromotionSummary
} from "./editorial-promotion";
import {
  EditorialPublicationError,
  publishEditorialPromotion,
  resolveEditorialPublicationRoots,
  withAuthenticatedEditorialPublicationMediaPlan,
  withEditorialPromotionLock,
  type AuthenticatedEditorialMediaUploadPlan,
  type EditorialPublicationInput,
  type EditorialPublicationTestOptions
} from "./editorial-promotion-transaction";
import { canonicalCandidateJson } from "./wprm-import-stage";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const defaultEditorialPromotionRepositoryRoot = realpathSync(path.resolve(moduleDirectory, "../.."));

type ExpectedPromotionCounts = {
  readonly galleryCandidates: number;
  readonly galleries: number;
  readonly publicationExcluded: number;
  readonly ready: number;
  readonly review: number;
  readonly selected: number;
};

export type EditorialPromotionOptions = EditorialPublicationTestOptions & {
  readonly database: string;
  readonly expected: ExpectedPromotionCounts;
  readonly fingerprintKeyFile: string;
  readonly repositoryRoot?: string;
  readonly stagingDir: string;
  readonly uploadArchives?: readonly string[];
  readonly uploadsDir?: string;
  readonly write?: boolean;
};

export type EditorialPromotionResult = {
  readonly schemaVersion: 2;
  readonly kind: "wordpress-editorial-promotion-result";
  readonly mode: "dry-run" | "write";
  readonly candidates: {
    readonly authenticatedGalleryCandidates: number;
    readonly authenticatedPages: number;
    readonly galleryCandidates: number;
    readonly publicationExcluded: number;
    readonly ready: number;
    readonly review: number;
  };
  readonly publication: EditorialPromotionSummary["candidates"];
  readonly records: EditorialPromotionSummary["records"] & {
    readonly created: number;
    readonly removed: number;
    readonly reused: number;
    readonly galleriesCreated: number;
    readonly galleriesReused: number;
  };
  readonly media: EditorialPromotionSummary["media"] & {
    readonly addedToManifest: number;
    readonly removedFromManifest: number;
    readonly reusedFromManifest: number;
  };
  readonly privacy: {
    readonly candidateIdentifiersAreKeyedHmac: true;
    readonly rawValuesEmitted: false;
    readonly sourcePathsEmitted: false;
    readonly sourceWordingEmitted: false;
    readonly timestampsEmitted: false;
  };
};

export class EditorialPromotionRunnerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The editorial promotion preflight failed.");
    this.name = "EditorialPromotionRunnerError";
    this.code = code;
  }
}

type AuthenticatedEditorialPromotion = {
  readonly counts: ReturnType<typeof candidateCounts>;
  readonly fresh: Awaited<ReturnType<typeof runEditorialImport>>;
  readonly galleryCandidates: number;
  readonly plan: EditorialPromotionPlan;
  readonly publicationInput: EditorialPublicationInput;
  readonly roots: Awaited<ReturnType<typeof resolveEditorialPublicationRoots>>;
};

function fail(code: string): never {
  throw new EditorialPromotionRunnerError(code);
}

function fixedEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function isPrivateOwned(stats: { readonly mode: number; readonly uid?: number }) {
  if ((stats.mode & 0o077) !== 0) {
    return false;
  }
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCurrentMarker(value: unknown): value is {
  readonly schemaVersion: 2;
  readonly kind: "wordpress-editorial-staging";
  readonly sqlDecompressedSha256: string;
  readonly uploadIndexContractSha256: string;
  readonly importerContractVersion: typeof editorialImportContractVersion;
} {
  return exactKeys(value, [
    "schemaVersion",
    "kind",
    "sqlDecompressedSha256",
    "uploadIndexContractSha256",
    "importerContractVersion"
  ])
    && value.schemaVersion === 2
    && value.kind === "wordpress-editorial-staging"
    && typeof value.sqlDecompressedSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.sqlDecompressedSha256)
    && typeof value.uploadIndexContractSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.uploadIndexContractSha256)
    && value.importerContractVersion === editorialImportContractVersion;
}

async function privateDirectory(target: string) {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    fail("unsafe-staging");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || !isPrivateOwned(stats)
    || (stats.mode & 0o777) !== 0o700
  ) {
    fail("unsafe-staging");
  }
}

async function readPrivateFile(target: string, maxBytes: number) {
  let stats;
  try {
    stats = await lstat(target);
  } catch {
    fail("unsafe-staging");
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
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
    if (error instanceof EditorialPromotionRunnerError) {
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
    if (error instanceof EditorialPromotionRunnerError) {
      throw error;
    }
    fail("invalid-staging-json");
  }
}

async function stagingRoot(input: string, repositoryRoot: string) {
  const target = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(repositoryRoot, input);
  const migrationOutput = path.join(repositoryRoot, "migration-output");
  if (!isWithin(target, migrationOutput) || target === migrationOutput) {
    fail("unsafe-staging");
  }
  const relative = path.relative(migrationOutput, target);
  let current = migrationOutput;
  for (const part of relative.split(path.sep)) {
    if (part.length === 0 || part === "." || part === "..") {
      fail("unsafe-staging");
    }
    current = path.join(current, part);
    await privateDirectory(current);
  }
  await privateDirectory(target);
  await privateDirectory(path.join(target, "candidates"));
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    fail("unsafe-staging");
  }

  function isWithin(candidate: string, directory: string) {
    return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
  }
  const expected = [".editorial-staging.json", "candidates", "manifest.json"];
  if (
    entries.length !== expected.length
    || entries.some((entry) => !expected.includes(entry))
  ) {
    fail("unsafe-staging");
  }
  return {
    candidates: path.join(target, "candidates"),
    manifest: path.join(target, "manifest.json"),
    marker: path.join(target, ".editorial-staging.json")
  };
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

function expectedPageCandidateNames(outcomes: readonly EditorialCandidateOutcome[]) {
  return [...outcomes]
    .sort((left, right) => numericIdSort(left.sourceId, right.sourceId))
    .map((outcome) => `page-${outcome.sourceId}.json`);
}

function expectedGalleryCandidateNames(outcomes: readonly EditorialGalleryOutcome[]) {
  return [...outcomes]
    .sort((left, right) =>
      numericIdSort(left.sourceId, right.sourceId)
      || left.sourceKind.localeCompare(right.sourceKind)
    )
    .map((outcome) =>
      outcome.sourceKind === "gallery"
        ? `gallery-${outcome.sourceId}.json`
        : `unassigned-image-${outcome.sourceId}.json`
    );
}

async function candidateNames(directory: string) {
  let entries: Array<{
    readonly name: string;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await readdir(directory, { encoding: "utf8", withFileTypes: true });
  } catch {
    fail("unsafe-staging");
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || !/^(?:page|gallery|unassigned-image)-\d+\.json$/u.test(entry.name)
    ) {
      fail("unsafe-staging");
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function sameNames(left: readonly string[], right: readonly string[]) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function authenticateCandidate(
  pathValue: string,
  expected: unknown,
  fingerprint: string,
  key: Uint8Array
) {
  const candidate = await readPrivateJson(pathValue, 8 * 1024 * 1024);
  let serialized: string;
  try {
    serialized = canonicalCandidateJson(candidate);
  } catch {
    fail("invalid-staged-candidate");
  }
  if (!fixedEqual(fingerprintEditorialCandidate(key, candidate), fingerprint)) {
    fail("staged-candidate-hmac-mismatch");
  }
  if (serialized !== canonicalCandidateJson(expected)) {
    fail("staged-candidate-source-mismatch");
  }
}

async function authenticateStaging(input: {
  readonly galleries: readonly EditorialGalleryOutcome[];
  readonly manifest: EditorialSafeManifest;
  readonly outcomes: readonly EditorialCandidateOutcome[];
  readonly staging: Awaited<ReturnType<typeof stagingRoot>>;
  readonly key: Uint8Array;
}) {
  const marker = await readPrivateJson(input.staging.marker, 64 * 1024);
  if (!isCurrentMarker(marker)) {
    fail("invalid-staging-marker");
  }
  if (
    marker.sqlDecompressedSha256 !== input.manifest.source.sqlDecompressedSha256
    || marker.uploadIndexContractSha256 !== input.manifest.source.uploadIndexContractSha256
    || marker.importerContractVersion !== editorialImportContractVersion
  ) {
    fail("staging-source-or-contract-mismatch");
  }
  const stagedManifest = await readPrivateJson(input.staging.manifest, 2 * 1024 * 1024);
  if (canonicalCandidateJson(stagedManifest) !== canonicalCandidateJson(input.manifest)) {
    fail("staging-manifest-mismatch");
  }
  const expectedNames = [
    ...expectedPageCandidateNames(input.outcomes),
    ...expectedGalleryCandidateNames(input.galleries)
  ].sort((left, right) => left.localeCompare(right));
  if (!sameNames(await candidateNames(input.staging.candidates), expectedNames)) {
    fail("staged-candidate-set-mismatch");
  }
  for (const outcome of [...input.outcomes].sort((left, right) =>
    numericIdSort(left.sourceId, right.sourceId)
  )) {
    await authenticateCandidate(
      path.join(input.staging.candidates, `page-${outcome.sourceId}.json`),
      outcome.record,
      outcome.fingerprint,
      input.key
    );
  }
  for (const outcome of input.galleries) {
    const name = outcome.sourceKind === "gallery"
      ? `gallery-${outcome.sourceId}.json`
      : `unassigned-image-${outcome.sourceId}.json`;
    await authenticateCandidate(
      path.join(input.staging.candidates, name),
      outcome.record,
      outcome.fingerprint,
      input.key
    );
  }
}

function candidateCounts(outcomes: readonly EditorialCandidateOutcome[]) {
  return {
    ready: outcomes.filter((outcome) => outcome.status === "ready").length,
    review: outcomes.filter((outcome) => outcome.status === "review").length,
    publicationExcluded: outcomes.filter(
      (outcome) => outcome.status === "publication-excluded"
    ).length
  };
}

function validateExpectedCounts(expected: ExpectedPromotionCounts) {
  for (const value of Object.values(expected)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("invalid-expected-count");
    }
  }
}

function validateCounts(
  actual: ReturnType<typeof candidateCounts>,
  galleryCandidates: number,
  plan: EditorialPromotionPlan,
  expected: ExpectedPromotionCounts
) {
  if (
    actual.ready !== expected.ready
    || actual.review !== expected.review
    || actual.publicationExcluded !== expected.publicationExcluded
    || galleryCandidates !== expected.galleryCandidates
    || plan.summary.candidates.selected !== expected.selected
    || plan.summary.records.galleries !== expected.galleries
  ) {
    fail("unexpected-candidate-count");
  }
}

async function repositoryRoot(input: string | undefined) {
  const candidate = input ?? defaultEditorialPromotionRepositoryRoot;
  let root: string;
  try {
    root = await realpath(path.resolve(candidate));
  } catch {
    fail("invalid-repository-root");
  }
  let stats;
  try {
    stats = await lstat(root);
  } catch {
    fail("invalid-repository-root");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("invalid-repository-root");
  }
  return root;
}

function promotionResult(
  counts: ReturnType<typeof candidateCounts>,
  galleryCandidates: number,
  plan: EditorialPromotionPlan,
  authenticatedPages: number,
  authenticatedGalleryCandidates: number,
  write: boolean,
  publication: Awaited<ReturnType<typeof publishEditorialPromotion>>
): EditorialPromotionResult {
  return {
    schemaVersion: 2,
    kind: "wordpress-editorial-promotion-result",
    mode: write ? "write" : "dry-run",
    candidates: {
      authenticatedGalleryCandidates,
      authenticatedPages,
      galleryCandidates,
      publicationExcluded: counts.publicationExcluded,
      ready: counts.ready,
      review: counts.review
    },
    publication: plan.summary.candidates,
    records: {
      ...plan.summary.records,
      ...publication.records
    },
    media: {
      ...plan.summary.media,
      ...publication.media
    },
    privacy: {
      candidateIdentifiersAreKeyedHmac: true,
      rawValuesEmitted: false,
      sourcePathsEmitted: false,
      sourceWordingEmitted: false,
      timestampsEmitted: false
    }
  };
}

export async function withAuthenticatedEditorialPromotion<T>(
  options: EditorialPromotionOptions,
  callback: (authenticated: AuthenticatedEditorialPromotion) => Promise<T>
): Promise<T> {
  validateExpectedCounts(options.expected);
  const root = await repositoryRoot(options.repositoryRoot);
  let roots: Awaited<ReturnType<typeof resolveEditorialPublicationRoots>>;
  try {
    roots = await resolveEditorialPublicationRoots(root);
  } catch (error) {
    if (error instanceof EditorialPublicationError) {
      fail(error.code);
    }
    fail("invalid-repository-root");
  }
  try {
    return await withEditorialPromotionLock(roots, options, async () => {
      const staging = await stagingRoot(options.stagingDir, root);
      let key: Uint8Array;
      try {
        key = await editorialFingerprintKey(options.fingerprintKeyFile);
      } catch {
        fail("invalid-fingerprint-key");
      }
      let fresh: Awaited<ReturnType<typeof runEditorialImport>>;
      try {
        fresh = await runEditorialImport({
          database: options.database,
          ...(options.uploadsDir === undefined ? {} : { uploadsDir: options.uploadsDir }),
          ...(options.uploadArchives === undefined ? {} : { uploadArchives: options.uploadArchives }),
          fingerprintKeyFile: options.fingerprintKeyFile,
          dryRun: true
        });
      } catch (error) {
        if (error instanceof EditorialImportError) {
          fail("source-verification-failed");
        }
        fail("source-verification-failed");
      }
      await authenticateStaging({
        galleries: fresh.galleries,
        key,
        manifest: fresh.manifest,
        outcomes: fresh.outcomes,
        staging
      });
      let recipes;
      try {
        recipes = loadRecipeCatalogWithSources(path.join(root, "content", "recipes")).records;
      } catch {
        fail("recipe-catalog-validation-failed");
      }
      let plan: EditorialPromotionPlan;
      try {
        plan = planEditorialPromotion({
          outcomes: fresh.outcomes,
          recipeRecords: recipes,
          snapshot: fresh.snapshot
        });
      } catch (error) {
        if (error instanceof EditorialPromotionError) {
          fail(error.code);
        }
        fail("promotion-mapping-failed");
      }
      const counts = candidateCounts(fresh.outcomes);
      validateCounts(counts, fresh.galleries.length, plan, options.expected);
      return callback({
        counts,
        fresh,
        galleryCandidates: fresh.galleries.length,
        plan,
        publicationInput: {
          repositoryRoot: root,
          stagingRoot: stagingRootPath(staging),
          fingerprintKey: key,
          sourceManifest: fresh.manifest,
          plan,
          recipeRecords: recipes,
          ...(options.uploadsDir === undefined ? {} : { uploadsDir: options.uploadsDir }),
          ...(options.uploadArchives === undefined ? {} : { uploadArchives: options.uploadArchives }),
          write: options.write === true,
          ...(options.failureInjection === undefined
            ? {}
            : { failureInjection: options.failureInjection }),
          ...(options.onPromotionLockAcquired === undefined
            ? {}
            : { onPromotionLockAcquired: options.onPromotionLockAcquired })
        },
        roots
      });
    });
  } catch (error) {
    if (error instanceof EditorialPromotionRunnerError) {
      fail(error.code);
    }
    if (error instanceof EditorialPublicationError) {
      fail(error.code);
    }
    fail("promotion-failed");
  }
}

export async function withAuthenticatedEditorialMediaPlan<T>(
  options: EditorialPromotionOptions,
  callback: (plan: AuthenticatedEditorialMediaUploadPlan) => Promise<T>
): Promise<T> {
  if (options.write === true) {
    fail("invalid-media-plan-mode");
  }
  return withAuthenticatedEditorialPromotion(options, (authenticated) =>
    withAuthenticatedEditorialPublicationMediaPlan(
      authenticated.roots,
      authenticated.publicationInput,
      callback
    )
  );
}

export async function promoteEditorialStaging(
  options: EditorialPromotionOptions
): Promise<EditorialPromotionResult> {
  return withAuthenticatedEditorialPromotion(options, async (authenticated) => {
    let publication;
    try {
      publication = await publishEditorialPromotion(
        authenticated.roots,
        authenticated.publicationInput
      );
    } catch (error) {
      if (error instanceof EditorialPublicationError) {
        fail(error.code);
      }
      if (
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "injected-promotion-interruption"
      ) {
        fail("injected-promotion-interruption");
      }
      fail("promotion-transaction-failed");
    }
    return promotionResult(
      authenticated.counts,
      authenticated.galleryCandidates,
      authenticated.plan,
      authenticated.fresh.outcomes.length,
      authenticated.fresh.galleries.length,
      options.write === true,
      publication
    );
  });
}

function stagingRootPath(staging: Awaited<ReturnType<typeof stagingRoot>>) {
  return path.dirname(staging.candidates);
}

export function serializeEditorialPromotionResult(result: EditorialPromotionResult) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
