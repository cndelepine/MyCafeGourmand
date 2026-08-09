import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  parsePhpSerialized
} from "../scripts/wordpress/php-serialize";
import {
  runWprmBulkImport
} from "../scripts/wordpress/wprm-import-runner";
import {
  parseWprmQuantity
} from "../scripts/wordpress/wprm-import-map";
import {
  runImporter
} from "../scripts/import-wordpress-recipe";
import { recipeRecordSchema } from "../src/content/schema";

const fixture = path.resolve(
  process.cwd(),
  "test/fixtures/wordpress/wprm-bulk.sql"
);

function zipArchive(names: readonly string[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(0, 18);
    localHeader.writeUInt32LE(0, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, nameBytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(0, 20);
    centralHeader.writeUInt32LE(0, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function withDirectory<T>(callback: (directory: string) => Promise<T>) {
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-bulk-test-"));
  const stagingDir = path.join(
    process.cwd(),
    "migration-output",
    `.wprm-bulk-stage-${path.basename(directory)}`
  );
  return callback(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  });
}

test("PHP serialization uses UTF-8 byte lengths", () => {
  assert.equal(parsePhpSerialized('s:2:"½";'), "½");
  assert.throws(() => parsePhpSerialized('s:1:"½";'), /UTF-8 string length/);
  assert.throws(() => parsePhpSerialized('s:2:"½";trailing'), /trailing/);
});

test("bulk dry-run accounts WPRM outcomes and does not leak source values", async () => {
  await withDirectory(async (directory) => {
    const archive = path.join(directory, "uploads.zip");
    const keyFile = path.join(directory, "fingerprint.key");
    writeFileSync(archive, zipArchive(["uploads/2026/08/fixture.jpg"]));
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const result = await runWprmBulkImport({
      database: fixture,
      uploadArchives: [archive],
      fingerprintKeyFile: keyFile,
      dryRun: true
    });
    assert.equal(result.manifest.candidates.total, 10);
    assert.equal(
      result.manifest.candidates.ready
      + result.manifest.candidates.review
      + result.manifest.candidates.error,
      10
    );
    assert.equal(result.manifest.wpurSignals, 1);
    assert.equal(result.manifest.wpurRecordsEmitted, 0);
    assert.equal(result.manifest.redirects.accepted, 0);
    const ready = result.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.record?.slug, "editorial-ready");
    assert.equal(ready?.record?.recipe.times.custom?.duration?.minutes, 5);
    assert.deepEqual(ready?.record?.recipe.times.rest, null);
    assert.equal(ready?.record?.media[0]?.path, "/recipes/media/wordpress/900.jpg");
    assert.equal(ready?.record?.media[0]?.alt, "Fixture alt");
    assert.equal(ready?.record?.recipe.ingredientGroups[0]?.items[0]?.quantity?.value, 1.5);
    assert.equal(ready?.record?.recipe.ingredientGroups[0]?.items[0]?.raw, "1 1/2 cups Flour, sifted");
    const informational = result.outcomes.find((outcome) => outcome.recipeId === "109");
    assert.equal(informational?.status, "ready");
    assert.equal(informational?.codes.includes("excluded-rating-data"), true);
    assert.equal(informational?.codes.includes("excluded-operational-data"), true);
    assert.equal(informational?.codes.includes("unsupported-wprm-field"), false);
    const contentReview = result.outcomes.find((outcome) => outcome.recipeId === "107");
    assert.equal(contentReview?.codes.includes("unsupported-wprm-field"), true);
    const serialized = JSON.stringify(result.manifest);
    for (const sentinel of [
      "Ready recipe",
      "Editorial body",
      "recipe-ready",
      "fixture.jpg",
      "Fixture alt",
      "2026-08-01"
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
  });
});

test("private staging is schema-valid, mode restricted, and resumable", async () => {
  await withDirectory(async (directory) => {
    const archive = path.join(directory, "uploads.zip");
    const keyFile = path.join(directory, "fingerprint.key");
    const stagingDir = path.join(
      process.cwd(),
      "migration-output",
      `.wprm-bulk-stage-${path.basename(directory)}`
    );
    writeFileSync(archive, zipArchive(["uploads/2026/08/fixture.jpg"]));
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const options = {
      database: fixture,
      uploadArchives: [archive],
      fingerprintKeyFile: keyFile,
      write: true,
      stagingDir
    } as const;
    const first = await runWprmBulkImport(options);
    assert.equal(statSync(stagingDir).mode & 0o777, 0o700);
    const candidatePath = path.join(stagingDir, "candidates", "100.json");
    assert.equal(statSync(candidatePath).mode & 0o777, 0o600);
    const markerPath = path.join(stagingDir, ".wprm-staging.json");
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);
    const candidate = recipeRecordSchema.parse(
      JSON.parse(readFileSync(candidatePath, "utf8")) as unknown
    );
    assert.equal(candidate.title, "Ready recipe");
    const manifestPath = path.join(stagingDir, "manifest.json");
    rmSync(manifestPath);
    const resumed = await runWprmBulkImport({ ...options, resume: true });
    assert.deepEqual(resumed.manifest, first.manifest);
    writeFileSync(candidatePath, "{}");
    await assert.rejects(
      runWprmBulkImport({ ...options, resume: true }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-conflict"
    );
    assert.deepEqual(
      readdirSync(path.join(stagingDir, "candidates")).filter((name) => name === "102.json"),
      []
    );
  });
});

test("quantity parsing keeps unsafe amounts unscalable", () => {
  assert.equal(parseWprmQuantity("½", "cup")?.value, 0.5);
  assert.deepEqual(parseWprmQuantity("1-2", "tbsp")?.min, 1);
  assert.equal(parseWprmQuantity("about 2", "cups")?.scalable, false);
  assert.equal(parseWprmQuantity("2", "cups")?.scalable, true);
});

test("the importer decodes the canonical slug but preserves source provenance", async () => {
  await withDirectory(async (directory) => {
    const encodedSlug = encodeURIComponent("рецепт");
    const database = path.join(directory, "encoded.sql");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace("recipe-parentless", encodedSlug)
    );
    const keyFile = path.join(directory, "fingerprint.key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const result = await runWprmBulkImport({
      database,
      fingerprintKeyFile: keyFile,
      dryRun: true
    });
    const candidate = result.outcomes.find((outcome) => outcome.recipeId === "101");
    assert.equal(candidate?.record?.slug, "рецепт");
    assert.equal(candidate?.record?.source.sourceSlug, encodedSlug);
  });
});

test("legacy single-recipe options are rejected", async () => {
  await assert.rejects(
    runImporter(["--database", fixture, "--recipe-id", "100"]),
    /Legacy --recipe-id/
  );
});
