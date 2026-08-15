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
  parseWprmQuantity,
  parseWprmServingsAdvancedEnabled
} from "../scripts/wordpress/wprm-import-map";
import {
  runImporter
} from "../scripts/import-wordpress-recipe";
import { recipeRecordSchema } from "../src/content/schema";
import type { WprmIssueCode } from "../scripts/wordpress/wprm-import-contracts";

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

async function runFixtureVariant(
  directory: string,
  replacements: readonly (readonly [string, string])[]
) {
  const database = path.join(directory, `variant-${randomBytes(4).toString("hex")}.sql`);
  const archive = path.join(directory, `variant-${randomBytes(4).toString("hex")}.zip`);
  const keyFile = path.join(directory, `variant-${randomBytes(4).toString("hex")}.key`);
  let sql = readFileSync(fixture, "utf8");
  for (const [from, to] of replacements) {
    if (!sql.includes(from)) {
      throw new Error("fixture replacement did not match");
    }
    sql = sql.replace(from, to);
  }
  writeFileSync(database, sql);
  writeFileSync(archive, zipArchive(["uploads/2026/08/fixture.jpg"]));
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  return runWprmBulkImport({
    database,
    uploadArchives: [archive],
    fingerprintKeyFile: keyFile,
    dryRun: true
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
    assert.equal(result.manifest.redirects.accepted, 2);
    const ready = result.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.record?.slug, "editorial-ready");
    assert.equal(ready?.record?.recipe.times.custom?.duration?.minutes, 5);
    assert.deepEqual(ready?.record?.recipe.times.rest, null);
    assert.equal(ready?.record?.media[0]?.path, "/recipes/media/wordpress/900.jpg");
    assert.equal(ready?.record?.media[0]?.alt, "Fixture alt");
    assert.equal(ready?.record?.recipe.ingredientGroups[0]?.items[0]?.quantity?.value, 1.5);
    assert.equal(ready?.record?.recipe.ingredientGroups[0]?.items[0]?.raw, "1 1/2 cups Flour, sifted");
    assert.deepEqual(ready?.record?.recipe.nutrition, {
      calories: { raw: "220", value: 220 },
      servingSize: { raw: "1", value: 1 },
      servingUnit: "slice"
    });
    assert.deepEqual(ready?.record?.recipe.servingsAdvanced, {
      diameter: 0,
      height: 0,
      length: 0,
      shape: "round",
      unit: "cm",
      width: 0
    });
    assert.equal(ready?.record?.recipe.servingsAdvancedEnabled, false);
    assert.deepEqual(ready?.record?.recipe.equipment, [{
      sourceIndex: 0,
      sourceId: "17",
      name: "Fixture equipment",
      amount: "1",
      notes: null
    }]);
    for (const code of [
      "excluded-author-data",
      "excluded-social-media-data",
      "excluded-video-data",
      "excluded-wprm-type"
    ] as const) {
      assert.equal(ready?.codes.includes(code), true, code);
    }
    assert.equal(ready?.codes.includes("unsupported-wprm-field"), false);
    assert.deepEqual(result.manifest.aggregate.nonLaunchFields, {
      authorNamesExcluded: 1,
      pinImageFieldsExcluded: 2,
      pinImageFieldsWithoutReference: 0,
      resolvedPinImageReferences: 1,
      unresolvedPinImageReferences: 0,
      videoFieldsExcluded: 1,
      opaqueTypesExcluded: 1
    });
    const nonpublish = result.outcomes.find((outcome) => outcome.recipeId === "102");
    assert.equal(nonpublish?.status, "error");
    assert.equal(nonpublish?.codes.includes("nonpublish-recipe"), true);
    assert.equal(nonpublish?.record, null);
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
      "Fixture author",
      "Fixture equipment",
      "food",
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
    const candidateContent = readFileSync(candidatePath, "utf8");
    const markerPath = path.join(stagingDir, ".wprm-staging.json");
    assert.equal(statSync(markerPath).mode & 0o777, 0o600);
    const candidate = recipeRecordSchema.parse(
      JSON.parse(candidateContent) as unknown
    );
    assert.equal(candidate.title, "Ready recipe");
    assert.equal(candidate.recipe.nutrition?.calories?.raw, "220");
    assert.equal(candidate.recipe.equipment?.[0]?.name, "Fixture equipment");
    assert.equal(candidateContent.includes("Fixture author"), false);
    assert.equal(candidateContent.includes("fixture-source-type"), false);
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

test("nutrition retains opaque source values without inventing a number", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "nutrition.sql");
    const archive = path.join(directory, "uploads.zip");
    const keyFile = path.join(directory, "fingerprint.key");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        "'wprm_nutrition_calories', '220'",
        "'wprm_nutrition_calories', 'about 220'"
      )
    );
    writeFileSync(archive, zipArchive(["uploads/2026/08/fixture.jpg"]));
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const result = await runWprmBulkImport({
      database,
      uploadArchives: [archive],
      fingerprintKeyFile: keyFile,
      dryRun: true
    });
    const ready = result.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.deepEqual(ready?.record?.recipe.nutrition?.calories, {
      raw: "about 220"
    });
  });
});

test("advanced servings preserve disabled sparse source data and plugin defaults", async () => {
  await withDirectory(async (directory) => {
    const result = await runFixtureVariant(directory, [
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        'a:2:{s:5:"shape";s:5:"round";s:4:"unit";s:4:"inch";}'
      ]
    ]);
    const ready = result.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.record?.recipe.servingsAdvancedEnabled, false);
    assert.deepEqual(ready?.record?.recipe.servingsAdvanced, {
      diameter: 0,
      height: 0,
      length: 0,
      shape: "round",
      unit: "inch",
      width: 0
    });
  });
});

test("enabled sparse advanced servings use only WPRM structural defaults", async () => {
  await withDirectory(async (directory) => {
    const result = await runFixtureVariant(directory, [
      ["'wprm_servings_advanced_enabled', '0'", "'wprm_servings_advanced_enabled', '1'"],
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        'a:0:{}'
      ]
    ]);
    const ready = result.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.record?.recipe.servingsAdvancedEnabled, true);
    assert.deepEqual(ready?.record?.recipe.servingsAdvanced, {
      diameter: 0,
      height: 0,
      length: 0,
      shape: "round",
      unit: "inch",
      width: 0
    });
  });
});

test("advanced servings unknown and malformed structures stay reviewable", async () => {
  await withDirectory(async (directory) => {
    const unknown = await runFixtureVariant(directory, [
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        'a:1:{s:4:"seed";s:1:"x";}'
      ]
    ]);
    const unknownOutcome = unknown.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(unknownOutcome?.status, "review");
    assert.equal(
      unknownOutcome?.codes.includes("unsupported-wprm-servings-advanced"),
      true
    );
    assert.deepEqual(unknownOutcome?.record?.recipe.servingsAdvanced, {
      diameter: 0,
      height: 0,
      length: 0,
      shape: "round",
      unit: "inch",
      width: 0
    });

    const malformed = await runFixtureVariant(directory, [
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        's:3:"bad";'
      ]
    ]);
    const malformedOutcome = malformed.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(malformedOutcome?.status, "review");
    assert.equal(
      malformedOutcome?.codes.includes("malformed-wprm-servings-advanced"),
      true
    );
  });
});

test("advanced servings enforce WPRM shape and unit enums", async () => {
  await withDirectory(async (directory) => {
    const supported = await runFixtureVariant(directory, [
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:9:"rectangle";s:4:"unit";s:2:"cm";s:5:"width";i:0;}'
      ]
    ]);
    const supportedOutcome = supported.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.equal(supportedOutcome?.status, "ready");
    assert.deepEqual(supportedOutcome?.record?.recipe.servingsAdvanced, {
      diameter: 0,
      height: 0,
      length: 0,
      shape: "rectangle",
      unit: "cm",
      width: 0
    });

    const unknownShape = await runFixtureVariant(directory, [
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:6:"circle";s:4:"unit";s:2:"cm";s:5:"width";i:0;}'
      ]
    ]);
    const unknownShapeOutcome = unknownShape.outcomes.find(
      (outcome) => outcome.recipeId === "100"
    );
    assert.equal(unknownShapeOutcome?.status, "review");
    assert.equal(
      unknownShapeOutcome?.codes.includes("unsupported-wprm-servings-advanced"),
      true
    );

    const unknownUnit = await runFixtureVariant(directory, [
      [
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:2:"cm";s:5:"width";i:0;}',
        'a:6:{s:8:"diameter";i:0;s:6:"height";i:0;s:6:"length";i:0;s:5:"shape";s:5:"round";s:4:"unit";s:4:"feet";s:5:"width";i:0;}'
      ]
    ]);
    const unknownUnitOutcome = unknownUnit.outcomes.find(
      (outcome) => outcome.recipeId === "100"
    );
    assert.equal(unknownUnitOutcome?.status, "review");
    assert.equal(
      unknownUnitOutcome?.codes.includes("unsupported-wprm-servings-advanced"),
      true
    );
  });
});

test("advanced serving enabled values accept WPRM boolean representations", () => {
  assert.deepEqual(parseWprmServingsAdvancedEnabled(undefined), {
    enabled: false,
    issueCode: null
  });
  assert.deepEqual(parseWprmServingsAdvancedEnabled("0"), {
    enabled: false,
    issueCode: null
  });
  assert.deepEqual(parseWprmServingsAdvancedEnabled("1"), {
    enabled: true,
    issueCode: null
  });
});

test("WPRM type handling follows food, default, and non-food plugin behavior", async () => {
  await withDirectory(async (directory) => {
    const variants: readonly (readonly [string, "ready" | "review", WprmIssueCode])[] = [
      ["food", "ready", "excluded-wprm-type"],
      ["howto", "review", "unsupported-wprm-type"],
      ["other", "review", "unsupported-wprm-type"],
      ["non-food", "review", "unsupported-wprm-type"],
      ["dessert", "review", "unsupported-wprm-type"],
      ['a:1:{s:4:"type";s:4:"food";}', "review", "malformed-wprm-type"]
    ];
    for (const [value, status, code] of variants) {
      const result = await runFixtureVariant(directory, [
        ["'wprm_type', 'food'", `'wprm_type', '${value}'`]
      ]);
      const outcome = result.outcomes.find((candidate) => candidate.recipeId === "100");
      assert.equal(outcome?.status, status, value);
      assert.equal(outcome?.codes.includes(code), true, value);
      assert.equal(outcome?.record?.source.wprmType, value === "food" ? "food" : (
        value === "howto"
          ? "howto"
          : value === "other" || value === "non-food"
            ? "other"
            : value.startsWith("a:")
              ? "malformed"
              : "unknown"
      ));
      if (value === "dessert" || value.startsWith("a:")) {
        assert.equal(
          outcome?.record === null || !JSON.stringify(outcome.record).includes(value),
          true
        );
      }
    }

    const missing = await runFixtureVariant(directory, [
      "  (61, 100, 'wprm_type', 'food'),\n"
    ].map((value) => [value, ""] as const));
    const missingOutcome = missing.outcomes.find((candidate) => candidate.recipeId === "100");
    assert.equal(missingOutcome?.status, "ready");
    assert.equal(missingOutcome?.record?.source.wprmType, "food");
    assert.equal(missingOutcome?.record?.source.wprmTypePresent, false);
  });
});

test("conflicting duplicate WPRM type rows remain reviewable with private provenance", async () => {
  await withDirectory(async (directory) => {
    const result = await runFixtureVariant(directory, [
      [
        "  (61, 100, 'wprm_type', 'food'),\n",
        "  (61, 100, 'wprm_type', 'howto'),\n  (65, 100, 'wprm_type', 'food'),\n"
      ]
    ]);
    const outcome = result.outcomes.find((candidate) => candidate.recipeId === "100");
    const metadata = result.snapshot.metadata.wprm.get("100");
    assert.equal(outcome?.status, "review");
    assert.equal(outcome?.codes.includes("duplicate-singular-meta"), true);
    assert.equal(metadata?.duplicateKeys.has("wprm_type"), true);
    assert.deepEqual(metadata?.wprmType, {
      present: true,
      raw: "howto",
      classification: "howto"
    });
    assert.equal(metadata?.excludedWprmType, 2);
    assert.equal(result.manifest.aggregate.nonLaunchFields.opaqueTypesExcluded, 2);
    assert.equal(result.manifest.privacy.rawValuesEmitted, false);
  });
});

test("identical duplicate WPRM type rows remain reviewable with accounting", async () => {
  await withDirectory(async (directory) => {
    const result = await runFixtureVariant(directory, [
      [
        "  (61, 100, 'wprm_type', 'food'),\n",
        "  (61, 100, 'wprm_type', 'food'),\n  (65, 100, 'wprm_type', 'food'),\n"
      ]
    ]);
    const outcome = result.outcomes.find((candidate) => candidate.recipeId === "100");
    const metadata = result.snapshot.metadata.wprm.get("100");
    assert.equal(outcome?.status, "review");
    assert.equal(outcome?.codes.includes("duplicate-singular-meta"), true);
    assert.equal(metadata?.duplicateKeys.has("wprm_type"), true);
    assert.deepEqual(metadata?.wprmType, {
      present: true,
      raw: "food",
      classification: "food"
    });
    assert.equal(metadata?.excludedWprmType, 2);
    assert.equal(result.manifest.aggregate.nonLaunchFields.opaqueTypesExcluded, 2);
    assert.equal(result.manifest.privacy.rawValuesEmitted, false);
  });
});

test("equipment preserves an explicit empty WPRM list", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "equipment.sql");
    const archive = path.join(directory, "uploads.zip");
    const keyFile = path.join(directory, "fingerprint.key");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        'a:1:{i:0;a:4:{s:2:"id";i:17;s:4:"name";s:17:"Fixture equipment";s:6:"amount";s:1:"1";s:5:"notes";s:0:"";}}',
        "a:0:{}"
      )
    );
    writeFileSync(archive, zipArchive(["uploads/2026/08/fixture.jpg"]));
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const result = await runWprmBulkImport({
      database,
      uploadArchives: [archive],
      fingerprintKeyFile: keyFile,
      dryRun: true
    });

    const ready = result.outcomes.find((outcome) => outcome.recipeId === "100");
    assert.deepEqual(ready?.record?.recipe.equipment, []);
  });
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
