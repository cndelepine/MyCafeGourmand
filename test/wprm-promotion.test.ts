import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadRecipeCatalog } from "../src/content/catalog";
import { recipeRecordSchema } from "../src/content/schema";
import { getRecipePath } from "../src/lib/recipe-routes";
import { recipeFixture } from "./fixtures/recipe";
import type { CandidateOutcome } from "../scripts/wordpress/wprm-import-contracts";
import { runWprmBulkImport } from "../scripts/wordpress/wprm-import-runner";
import {
  WprmPromotionError,
  classifyPromotionTranslationClosure,
  promoteWprmStaging,
  validatePromotionTranslationClosure,
  type WprmPromotionOptions,
  type WprmPrototypeSeed
} from "../scripts/wordpress/wprm-promotion";
import {
  WprmMediaUploadPlanError,
  createWprmMediaUploadPlan
} from "../scripts/wordpress/wprm-media-upload-plan";
import {
  copyVerifiedOpenUploadArchiveEntry,
  openVerifiedUploadArchive
} from "../scripts/wordpress/uploads-media";

const fixture = path.resolve(process.cwd(), "test/fixtures/wordpress/wprm-bulk.sql");
const originalMedia = Buffer.from("sanitized original media", "utf8");
const prototypeSeedSource: WprmPrototypeSeed["source"] = {
  system: "wordpress",
  postId: null,
  recipeId: "2980",
  postType: null,
  plugin: "wprm",
  sourceSlug: null,
  createdAt: null,
  modifiedAt: null,
  editorialPostId: null,
  editorialPostType: null,
  editorialSourceSlug: null,
  editorialCreatedAt: null,
  editorialModifiedAt: null
};

function hash(value: Buffer, algorithm: "sha1" | "sha256") {
  return createHash(algorithm).update(value).digest("hex");
}

function productionSnapshot(repositoryRoot: string) {
  const files: string[] = [];
  const roots = [
    path.join(repositoryRoot, "content", "recipes"),
    path.join(repositoryRoot, "public", "recipes")
  ];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) {
        visit(target);
      } else {
        assert.equal(entry.isFile(), true);
        files.push(target);
      }
    }
  };
  for (const root of roots) {
    visit(root);
  }
  const manifest = path.join(repositoryRoot, "content", "media-manifest.json");
  if (existsSync(manifest)) {
    files.push(manifest);
  }
  return files
    .sort()
    .map((file) => [
      path.relative(repositoryRoot, file),
      hash(readFileSync(file), "sha256")
    ] as const);
}

function promotionTransactionDirectory(repositoryRoot: string) {
  const migrationOutput = path.join(repositoryRoot, "migration-output");
  const entries = readdirSync(migrationOutput, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(".wprm-promotion-") && entry.isDirectory());
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.isSymbolicLink(), false);
  return path.join(migrationOutput, entries[0]!.name);
}

function promotionTransactionBootstrap(repositoryRoot: string) {
  const directory = promotionTransactionDirectory(repositoryRoot);
  return path.join(
    path.dirname(directory),
    `${path.basename(directory)}.bootstrap.json`
  );
}

function promotionTransactionArtifacts(repositoryRoot: string) {
  return readdirSync(path.join(repositoryRoot, "migration-output"))
    .filter((entry) => entry.startsWith(".wprm-promotion-"))
    .sort();
}

function assertNoPromotionTransactionArtifacts(repositoryRoot: string) {
  assert.deepEqual(promotionTransactionArtifacts(repositoryRoot), []);
}

function isInjectedInterruption(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "injected-promotion-interruption";
}

function gitBlobHash(value: Buffer) {
  return hash(
    Buffer.concat([Buffer.from(`blob ${value.byteLength}\0`, "utf8"), value]),
    "sha1"
  );
}

function prototypeSeedFixture() {
  const placeholders = [
    {
      relativePath: "public/recipes/meatballs-soup/hero.png",
      content: Buffer.from("sanitized prototype hero placeholder", "utf8")
    },
    {
      relativePath: "public/recipes/meatballs-soup/steps/01-meatball-mix.png",
      content: Buffer.from("sanitized prototype step placeholder", "utf8")
    }
  ] as const;
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    id: "wordpress:wprm:2980",
    slug: "meatballs-soup",
    source: prototypeSeedSource,
    recipe: {
      ...recipeFixture.recipe,
      heroMediaId: "prototype-hero",
      instructionGroups: recipeFixture.recipe.instructionGroups.map((group) => ({
        ...group,
        steps: group.steps.map((step) => ({
          ...step,
          mediaId: "prototype-step"
        }))
      }))
    },
    media: [
      {
        ...recipeFixture.media[0]!,
        id: "prototype-hero",
        path: "/recipes/meatballs-soup/hero.png"
      },
      {
        ...recipeFixture.media[1]!,
        id: "prototype-step",
        path: "/recipes/meatballs-soup/steps/01-meatball-mix.png"
      }
    ]
  });
  const content = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  const seed: WprmPrototypeSeed = {
    contentRelativePath: "content/recipes/en/meatballs-soup.json",
    contentIndexBlob: gitBlobHash(content),
    contentSha256: hash(content, "sha256"),
    id: "wordpress:wprm:2980",
    locale: "en",
    slug: "meatballs-soup",
    source: prototypeSeedSource,
    targetId: "wordpress:wprm:21681",
    targetRecipeId: "21681",
    placeholders: placeholders.map(({ relativePath, content }) => ({
      relativePath,
      indexBlob: gitBlobHash(content),
      sha256: hash(content, "sha256")
    }))
  };
  return { content, placeholders, seed };
}

function authoritativeSeedReplacementSql() {
  return readFileSync(fixture, "utf8")
    .replace("  (13, 100, '_wp_old_slug', 'ready-old'),\n", "")
    .replaceAll("100", "21681")
    .replaceAll("editorial-ready", "meatballs-soup")
    .replaceAll("recipe-ready", "meatballs-soup");
}

function crc32(value: Buffer) {
  let current = 0xffffffff;
  for (const byte of value) {
    current ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      current = (current & 1) === 1
        ? 0xedb88320 ^ (current >>> 1)
        : current >>> 1;
    }
  }
  return (current ^ 0xffffffff) >>> 0;
}

function zipArchive(entries: readonly { readonly name: string; readonly content: Buffer }[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.content.byteLength, 18);
    localHeader.writeUInt32LE(entry.content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    local.push(localHeader, name, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.content.byteLength, 20);
    centralHeader.writeUInt32LE(entry.content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + entry.content.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

type PromotionFixture = {
  readonly archive: string;
  readonly database: string;
  readonly initial: Awaited<ReturnType<typeof runWprmBulkImport>>;
  readonly key: string;
  readonly prototypeSeed: WprmPrototypeSeed | undefined;
  readonly repositoryRoot: string;
  readonly staging: string;
};

function candidateCounts(initial: PromotionFixture["initial"]) {
  return {
    ready: initial.manifest.candidates.ready,
    review: initial.manifest.candidates.review,
    error: initial.manifest.candidates.error
  };
}

function promotionOptions(
  fixtureValues: PromotionFixture,
  write = false
) {
  return {
    database: fixtureValues.database,
    uploadArchives: [fixtureValues.archive],
    fingerprintKeyFile: fixtureValues.key,
    stagingDir: fixtureValues.staging,
    expected: candidateCounts(fixtureValues.initial),
    repositoryRoot: fixtureValues.repositoryRoot,
    prototypeSeed: fixtureValues.prototypeSeed,
    write
  } as const;
}

function uploadPlanOptions(
  fixtureValues: PromotionFixture,
  options: {
    readonly resume?: boolean;
    readonly writePublicManifest?: boolean;
  } = {}
) {
  return {
    ...promotionOptions(fixtureValues),
    uploadDir: "migration-output/wprm-media-upload",
    write: true,
    ...options
  } as const;
}

type PromotionFixtureOptions = {
  readonly databaseContents?: string;
  readonly includePrototypeSeed?: boolean;
};

async function withPromotionFixture(
  callback: (fixtureValues: PromotionFixture) => Promise<void>,
  options: PromotionFixtureOptions = {}
) {
  const outputRoot = path.join(process.cwd(), "migration-output");
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(outputRoot, ".wprm-promotion-test-"));
  try {
    const repositoryRoot = path.join(directory, "repository");
    const archive = path.join(directory, "uploads.zip");
    const database = options.databaseContents === undefined
      ? fixture
      : path.join(directory, "source.sql");
    const key = path.join(directory, "fingerprint.key");
    const staging = path.join(repositoryRoot, "migration-output", "stage");
    mkdirSync(path.join(repositoryRoot, "content", "recipes"), { recursive: true });
    mkdirSync(path.join(repositoryRoot, "public", "recipes"), { recursive: true });
    mkdirSync(path.join(repositoryRoot, "migration-output"), { recursive: true, mode: 0o700 });
    if (options.databaseContents !== undefined) {
      writeFileSync(database, options.databaseContents, { mode: 0o600 });
    }
    let prototypeSeed: WprmPrototypeSeed | undefined;
    if (options.includePrototypeSeed === true) {
      const prototype = prototypeSeedFixture();
      prototypeSeed = prototype.seed;
      const files = [
        {
          relativePath: prototype.seed.contentRelativePath,
          content: prototype.content
        },
        ...prototype.placeholders.map(({ relativePath, content }) => ({
          relativePath,
          content
        }))
      ];
      for (const file of files) {
        const destination = path.join(repositoryRoot, file.relativePath);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, file.content);
      }
      const trackedFiles = files.map((file) => file.relativePath);
      execFileSync("git", ["init", "-q", repositoryRoot]);
      execFileSync("git", ["-C", repositoryRoot, "add", "--", ...trackedFiles]);
    }
    writeFileSync(
      archive,
      zipArchive([
        {
          name: "uploads/2026/08/fixture.jpg",
          content: originalMedia
        }
      ])
    );
    writeFileSync(key, randomBytes(32), { mode: 0o600 });
    chmodSync(key, 0o600);
    const initial = await runWprmBulkImport({
      database,
      uploadArchives: [archive],
      fingerprintKeyFile: key,
      stagingDir: staging,
      write: true
    });
    await callback({
      archive,
      database,
      initial,
      key,
      prototypeSeed,
      repositoryRoot,
      staging
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function readyRecord(fixtureValues: PromotionFixture) {
  const outcome = fixtureValues.initial.outcomes.find(
    (candidate) => candidate.status === "ready" && candidate.record !== null
  );
  assert.ok(outcome?.record);
  return outcome.record;
}

test("promotion authenticates, records a media manifest, and resumes deterministically", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const firstDryRun = await promoteWprmStaging(promotionOptions(fixtureValues));
    const secondDryRun = await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(secondDryRun, firstDryRun);
    assert.equal(firstDryRun.mode, "dry-run");
    assert.equal(firstDryRun.records.created, firstDryRun.candidates.ready);
    assert.ok(firstDryRun.redirects.published > 0);

    const applied = await promoteWprmStaging(promotionOptions(fixtureValues, true));
    assert.equal(applied.mode, "write");
    assert.equal(applied.records.created, applied.candidates.ready);
    assert.equal(applied.records.reused, 0);
    assert.ok(applied.media.referenced > 0);
    assert.ok(applied.media.addedToManifest > 0);

    const records = loadRecipeCatalog(
      path.join(fixtureValues.repositoryRoot, "content", "recipes")
    );
    const readyIds = new Set(
      fixtureValues.initial.outcomes
        .filter((outcome) => outcome.status === "ready")
        .map((outcome) => outcome.recipeId)
    );
    assert.equal(records.length, readyIds.size);
    assert.ok(records.every((record) => readyIds.has(record.source.recipeId)));
    assert.ok(records.some((record) => record.redirectFrom.length > 0));

    const publishedMedia = records.flatMap((record) => record.media);
    assert.ok(publishedMedia.length > 0);
    const manifest = JSON.parse(readFileSync(
      path.join(fixtureValues.repositoryRoot, "content", "media-manifest.json"),
      "utf8"
    )) as { entries: readonly { key: string }[] };
    assert.equal(manifest.entries.length, new Set(publishedMedia.map((media) => media.path)).size);
    assert.equal(
      publishedMedia.every((media) => manifest.entries.some((entry) => entry.key === media.path)),
      true
    );
    assert.equal(
      existsSync(
        path.join(fixtureValues.repositoryRoot, "public", "recipes", "media", "wordpress")
      ),
      false
    );
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes("wprm_author_name"), false);
    assert.equal(serialized.includes("Fixture author"), false);
    assert.equal(serialized.includes("wprm_pin_image_id"), false);
    assert.equal(serialized.includes("wprm_video_id"), false);

    const resumed = await promoteWprmStaging(promotionOptions(fixtureValues, true));
    assert.equal(resumed.records.created, 0);
    assert.equal(resumed.records.reused, resumed.candidates.ready);
    assert.equal(resumed.media.addedToManifest, 0);
    assert.equal(resumed.media.reusedFromManifest, resumed.media.unique);
  });

});

test("a promotion with no unfinished journal leaves the production hashes unchanged", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    assert.equal(
      readdirSync(path.join(fixtureValues.repositoryRoot, "migration-output"))
        .filter((entry) => entry.startsWith(".wprm-promotion-")).length,
      0
    );
    const result = await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.equal(result.mode, "dry-run");
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
  });
});

test("promotion dry-run rejects merged Azure redirect cycles", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const record = readyRecord(fixtureValues);
    const source = record.redirectFrom[0];
    assert.ok(source);
    writeFileSync(
      path.join(fixtureValues.repositoryRoot, "staticwebapp.config.json"),
      `${JSON.stringify({
        routes: [{
          route: getRecipePath(record),
          redirect: source,
          statusCode: 301
        }]
      }, null, 2)}\n`
    );

    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "invalid-prospective-catalog"
    );
  });
});

const setupAndPublicationCrashPoints = [
  "after-transaction-bootstrap",
  "after-transaction-root",
  "after-transaction-records-directory",
  "after-transaction-backups-directory",
  "after-initial-transaction-journal",
  "after-staged-artifact-write",
  "after-prepared-transaction-journal",
  "after-publishing-transaction-journal",
  "after-create-link"
] as const;

for (const failureInjection of setupAndPublicationCrashPoints) {
  test(`promotion recovery is idempotent after ${failureInjection}`, async () => {
    await withPromotionFixture(async (fixtureValues) => {
      const before = productionSnapshot(fixtureValues.repositoryRoot);
      await assert.rejects(
        promoteWprmStaging({
          ...promotionOptions(fixtureValues, true),
          failureInjection
        }),
        isInjectedInterruption
      );
      await promoteWprmStaging(promotionOptions(fixtureValues));
      assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
      assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
      await promoteWprmStaging(promotionOptions(fixtureValues));
      assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    });
  });
}

test("transaction bootstrap, journal, and directories remain private", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-initial-transaction-journal"
      }),
      isInjectedInterruption
    );
    const transaction = promotionTransactionDirectory(fixtureValues.repositoryRoot);
    assert.equal(statSync(transaction).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(transaction, "records")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(transaction, "backups")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(transaction, "journal.json")).mode & 0o777, 0o600);
    assert.equal(
      statSync(promotionTransactionBootstrap(fixtureValues.repositoryRoot)).mode & 0o777,
      0o600
    );
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("a concurrent promotion attempt fails while the repository lock is held", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    let markLockAcquired: (() => void) | undefined;
    const lockAcquired = new Promise<void>((resolve) => {
      markLockAcquired = resolve;
    });
    let releaseLock: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const first = promoteWprmStaging({
      ...promotionOptions(fixtureValues),
      onPromotionLockAcquired: async () => {
        markLockAcquired?.();
        await lockGate;
      }
    });
    await lockAcquired;
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    try {
      await assert.rejects(
        promoteWprmStaging(promotionOptions(fixtureValues)),
        (error: unknown) =>
          error instanceof WprmPromotionError
          && error.code === "promotion-locked"
      );
      assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    } finally {
      releaseLock?.();
    }
    await first;
    assert.equal(
      existsSync(
        path.join(
          fixtureValues.repositoryRoot,
          "migration-output",
          ".wprm-promotion.lock"
        )
      ),
      false
    );
  });
});

test("a pre-existing or symlinked promotion lock blocks recovery of an interrupted transaction", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const original = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedInterruption
    );
    const lock = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      ".wprm-promotion.lock"
    );
    const target = path.join(fixtureValues.repositoryRoot, "lock-target");
    writeFileSync(target, "do not follow", { mode: 0o600 });
    symlinkSync(target, lock);
    const interrupted = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "promotion-locked"
    );
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), interrupted);
    assert.equal(readFileSync(target, "utf8"), "do not follow");
    unlinkSync(lock);
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), original);
  });
});

test("an EEXIST media-copy loser cannot unlink the exclusive-create winner", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const destination = path.join(path.dirname(fixtureValues.archive), "race.jpg");
    let markWinnerCreated: (() => void) | undefined;
    const winnerCreated = new Promise<void>((resolve) => {
      markWinnerCreated = resolve;
    });
    let releaseWinner: (() => void) | undefined;
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const archive = await openVerifiedUploadArchive(fixtureValues.archive);
    try {
      const winner = copyVerifiedOpenUploadArchiveEntry(
        archive,
        "2026/08/fixture.jpg",
        destination,
        {
          onDestinationCreated: () => {
            markWinnerCreated?.();
            return winnerGate;
          }
        }
      );
      await winnerCreated;
      await assert.rejects(
        copyVerifiedOpenUploadArchiveEntry(
          archive,
          "2026/08/fixture.jpg",
          destination
        )
      );
      releaseWinner?.();
      await winner;
      assert.deepEqual(readFileSync(destination), originalMedia);
    } finally {
      await archive.close();
    }
  });
});

test("promotion requires an explicit repository root", async () => {
  await assert.rejects(
    promoteWprmStaging({
      database: fixture,
      fingerprintKeyFile: "missing",
      stagingDir: "migration-output/missing",
      expected: { ready: 0, review: 0, error: 0 }
    } as unknown as WprmPromotionOptions),
    (error: unknown) =>
      error instanceof WprmPromotionError
      && error.code === "missing-repository-root"
  );
});

test("promotion rejects a same-structure archive whose selected bytes changed", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    writeFileSync(
      fixtureValues.archive,
      zipArchive([
        {
          name: "uploads/2026/08/fixture.jpg",
          content: Buffer.from("replaced media with matching archive structure", "utf8")
        }
      ]),
      { mode: 0o600 }
    );
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "staged-media-binding-mismatch"
    );
  });
});

test("promotion rejects legacy staging without private media bindings", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const markerPath = path.join(fixtureValues.staging, ".wprm-staging.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: marker.kind,
        sqlDecompressedSha256: marker.sqlDecompressedSha256,
        importerContractVersion: "wprm-bulk-import-v3"
      })}\n`,
      { mode: 0o600 }
    );
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "staging-media-binding-upgrade-required"
    );
    await assert.rejects(
      runWprmBulkImport({
        database: fixtureValues.database,
        uploadArchives: [fixtureValues.archive],
        fingerprintKeyFile: fixtureValues.key,
        stagingDir: fixtureValues.staging,
        write: true
      }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-media-binding-upgrade-required"
    );
  });
});

test("promotion rejects candidate HMAC tampering and staging symlinks", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const record = readyRecord(fixtureValues);
    const candidate = path.join(
      fixtureValues.staging,
      "candidates",
      `${record.source.recipeId}.json`
    );
    const altered = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
    altered.title = "Changed";
    writeFileSync(candidate, JSON.stringify(altered), { mode: 0o600 });
    chmodSync(candidate, 0o600);
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "staged-candidate-hmac-mismatch"
    );
  });

  await withPromotionFixture(async (fixtureValues) => {
    const record = readyRecord(fixtureValues);
    const candidate = path.join(
      fixtureValues.staging,
      "candidates",
      `${record.source.recipeId}.json`
    );
    const target = `${candidate}.target`;
    writeFileSync(target, readFileSync(candidate), { mode: 0o600 });
    chmodSync(target, 0o600);
    unlinkSync(candidate);
    symlinkSync(target, candidate);
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "unsafe-staging"
    );
  });
});

test("promotion hard-fails record and media-manifest collisions instead of overwriting", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const record = readyRecord(fixtureValues);
    const target = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "recipes",
      record.locale,
      `${record.slug}.json`
    );
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ ...record, title: "Changed" }));
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues, true)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "promotion-content-collision"
    );
  });

  await withPromotionFixture(async (fixtureValues) => {
    await promoteWprmStaging(promotionOptions(fixtureValues, true));
    const manifestPath = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "media-manifest.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries: Array<{ sha256: string }>;
    };
    assert.ok(manifest.entries[0]);
    manifest.entries[0]!.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o644 });
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues, true)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "media-manifest-collision"
    );
  });
});

test("a publish failure rolls back every new record and media manifest", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const record = readyRecord(fixtureValues);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-first-publication"
      }),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "injected-promotion-failure"
    );
    assert.equal(
      existsSync(
        path.join(
          fixtureValues.repositoryRoot,
          "content/recipes",
          record.locale,
          `${record.slug}.json`
        )
      ),
      false
    );
    assert.equal(
      existsSync(
        path.join(
          fixtureValues.repositoryRoot,
          "content/media-manifest.json"
        )
      ),
      false
    );
  });
});

test("startup recovery rolls back after some new files publish and is idempotent", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "injected-promotion-interruption"
    );
    const interrupted = productionSnapshot(fixtureValues.repositoryRoot);
    assert.notDeepEqual(interrupted, before);
    const recovered = await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.equal(recovered.mode, "dry-run");
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    assert.equal(
      readdirSync(path.join(fixtureValues.repositoryRoot, "migration-output"))
        .filter((entry) => entry.startsWith(".wprm-promotion-")).length,
      0
    );
    const repeated = await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.equal(repeated.mode, "dry-run");
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
  });
});

test("startup recovery restores a prototype seed after interruption before replacement link", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-live-move-before-replacement-link"
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "injected-promotion-interruption"
    );
    assert.equal(
      existsSync(
        path.join(
          fixtureValues.repositoryRoot,
          "content/recipes/en/meatballs-soup.json"
        )
      ),
      false
    );
    const interrupted = productionSnapshot(fixtureValues.repositoryRoot);
    assert.notDeepEqual(interrupted, before);
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
  }, {
    databaseContents: authoritativeSeedReplacementSql(),
    includePrototypeSeed: true
  });
});

test("startup recovery restores a replacement after its destination link boundary", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-replacement-link"
      }),
      isInjectedInterruption
    );
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  }, {
    databaseContents: authoritativeSeedReplacementSql(),
    includePrototypeSeed: true
  });
});

test("startup recovery restores a placeholder after its move boundary", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-remove-live-move"
      }),
      isInjectedInterruption
    );
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  }, {
    databaseContents: authoritativeSeedReplacementSql(),
    includePrototypeSeed: true
  });
});

test("startup recovery restores a moved media manifest before replacement link", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const manifest = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "media-manifest.json"
    );
    writeFileSync(
      manifest,
      JSON.stringify({
        schemaVersion: 1,
        kind: "recipe-media-manifest",
        entries: []
      }) + "\n",
      { mode: 0o644 }
    );
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-live-move-before-replacement-link"
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "injected-promotion-interruption"
    );
    assert.equal(existsSync(manifest), false);
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
  });
});

test("recovery discards an authenticated orphan journal temp and preserves the last journal", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedInterruption
    );
    const transaction = promotionTransactionDirectory(fixtureValues.repositoryRoot);
    const journal = readFileSync(path.join(transaction, "journal.json"));
    writeFileSync(
      path.join(transaction, `.journal.${"a".repeat(32)}.tmp`),
      journal,
      { mode: 0o600 }
    );
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("a symlinked orphan journal temp fails closed before recovery changes live files", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedInterruption
    );
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    const transaction = promotionTransactionDirectory(fixtureValues.repositoryRoot);
    const target = path.join(fixtureValues.repositoryRoot, "journal-temp-target");
    writeFileSync(target, readFileSync(path.join(transaction, "journal.json")), {
      mode: 0o600
    });
    symlinkSync(
      target,
      path.join(transaction, `.journal.${"b".repeat(32)}.tmp`)
    );
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "invalid-promotion-journal"
    );
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
  });
});

test("a tampered bootstrap marker fails before recovery changes live files", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      }),
      isInjectedInterruption
    );
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    const bootstrap = promotionTransactionBootstrap(fixtureValues.repositoryRoot);
    const value = JSON.parse(readFileSync(bootstrap, "utf8")) as Record<string, unknown>;
    value.repositoryRoot = path.join(fixtureValues.repositoryRoot, "different-root");
    writeFileSync(bootstrap, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(bootstrap, 0o600);
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "invalid-promotion-journal"
    );
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
  });
});

const committedCleanupCrashPoints = [
  "after-cleanup-transaction-journal",
  "after-cleanup-staged-unlink",
  "after-cleanup-journal-unlink"
] as const;

for (const failureInjection of committedCleanupCrashPoints) {
  test(`committed cleanup resumes safely after ${failureInjection}`, async () => {
    await withPromotionFixture(async (fixtureValues) => {
      const before = productionSnapshot(fixtureValues.repositoryRoot);
      await assert.rejects(
        promoteWprmStaging({
          ...promotionOptions(fixtureValues, true),
          failureInjection
        }),
        isInjectedInterruption
      );
      const committed = productionSnapshot(fixtureValues.repositoryRoot);
      assert.notDeepEqual(committed, before);
      await promoteWprmStaging(promotionOptions(fixtureValues));
      assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), committed);
      assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
      await promoteWprmStaging(promotionOptions(fixtureValues));
      assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), committed);
    });
  });
}

const rollbackCrashPoints = [
  "after-rollback-transaction-journal",
  "after-rollback-create-unlink"
] as const;

for (const failureInjection of rollbackCrashPoints) {
  test(`rollback resumes safely after ${failureInjection}`, async () => {
    await withPromotionFixture(async (fixtureValues) => {
      const before = productionSnapshot(fixtureValues.repositoryRoot);
      await assert.rejects(
        promoteWprmStaging({
          ...promotionOptions(fixtureValues, true),
          failureInjection: [
            "after-first-publication",
            failureInjection
          ]
        }),
        isInjectedInterruption
      );
      await promoteWprmStaging(promotionOptions(fixtureValues));
      assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
      assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
    });
  });
}

test("cleanup tolerates an already-removed staged artifact after a committed journal", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-cleanup-staged-unlink"
      }),
      isInjectedInterruption
    );
    const committed = productionSnapshot(fixtureValues.repositoryRoot);
    assert.notDeepEqual(committed, before);
    await promoteWprmStaging(promotionOptions(fixtureValues));
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), committed);
  });
});

test("cleanup tolerates an already-removed backup artifact after a committed journal", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const manifest = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "media-manifest.json"
    );
    writeFileSync(
      manifest,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "recipe-media-manifest",
        entries: []
      })}\n`,
      { mode: 0o644 }
    );
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-cleanup-backup-unlink"
      }),
      isInjectedInterruption
    );
    const committed = productionSnapshot(fixtureValues.repositoryRoot);
    assert.notDeepEqual(committed, before);
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), committed);
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  });
});

test("tampered promotion journals fail without changing the interrupted live catalog", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      })
    );
    const beforeTamper = productionSnapshot(fixtureValues.repositoryRoot);
    const journal = path.join(
      promotionTransactionDirectory(fixtureValues.repositoryRoot),
      "journal.json"
    );
    const parsed = JSON.parse(readFileSync(journal, "utf8")) as {
      operations: Array<{ destination: string }>;
    };
    assert.ok(parsed.operations[0]);
    parsed.operations[0]!.destination = path.join(
      fixtureValues.repositoryRoot,
      "outside-live-file.json"
    );
    writeFileSync(journal, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    chmodSync(journal, 0o600);
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "invalid-promotion-journal"
    );
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), beforeTamper);
  });
});

test("a symlinked promotion journal fails closed without changing live files", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-some-new-files-publish"
      })
    );
    const beforeTamper = productionSnapshot(fixtureValues.repositoryRoot);
    const journal = path.join(
      promotionTransactionDirectory(fixtureValues.repositoryRoot),
      "journal.json"
    );
    const target = path.join(fixtureValues.repositoryRoot, "journal-target");
    writeFileSync(target, readFileSync(journal), { mode: 0o600 });
    unlinkSync(journal);
    symlinkSync(target, journal);
    await assert.rejects(
      promoteWprmStaging(promotionOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "invalid-promotion-journal"
    );
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), beforeTamper);
  });
});

test("authenticated upload staging is private, resumable, and rejects tampering", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await promoteWprmStaging(promotionOptions(fixtureValues, true));
    const first = await createWprmMediaUploadPlan(uploadPlanOptions(fixtureValues));
    assert.equal(first.mode, "write");
    assert.equal(first.objects.created, first.objects.count);

    const record = readyRecord(fixtureValues);
    const media = record.media[0];
    assert.ok(media);
    const staged = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      "wprm-media-upload",
      "objects",
      media.path
    );
    assert.deepEqual(readFileSync(staged), originalMedia);
    assert.equal(statSync(staged).mode & 0o777, 0o600);

    const resumed = await createWprmMediaUploadPlan(
      uploadPlanOptions(fixtureValues, { resume: true })
    );
    assert.equal(resumed.objects.created, 0);
    assert.equal(resumed.objects.reused, resumed.objects.count);

    writeFileSync(staged, "tampered", { mode: 0o600 });
    await assert.rejects(
      createWprmMediaUploadPlan(uploadPlanOptions(fixtureValues, { resume: true })),
      (error: unknown) =>
        error instanceof WprmMediaUploadPlanError
        && error.code === "upload-staging-conflict"
    );
  });
});

test("authenticated upload staging rejects symlinked object destinations", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await promoteWprmStaging(promotionOptions(fixtureValues, true));
    const media = readyRecord(fixtureValues).media[0];
    assert.ok(media);
    const destination = path.join(
      fixtureValues.repositoryRoot,
      "migration-output",
      "wprm-media-upload",
      "objects",
      media.path
    );
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const target = path.join(fixtureValues.repositoryRoot, "outside-media");
    writeFileSync(target, originalMedia, { mode: 0o600 });
    symlinkSync(target, destination);
    await assert.rejects(
      createWprmMediaUploadPlan(uploadPlanOptions(fixtureValues)),
      (error: unknown) =>
        error instanceof WprmMediaUploadPlanError
        && error.code === "unsafe-upload-staging"
    );
  });
});

test("the allowlisted prototype replacement restores the exact seed on failure", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const seed = path.join(
      fixtureValues.repositoryRoot,
      "content/recipes/en/meatballs-soup.json"
    );
    const placeholders = [
      path.join(fixtureValues.repositoryRoot, "public/recipes/meatballs-soup/hero.png"),
      path.join(
        fixtureValues.repositoryRoot,
        "public/recipes/meatballs-soup/steps/01-meatball-mix.png"
      )
    ];
    const originalSeed = readFileSync(seed);
    const originalPlaceholders = placeholders.map((placeholder) => readFileSync(placeholder));
    assert.equal(
      fixtureValues.initial.outcomes.some((outcome) =>
        outcome.status === "ready" && outcome.recipeId === "21681"
      ),
      true
    );

    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-prototype-replacement"
      }),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "injected-promotion-failure"
    );
    assert.deepEqual(readFileSync(seed), originalSeed);
    for (const [index, placeholder] of placeholders.entries()) {
      assert.deepEqual(readFileSync(placeholder), originalPlaceholders[index]);
    }
    assert.equal(
      existsSync(
        path.join(
          fixtureValues.repositoryRoot,
          "public/recipes/media/wordpress/900.jpg"
        )
      ),
      false
    );

    const applied = await promoteWprmStaging(promotionOptions(fixtureValues, true));
    const replacement = recipeRecordSchema.parse(JSON.parse(readFileSync(seed, "utf8")));
    assert.equal(replacement.id, "wordpress:wprm:21681");
    assert.equal(replacement.source.recipeId, "21681");
    assert.equal(existsSync(placeholders[0]!), false);
    assert.equal(existsSync(placeholders[1]!), false);
    const resumed = await promoteWprmStaging(promotionOptions(fixtureValues, true));
    assert.equal(applied.records.created > 0, true);
    assert.equal(resumed.records.reused, resumed.candidates.ready);
  }, {
    databaseContents: authoritativeSeedReplacementSql(),
    includePrototypeSeed: true
  });
});

test("rollback resumes after restoring a replacement backup at the rename boundary", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: [
          "after-prototype-replacement",
          "after-rollback-backup-rename"
        ]
      }),
      isInjectedInterruption
    );
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  }, {
    databaseContents: authoritativeSeedReplacementSql(),
    includePrototypeSeed: true
  });
});

test("rollback resumes after unlinking a replacement before backup restoration", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    const before = productionSnapshot(fixtureValues.repositoryRoot);
    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: [
          "after-prototype-replacement",
          "after-rollback-replacement-unlink"
        ]
      }),
      isInjectedInterruption
    );
    await promoteWprmStaging(promotionOptions(fixtureValues));
    assert.deepEqual(productionSnapshot(fixtureValues.repositoryRoot), before);
    assertNoPromotionTransactionArtifacts(fixtureValues.repositoryRoot);
  }, {
    databaseContents: authoritativeSeedReplacementSql(),
    includePrototypeSeed: true
  });
});

test("a display-text normalization replacement is authenticated and rolls back in a disposable root", async () => {
  await withPromotionFixture(async (fixtureValues) => {
    await promoteWprmStaging(promotionOptions(fixtureValues, true));
    const candidate = fixtureValues.initial.outcomes.find(
      (outcome) =>
        outcome.recipeId === "109"
        && outcome.status === "ready"
        && outcome.record !== null
    );
    assert.ok(candidate?.record);
    const destination = path.join(
      fixtureValues.repositoryRoot,
      "content",
      "recipes",
      candidate.record.locale,
      `${candidate.record.slug}.json`
    );
    const current = JSON.parse(readFileSync(destination, "utf8")) as Record<string, unknown>;
    current.description = "<p>Recipe <em>description</em> &amp; detail.</p>";
    writeFileSync(destination, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o644 });
    const original = readFileSync(destination);

    await assert.rejects(
      promoteWprmStaging({
        ...promotionOptions(fixtureValues, true),
        failureInjection: "after-normalized-display-text-replacement"
      }),
      (error: unknown) =>
        error instanceof WprmPromotionError
        && error.code === "injected-promotion-failure"
    );
    assert.deepEqual(readFileSync(destination), original);

    const applied = await promoteWprmStaging(promotionOptions(fixtureValues, true));
    assert.equal(applied.records.replacedNormalizedDisplayText, 1);
    const normalized = recipeRecordSchema.parse(
      JSON.parse(readFileSync(destination, "utf8")) as unknown
    );
    assert.equal(normalized.description, "Recipe description & detail.");
  }, {
    databaseContents: readFileSync(fixture, "utf8").replace(
      "'Ungrouped parent description'",
      "'<p>Recipe <em>description</em> &amp; detail.</p>'"
    )
  });
});

test("translation closure blocks error peers and all three review exclusions", () => {
  const base = recipeRecordSchema.parse({
    schemaVersion: 1,
    kind: "recipe",
    id: "wordpress:wprm:100",
    locale: "en",
    translationGroupId: "wordpress:post-translations:1",
    slug: "ready",
    source: {
      system: "wordpress",
      postId: "100",
      recipeId: "100",
      postType: "wprm_recipe",
      plugin: "wprm",
      sourceSlug: "ready",
      createdAt: null,
      modifiedAt: null,
      editorialPostId: null,
      editorialPostType: null,
      editorialSourceSlug: null,
      editorialCreatedAt: null,
      editorialModifiedAt: null
    },
    redirectFrom: [],
    title: "Ready",
    description: null,
    editorial: {
      content: null,
      excerpt: null
    },
    taxonomies: [],
    recipe: {
      notes: null,
      servings: null,
      times: {
        prep: null,
        cook: null,
        rest: null,
        total: null,
        custom: null
      },
      heroMediaId: null,
      ingredientGroups: [{
        name: null,
        sourceIndex: 0,
        items: [{
          sourceIndex: 0,
          raw: "One item",
          quantity: null,
          name: "item",
          notes: null
        }]
      }],
      instructionGroups: [{
        name: null,
        sourceIndex: 0,
        steps: [{
          sourceIndex: 0,
          text: "One step",
          mediaId: null
        }]
      }]
    },
    media: [],
    seo: null
  });
  const review = recipeRecordSchema.parse({
    ...base,
    id: "wordpress:wprm:101",
    locale: "fr",
    slug: "review",
    source: {
      ...base.source,
      postId: "101",
      recipeId: "101",
      sourceSlug: "review"
    }
  });
  const outcomes: CandidateOutcome[] = [
    {
      recipeId: "100",
      status: "ready",
      locale: "en",
      codes: [],
      record: base,
      fingerprint: "a"
    },
    {
      recipeId: "101",
      status: "review",
      locale: "fr",
      codes: ["incomplete-parent-translation"],
      record: review,
      fingerprint: "b"
    }
  ];
  assert.throws(
    () => validatePromotionTranslationClosure(
      [base],
      outcomes,
      [],
      new Map([
        ["100", "wordpress:post-translations:1"],
        ["101", "wordpress:post-translations:1"]
      ])
    ),
    (error: unknown) =>
      error instanceof WprmPromotionError
      && error.code === "incomplete-translation-closure"
  );

  const errorPeer: CandidateOutcome = {
    recipeId: "101",
    status: "error",
    locale: "fr",
    codes: ["missing-wprm-title"],
    record: null,
    fingerprint: null
  };
  assert.throws(
    () => validatePromotionTranslationClosure(
      [base],
      [outcomes[0]!, errorPeer],
      [],
      new Map([
        ["100", "wordpress:post-translations:1"],
        ["101", "wordpress:post-translations:1"]
      ])
    ),
    (error: unknown) =>
      error instanceof WprmPromotionError
      && error.code === "incomplete-translation-closure"
  );
  const classifiedError = classifyPromotionTranslationClosure(
    [base],
    [outcomes[0]!, errorPeer],
    [],
    new Map([
      ["100", "wordpress:post-translations:1"],
      ["101", "wordpress:post-translations:1"]
    ])
  );
  assert.equal(classifiedError.selected.length, 0);
  assert.deepEqual(
    {
      excluded: classifiedError.excluded,
      blockedGroups: classifiedError.blockedGroups,
      reviewPeers: classifiedError.reviewPeers,
      errorPeers: classifiedError.errorPeers
    },
    {
      excluded: 1,
      blockedGroups: 1,
      reviewPeers: 0,
      errorPeers: 1
    }
  );

  const extraReady = [2, 3].map((group) => recipeRecordSchema.parse({
    ...base,
    id: `wordpress:wprm:${group}00`,
    translationGroupId: `wordpress:post-translations:${group}`,
    slug: `ready-${group}`,
    source: {
      ...base.source,
      postId: `${group}00`,
      recipeId: `${group}00`,
      sourceSlug: `ready-${group}`
    }
  }));
  const reviewExclusions: CandidateOutcome[] = [
    outcomes[0]!,
    ...extraReady.map((record) => ({
      recipeId: record.source.recipeId,
      status: "ready" as const,
      locale: record.locale,
      codes: [],
      record,
      fingerprint: "ready"
    })),
    ...[1, 2, 3].map((group) => ({
      recipeId: `${group}01`,
      status: "review" as const,
      locale: "fr" as const,
      codes: ["incomplete-parent-translation"] as const,
      record: null,
      fingerprint: null
    }))
  ];
  assert.throws(
    () => validatePromotionTranslationClosure(
      [base, ...extraReady],
      reviewExclusions,
      [],
      new Map([
        ["100", "wordpress:post-translations:1"],
        ["101", "wordpress:post-translations:1"],
        ["200", "wordpress:post-translations:2"],
        ["201", "wordpress:post-translations:2"],
        ["300", "wordpress:post-translations:3"],
        ["301", "wordpress:post-translations:3"]
      ])
    ),
    (error: unknown) =>
      error instanceof WprmPromotionError
      && error.code === "incomplete-translation-closure"
  );
});
