import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  probeWordPressSourceEvidence,
  SourceEvidenceError,
  compareSourceEvidenceBaseline,
  normalizeBwgArchivePath,
  parseSourceEvidenceBaseline,
  serializeSourceEvidenceReport
} from "../scripts/wordpress/source-evidence";
import {
  inspectStructuredValue
} from "../scripts/wordpress/source-evidence-shape";

const fixture = path.resolve(
  process.cwd(),
  "test/fixtures/wordpress/source-evidence.sql"
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
    centralHeader.writeUInt16LE(0, 36);
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
  const directory = mkdtempSync(path.join(process.cwd(), ".source-evidence-test-"));
  return callback(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function redirectSql(actionData: string, matchData = "m") {
  const sqlValue = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    "CREATE TABLE `wp_posts` (`ID` bigint, `post_type` varchar(32), `post_parent` bigint, `post_content` text);",
    "INSERT INTO `wp_posts` (`ID`, `post_type`, `post_parent`, `post_content`) VALUES (1, 'post', 0, '');",
    "CREATE TABLE `wp_redirection_items` (`id` bigint, `url` text, `match_url` text, `regex` tinyint, `status` text, `match_type` text, `action_type` text, `action_code` text, `action_data` text, `match_data` text);",
    "INSERT INTO `wp_redirection_items` (`id`, `url`, `match_url`, `regex`, `status`, `match_type`, `action_type`, `action_code`, `action_data`, `match_data`) VALUES "
      + `(1, '/source/', '/source/', 0, 'enabled', 'url', 'url', '301', ${sqlValue(actionData)}, ${sqlValue(matchData)});`
  ].join("\n");
}

function deepInstructionSql(depth: number) {
  let nested = '{"image":"6"}';
  for (let index = 0; index < depth; index += 1) {
    nested = `{"nested":${nested}}`;
  }
  return [
    "CREATE TABLE `wp_posts` (`ID` bigint, `post_type` varchar(32), `post_parent` bigint, `post_content` text);",
    "INSERT INTO `wp_posts` (`ID`, `post_type`, `post_parent`, `post_content`) VALUES (1, 'wprm_recipe', 0, '');",
    "CREATE TABLE `wp_postmeta` (`meta_id` bigint, `post_id` bigint, `meta_key` text, `meta_value` text);",
    "INSERT INTO `wp_postmeta` (`meta_id`, `post_id`, `meta_key`, `meta_value`) VALUES "
      + `(1, 1, 'wprm_instructions', '[${nested}]');`
  ].join("\n");
}

async function probe(
  database: string,
  uploadArchives: readonly string[] = [],
  limits?: Parameters<typeof probeWordPressSourceEvidence>[0]["limits"]
) {
  return probeWordPressSourceEvidence({ database, uploadArchives, limits });
}

test("source evidence is deterministic across reversed upload arguments", async () => {
  await withDirectory(async (directory) => {
    const first = path.join(directory, "a.zip");
    const second = path.join(directory, "b.zip");
    writeFileSync(first, zipArchive(["uploads/2026/08/hero.jpg"]));
    writeFileSync(second, zipArchive(["uploads/2026/08/step.jpg"]));

    const forward = await probe(fixture, [first, second]);
    const reverse = await probe(fixture, [second, first]);
    assert.deepEqual(forward, reverse);

    const renamed = path.join(directory, "renamed.zip");
    writeFileSync(renamed, zipArchive(["uploads/2026/08/unrelated-b.jpg"]));
    const structuralBase = path.join(directory, "structural-base.zip");
    writeFileSync(structuralBase, zipArchive(["uploads/2026/08/unrelated-a.jpg"]));
    const renamedReport = await probe(fixture, [renamed]);
    const structuralReport = await probe(fixture, [structuralBase]);
    assert.notEqual(
      renamedReport.contracts.uploadIndexContractSha256,
      structuralReport.contracts.uploadIndexContractSha256
    );
    assert.notEqual(
      renamedReport.contracts.reportStructuralSha256,
      structuralReport.contracts.reportStructuralSha256
    );
    assert.equal(
      JSON.stringify(renamedReport).includes("unrelated-b.jpg"),
      false
    );
    assert.equal(JSON.stringify(renamedReport).includes(renamed), false);
  });
});

test("the probe emits only whole-input hashes and safe aggregates", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "source.sql.gz");
    writeFileSync(database, gzipSync(readFileSync(fixture)));
    const report = await probe(database);
    const changedDatabase = path.join(directory, "changed.sql");
    writeFileSync(
      changedDatabase,
      readFileSync(fixture, "utf8").replace("Translation page", "Changed page")
    );
    const changed = await probe(changedDatabase);
    const serialized = JSON.stringify(report);
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.contracts.probe, "wordpress-source-evidence-v3");
    assert.equal(report.source.database.format, "gzip");
    assert.notEqual(
      report.contracts.sqlDecompressedSha256,
      changed.contracts.sqlDecompressedSha256
    );
    assert.match(report.contracts.sqlDecompressedSha256, /^[a-f0-9]{64}$/u);
    assert.match(report.contracts.uploadIndexContractSha256, /^[a-f0-9]{64}$/u);
    assert.match(report.contracts.reportStructuralSha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.privacy.individualValueHashesEmitted, 0);
    for (const sentinel of [
      "sentinel",
      "email@example.invalid",
      "hero.jpg",
      "https://sentinel.invalid",
      "mysteryNested",
      "unknownStep"
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }
  });
});

test("WPRM and WPUR structures remain separate and unknown keys are anonymous", async () => {
  const report = await probe(fixture);
  assert.equal(report.evidence.wprm.recipePostRecords, 2);
  assert.equal(report.evidence.wprm.ingredients.encoding.json, 1);
  assert.equal(report.evidence.wprm.ingredients.encoding["php-serialized"], 1);
  assert.equal(report.evidence.wpur.recipePostRecords, 1);
  assert.equal(report.evidence.wpur.metadataSignalPosts, 1);
  assert.equal(report.evidence.wpur.ingredients.encoding.json, 1);
  assert.equal(
    report.evidence.wprm.ingredients.itemKeySets[0]?.keys.includes("unknown"),
    true
  );
  assert.equal(
    report.evidence.wprm.ingredients.itemKeySets[0]?.keys.includes("mysteryNested"),
    false
  );
});

test("redirect graph state retains only bounded safe counters", async () => {
  const report = await probe(fixture);
  const redirectEvidence = JSON.stringify(report.evidence.redirects);
  assert.equal(Object.prototype.hasOwnProperty.call(report.evidence.redirects, "rows"), false);
  for (const sentinel of [
    "sentinel.invalid",
    "old-recipe",
    "new-recipe",
    "missing-target"
  ]) {
    assert.equal(redirectEvidence.includes(sentinel), false, sentinel);
  }
});

test("redirect action and match values enforce exact byte boundaries", async () => {
  await withDirectory(async (directory) => {
    const actionData = "/target/";
    const exactPath = path.join(directory, "exact.sql");
    writeFileSync(exactPath, redirectSql(actionData, "m"));
    const exact = await probe(exactPath, [], {
      maxMetaValueBytes: Buffer.byteLength(actionData, "utf8")
    });
    assert.equal(exact.evidence.redirects.records, 1);

    const actionOverLimitPath = path.join(directory, "action-over.sql");
    writeFileSync(actionOverLimitPath, redirectSql(`${actionData}x`, "m"));
    await assert.rejects(
      probe(actionOverLimitPath, [], { maxMetaValueBytes: Buffer.byteLength(actionData, "utf8") }),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "meta-value-limit"
    );

    const matchOverLimitPath = path.join(directory, "match-over.sql");
    writeFileSync(matchOverLimitPath, redirectSql(actionData, "match-too-long"));
    await assert.rejects(
      probe(matchOverLimitPath, [], { maxMetaValueBytes: 4 }),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "meta-value-limit"
    );
  });
});

test("redirect JSON limits fail before target extraction", async () => {
  await withDirectory(async (directory) => {
    let deep = '"value"';
    for (let index = 0; index < 256; index += 1) {
      deep = `{"nested":${deep}}`;
    }
    const deepPath = path.join(directory, "deep.sql");
    writeFileSync(deepPath, redirectSql(deep));
    await assert.rejects(
      probe(deepPath, [], { maxSerializedDepth: 8 }),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "serialized-limit"
    );

    const entries = JSON.stringify({ nested: Array.from({ length: 64 }, () => 0) });
    const entriesPath = path.join(directory, "entries.sql");
    writeFileSync(entriesPath, redirectSql(entries));
    await assert.rejects(
      probe(entriesPath, [], { maxSerializedEntries: 8 }),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "serialized-limit"
    );
  });
});

test("BWG path normalization is strict and root-specific", () => {
  assert.deepEqual(normalizeBwgArchivePath("imported/image.jpg"), {
    kind: "relative-to-bwg-root",
    archivePath: "photo-gallery/imported/image.jpg"
  });
  assert.deepEqual(normalizeBwgArchivePath("/imported/image.jpg"), {
    kind: "single-leading-bwg-relative",
    archivePath: "photo-gallery/imported/image.jpg"
  });
  assert.deepEqual(normalizeBwgArchivePath("photo-gallery/imported/image.jpg"), {
    kind: "already-archive-relative",
    archivePath: "photo-gallery/imported/image.jpg"
  });
  assert.deepEqual(normalizeBwgArchivePath("/wp-content/uploads/photo-gallery/imported/image.jpg"), {
    kind: "wordpress-root-relative",
    archivePath: "photo-gallery/imported/image.jpg"
  });
  assert.deepEqual(normalizeBwgArchivePath("/wp-content/uploads/other-root/image.jpg"), {
    kind: "unsupported",
    archivePath: null
  });
  assert.deepEqual(normalizeBwgArchivePath("/wp-content/plugins/image.jpg"), {
    kind: "unsupported",
    archivePath: null
  });
  assert.equal(normalizeBwgArchivePath("//other-host/image.jpg").kind, "external");
  assert.equal(normalizeBwgArchivePath("/uploads/other-root/image.jpg").kind, "unsupported");
  assert.equal(normalizeBwgArchivePath("https://example.invalid/image.jpg").kind, "external");
  assert.equal(normalizeBwgArchivePath("../image.jpg").kind, "unsafe");
  assert.equal(normalizeBwgArchivePath("%2e%2e/image.jpg").kind, "unsafe");
  assert.equal(normalizeBwgArchivePath("%252e%252e/image.jpg").kind, "unsafe");
  assert.equal(normalizeBwgArchivePath("image%2f.jpg").kind, "unsafe");
  assert.equal(normalizeBwgArchivePath("image.jpg?x=1").kind, "unsafe");
  assert.equal(normalizeBwgArchivePath("image.jpg#fragment").kind, "unsafe");
  assert.equal(normalizeBwgArchivePath(null).kind, "empty");
});

test("unrelated WordPress-root paths cannot match BWG archive entries", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "unrelated-root.sql");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        "/imported_from_media_libray/hero.jpg",
        "/wp-content/uploads/other-root/image.jpg"
      )
    );
    const archive = path.join(directory, "other-root.zip");
    writeFileSync(
      archive,
      zipArchive(["uploads/photo-gallery/other-root/image.jpg"])
    );
    const report = await probe(database, [archive]);
    assert.equal(
      report.evidence.galleries.imagePathCoverage.bwgRootNormalized.imageMatched,
      0
    );
  });
});

test("step image traversal honors configured depth and entry bounds iteratively", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "deep-step.sql");
    writeFileSync(database, deepInstructionSql(70));
    const accepted = await probe(database, [], {
      maxSerializedDepth: 128,
      maxSerializedEntries: 1_000
    });
    assert.equal(accepted.evidence.media.stepReferences, 1);

    await assert.rejects(
      probe(database, [], { maxSerializedDepth: 64 }),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "serialized-limit"
    );
    await assert.rejects(
      probe(database, [], { maxSerializedEntries: 1 }),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "serialized-limit"
    );
  });
});

test("the probe reconciles Polylang, media, redirects, and galleries as counts", async () => {
  await withDirectory(async (directory) => {
    const archive = path.join(directory, "uploads.zip");
    writeFileSync(
      archive,
      zipArchive([
        "uploads/2026/08/hero.jpg",
        "uploads/2026/08/hero-100x100.jpg",
        "uploads/2026/08/step.jpg",
        "uploads/photo-gallery/imported_from_media_libray/hero.jpg",
        "uploads/photo-gallery/imported_from_media_libray/thumb/hero.jpg"
      ])
    );
    const report = await probe(fixture, [archive]);
    assert.equal(report.evidence.polylang.posts.translationGroups, 2);
    assert.equal(report.evidence.polylang.terms.emptyGroups, 1);
    assert.equal(report.evidence.polylang.terms.mixedTaxonomyGroups, 1);
    assert.equal(report.evidence.polylang.recipeEditorialAlignment.parent.oneToOne, 1);
    assert.equal(report.evidence.media.attachmentRecords, 3);
    assert.equal(report.evidence.media.archiveCoverage.matched, 2);
    assert.equal(report.evidence.media.altPresent, 1);
    assert.equal(report.evidence.redirects.records, 5);
    assert.equal(report.evidence.redirects.targetEncoding.json, 1);
    assert.equal(report.evidence.redirects.targetEncoding.malformed, 1);
    assert.equal(report.evidence.galleries.albumRelations.toGallery, 1);
    assert.equal(report.evidence.galleries.albumRelations.toAlbum, 1);
    assert.equal(report.evidence.galleries.albumRelations.malformed, 1);
    assert.deepEqual(report.evidence.galleries.imagePathCoverage.currentGeneric, {
      imageMatched: 0,
      imageMissing: 3,
      thumbMatched: 0,
      thumbMissing: 3
    });
    assert.deepEqual(report.evidence.galleries.imagePathCoverage.bwgRootNormalized, {
      imageMatched: 1,
      imageMissing: 2,
      thumbMatched: 1,
      thumbMissing: 2
    });
    assert.equal(report.evidence.galleries.imagePathCoverage.thumbValuesPresent, 2);
  });
});

test("sanitized baselines reconcile only named aggregate metrics", async () => {
  const report = await probe(fixture);
  const baseline = parseSourceEvidenceBaseline({
    kind: "wordpress-source-inventory",
    schemaVersion: 3,
    posts: {
      pages: { count: 2 },
      byType: [{ postType: "post", count: 1 }]
    },
    recipes: {
      wprm: { postRecords: 2 },
      ultimateRecipe: { metadataSignalPosts: [0] }
    },
    locales: {
      posts: { translationGroups: [0, 0] },
      terms: { translationGroups: [0, 0] }
    },
    redirects: {
      redirectionItems: 5,
      oldSlugMetadata: 87
    },
    media: {
      archive: { matchedAttachedFiles: 0 }
    },
    galleries: {
      bwg: { images: 3 }
    }
  });
  const reconciliation = compareSourceEvidenceBaseline(report, baseline);
  assert.equal(reconciliation.passed, true);
  assert.equal(reconciliation.comparisons.length, 9);
  assert.deepEqual(reconciliation.informational, {
    legacyOldSlugRecords: { expected: 87, status: "not-probed" }
  });
  const cloned = JSON.parse(serializeSourceEvidenceReport(report));
  assert.deepEqual(
    compareSourceEvidenceBaseline(cloned, baseline),
    reconciliation
  );
});

test("baseline parsing rejects flat, empty, and wrong-version inputs", () => {
  for (const input of [
    {},
    { metrics: { posts: 1 } },
    { kind: "wordpress-source-inventory", schemaVersion: 2 }
  ]) {
    assert.throws(
      () => parseSourceEvidenceBaseline(input),
      (error: unknown) =>
        error instanceof SourceEvidenceError && error.code === "invalid-baseline"
    );
  }
});

test("CLI baseline parsing accepts the documented source inventory shape", async () => {
  await withDirectory(async (directory) => {
    const baselinePath = path.join(directory, "baseline.json");
    const outputPath = path.join(directory, "evidence.json");
    writeFileSync(baselinePath, JSON.stringify({
      kind: "wordpress-source-inventory",
      schemaVersion: 3,
      posts: {
        pages: { count: 2 },
        byType: [{ postType: "post", count: 1 }]
      },
      recipes: {
        wprm: { postRecords: 2 },
        ultimateRecipe: { metadataSignalPosts: [0] }
      },
      locales: {
        posts: { translationGroups: [0, 0] },
        terms: { translationGroups: [0, 0] }
      },
      redirects: { redirectionItems: 5, oldSlugMetadata: 87 },
      media: { archive: { matchedAttachedFiles: 0 } },
      galleries: { bwg: { images: 3 } }
    }));
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "scripts/inventory-wordpress-source-evidence.ts",
        "--database",
        fixture,
        "--baseline",
        baselinePath,
        "--write",
        "--output",
        outputPath,
        "--overwrite"
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).kind, "wordpress-source-evidence");
    assert.equal(
      JSON.parse(readFileSync(outputPath, "utf8"))
        .reconciliation.informational.legacyOldSlugRecords.expected,
      87
    );
  });
});

test("structured inspection reports malformed and bounded values without returning them", () => {
  const limits = {
    maxMetaValueBytes: 1024,
    maxSerializedDepth: 8,
    maxSerializedEntries: 8,
    maxShapeKeySets: 8
  };
  const malformed = inspectStructuredValue("a:1:{", {
    root: "array",
    allowedGroupKeys: ["ingredients"],
    allowedItemKeys: ["name"]
  }, limits);
  assert.equal(malformed.encoding["malformed-php"], 1);
  assert.equal(JSON.stringify(malformed).includes("a:1"), false);

  const limited = inspectStructuredValue("x".repeat(2_000), {
    root: "array",
    allowedGroupKeys: [],
    allowedItemKeys: ["name"]
  }, { ...limits, maxMetaValueBytes: 10 });
  assert.equal(limited.encoding["limit-exceeded"], 1);

  let deep = "0";
  for (let index = 0; index < 256; index += 1) {
    deep = `[${deep}]`;
  }
  const deepEvidence = inspectStructuredValue(deep, {
    root: "array",
    allowedGroupKeys: [],
    allowedItemKeys: ["name"]
  }, limits);
  assert.equal(deepEvidence.encoding["limit-exceeded"], 1);
  assert.equal(deepEvidence.encoding["malformed-json"], 0);

  const entryEvidence = inspectStructuredValue(
    JSON.stringify(Array.from({ length: 20 }, () => ({ name: "x" }))),
    {
      root: "array",
      allowedGroupKeys: [],
      allowedItemKeys: ["name"]
    },
    limits
  );
  assert.equal(entryEvidence.encoding["limit-exceeded"], 1);
  assert.equal(entryEvidence.encoding["malformed-json"], 0);

  const scalarEvidence = inspectStructuredValue('s:3:"abc";', {
    root: "array",
    allowedGroupKeys: [],
    allowedItemKeys: ["name"]
  }, limits);
  assert.equal(scalarEvidence.rootKinds.scalar, 1);
  assert.equal(scalarEvidence.malformed, 1);

  const wrongRootEvidence = inspectStructuredValue('{"name":"x"}', {
    root: "array",
    allowedGroupKeys: [],
    allowedItemKeys: ["name"]
  }, limits);
  assert.equal(wrongRootEvidence.rootKinds.object, 1);
  assert.equal(wrongRootEvidence.malformed, 1);

  const validObjectEvidence = inspectStructuredValue('{"name":"x"}', {
    root: "object",
    allowedGroupKeys: [],
    allowedItemKeys: ["name"]
  }, limits);
  assert.equal(validObjectEvidence.rootKinds.object, 1);
  assert.equal(validObjectEvidence.malformed, 0);
});

test("configured source evidence limits fail with coded errors", async () => {
  await assert.rejects(
    probe(fixture, [], { maxPosts: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "post-limit"
  );
  await assert.rejects(
    probe(fixture, [], { maxPostMetaRows: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "postmeta-row-limit"
  );
  await assert.rejects(
    probe(fixture, [], { maxTermRelationships: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "term-relationship-limit"
  );
  await assert.rejects(
    probe(fixture, [], { maxRecipeCandidates: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "recipe-candidate-limit"
  );
  await assert.rejects(
    probe(fixture, [], { maxEvidenceReferences: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "evidence-reference-limit"
  );
  await assert.rejects(
    probe(fixture, [], { maxPostContentBytes: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "post-content-scan-limit"
  );
  await assert.rejects(
    probe(fixture, [], { maxMetaValueBytes: 1 }),
    (error: unknown) =>
      error instanceof SourceEvidenceError && error.code === "meta-value-limit"
  );
});
