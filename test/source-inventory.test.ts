import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  inventoryWordPressSource,
  runWordPressSourceInventory
} from "../scripts/wordpress/source-inventory";
import { inventoryUploadArchives } from "../scripts/wordpress/uploads-inventory";

const fixture = path.resolve(
  process.cwd(),
  "test/fixtures/wordpress/source-inventory.sql"
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

function zip64Archive(options: {
  readonly zip64DiskNumber?: number;
  readonly zip64CentralDirectoryDisk?: number;
  readonly zip64EntriesOnDisk?: number;
  readonly zip64RecordSize?: bigint;
  readonly truncateZip64Record?: boolean;
  readonly locatorDiskNumber?: number;
  readonly locatorTotalDisks?: number;
} = {}) {
  const normal = zipArchive(["uploads/2026/08/a.jpg"]);
  const endOffset = normal.length - 22;
  const centralSize = normal.readUInt32LE(endOffset + 12);
  const centralOffset = normal.readUInt32LE(endOffset + 16);
  const zip64Offset = endOffset;
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(options.zip64RecordSize ?? 44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeUInt32LE(options.zip64DiskNumber ?? 0, 16);
  zip64.writeUInt32LE(options.zip64CentralDirectoryDisk ?? 0, 20);
  zip64.writeBigUInt64LE(BigInt(options.zip64EntriesOnDisk ?? 1), 24);
  zip64.writeBigUInt64LE(1n, 32);
  zip64.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(options.locatorDiskNumber ?? 0, 4);
  locator.writeBigUInt64LE(BigInt(zip64Offset), 8);
  locator.writeUInt32LE(options.locatorTotalDisks ?? 1, 16);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 4);
  end.writeUInt16LE(0xffff, 6);
  end.writeUInt16LE(0xffff, 8);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  const zip64Record = options.truncateZip64Record
    ? zip64.subarray(0, zip64.length - 1)
    : zip64;
  return Buffer.concat([
    normal.subarray(0, endOffset),
    zip64Record,
    locator,
    end
  ]);
}

function withDirectory<T>(callback: (directory: string) => Promise<T>) {
  const directory = mkdtempSync(path.join(process.cwd(), ".source-inventory-test-"));
  return callback(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

test("inventories gzip SQL and uploads without emitting source values", async () => {
  await withDirectory(async (directory) => {
    const gzipPath = path.join(directory, "source.sql.gz");
    const archivePath = path.join(directory, "uploads.zip");
    writeFileSync(gzipPath, gzipSync(readFileSync(fixture)));
    writeFileSync(
      archivePath,
      zipArchive([
        "uploads/2026/08/photo.jpg",
        "uploads/2026/08/unreferenced.png",
        "uploads/2026/08/unreferenced-100x100.png"
      ])
    );

    const output = await inventoryWordPressSource({
      database: gzipPath,
      uploadArchives: [archivePath]
    });

    assert.equal(output.source.databaseFormat, "gzip");
    assert.equal(output.source.databaseTables, 15);
    assert.deepEqual(output.source.relevantSqlTables.posts, {
      insertStatements: 1,
      rows: 4
    });
    assert.deepEqual(output.source.relevantSqlTables.postmeta, {
      insertStatements: 1,
      rows: 6
    });
    assert.equal(output.posts.total, 4);
    assert.deepEqual(output.posts.pages.ids, ["1"]);
    assert.equal(output.recipes.wprm.postRecords, 1);
    assert.equal(output.recipes.ultimateRecipe.candidatePostRecords, 1);
    assert.equal(output.schemaVersion, 3);
    assert.deepEqual(output.locales.posts.languageTermIds, {
      en: ["10"],
      fr: ["11"],
      ru: ["12"]
    });
    assert.deepEqual(output.locales.posts.counts, { en: 1, fr: 1, ru: 1 });
    assert.deepEqual(output.locales.posts.links, [
      { postId: "1", locale: "en" },
      { postId: "2", locale: "fr" },
      { postId: "3", locale: "ru" }
    ]);
    assert.deepEqual(output.locales.posts.translationGroups, [
      { groupId: "23", postIds: ["2", "3"] }
    ]);
    assert.equal(output.locales.posts.emptyTranslationGroups, 0);
    assert.equal(output.locales.posts.translationEdges, 1);
    assert.deepEqual(output.locales.terms.termLanguageTermIds, {
      en: ["14"],
      fr: ["15"],
      ru: ["16"]
    });
    assert.deepEqual(output.locales.terms.counts, { en: 1, fr: 1, ru: 0 });
    assert.deepEqual(output.locales.terms.links, [
      { termId: "13", locale: "en" },
      { termId: "19", locale: "fr" }
    ]);
    assert.deepEqual(output.locales.terms.translationGroups, [
      { groupId: "30", termIds: ["13", "19"] },
      { groupId: "31", termIds: [] }
    ]);
    assert.equal(output.locales.terms.emptyTranslationGroups, 1);
    assert.equal(output.locales.terms.translationEdges, 1);
    assert.equal(output.locales.unsupportedLanguageTerms, 1);
    assert.equal(
      output.issues.find((issue) => issue.code === "unsupported-language-term")?.count,
      1
    );
    assert.equal(
      output.issues.find((issue) => issue.code === "empty-term-translation-group")?.count,
      1
    );
    assert.equal(
      output.issues.some((issue) => issue.code === "non-locale-term"),
      false
    );
    assert.equal(output.redirects.totalRecords, 2);
    assert.deepEqual(output.galleries.bwg.albumGalleryRelationships, [
      { albumId: "703", galleryId: "701" }
    ]);
    assert.deepEqual(output.galleries.bwg.albumAlbumRelationships, [
      { albumId: "703", childAlbumId: "704" }
    ]);
    assert.equal(
      output.issues.find((issue) => issue.code === "malformed-bwg-album-gallery-relation")?.count,
      1
    );
    assert.deepEqual(output.galleries.shortcodeReferences, {
      count: 3,
      ids: ["701", "801", "802"],
      singularIds: ["701"],
      listIds: ["801", "802"],
      singularReferences: 1,
      listReferences: 2,
      malformedReferences: 1
    });
    assert.equal(
      output.issues.find((issue) => issue.code === "malformed-gallery-reference")?.count,
      1
    );
    assert.equal(output.media.archive.matchedAttachedFiles, 1);
    assert.equal(output.media.archive.unreferencedUploadFiles, 2);
    assert.equal(output.media.archive.generatedDerivativeFiles, 1);
    assert.equal(output.privacy.rawValuesEmitted, false);
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes("Plain page"), false);
    assert.equal(serialized.includes("old-page"), false);
    assert.equal(serialized.includes("photo.jpg"), false);
    assert.equal(serialized.includes("dessert-fr"), false);
    assert.equal(serialized.includes("post-group"), false);
    assert.equal(serialized.includes("orphan-term-group"), false);
  });
});

test("upload archive summaries are deterministic and reject unsafe limits", async () => {
  await withDirectory(async (directory) => {
    const first = path.join(directory, "a.zip");
    const second = path.join(directory, "b.zip");
    writeFileSync(first, zipArchive(["uploads/2026/08/a.jpg", "../unsafe.txt"]));
    writeFileSync(second, zipArchive(["uploads/2026/08/a.jpg"]));

    const forward = await inventoryUploadArchives([second, first]);
    const reverse = await inventoryUploadArchives([first, second]);
    assert.deepEqual(forward.summaries, reverse.summaries);
    assert.equal(forward.summaries[0]?.invalidEntries, 1);
    assert.equal(forward.uploadPathCounts.get("2026/08/a.jpg"), 2);
    await assert.rejects(
      inventoryUploadArchives([first], { maxEntriesPerArchive: 1 }),
      /too many entries/
    );
  });
});

test("upload inventory rejects multi-disk regular and ZIP64 archives", async () => {
  await withDirectory(async (directory) => {
    const regularEndOffset = zipArchive(["uploads/one.jpg"]).length - 22;
    for (const fieldOffset of [4, 6]) {
      const archive = zipArchive(["uploads/one.jpg"]);
      archive.writeUInt16LE(1, regularEndOffset + fieldOffset);
      const archivePath = path.join(directory, `regular-${fieldOffset}.zip`);
      writeFileSync(archivePath, archive);
      await assert.rejects(
        inventoryUploadArchives([archivePath]),
        /Multi-disk ZIP/
      );
    }

    const zip64Options = [
      { zip64DiskNumber: 1 },
      { zip64CentralDirectoryDisk: 1 },
      { zip64EntriesOnDisk: 0 },
      { locatorDiskNumber: 1 },
      { locatorTotalDisks: 2 }
    ] as const;
    for (const [index, options] of zip64Options.entries()) {
      const archivePath = path.join(directory, `zip64-${index}.zip`);
      writeFileSync(archivePath, zip64Archive(options));
      await assert.rejects(
        inventoryUploadArchives([archivePath]),
        /Multi-disk ZIP/
      );
    }
  });
});

test("upload inventory resolves ZIP64 disk sentinels only with valid metadata", async () => {
  await withDirectory(async (directory) => {
    const regularEndOffset = zipArchive(["uploads/one.jpg"]).length - 22;
    for (const [index, fieldOffset] of [4, 6].entries()) {
      const archive = zipArchive(["uploads/one.jpg"]);
      archive.writeUInt16LE(0xffff, regularEndOffset + fieldOffset);
      const archivePath = path.join(directory, `missing-zip64-${index}.zip`);
      writeFileSync(archivePath, archive);
      await assert.rejects(
        inventoryUploadArchives([archivePath]),
        /ZIP64 locator/
      );
    }

    const validArchivePath = path.join(directory, "valid-zip64.zip");
    writeFileSync(validArchivePath, zip64Archive());
    const inventory = await inventoryUploadArchives([validArchivePath]);
    assert.equal(inventory.summaries[0]?.entries, 1);
  });
});

test("upload inventory validates ZIP64 EOCD record sizes and boundaries", async () => {
  await withDirectory(async (directory) => {
    const cases = [
      {
        name: "too-small",
        options: { zip64RecordSize: 43n },
        message: /ZIP64 directory record/
      },
      {
        name: "inconsistent",
        options: { zip64RecordSize: 45n },
        message: /ZIP64 directory record/
      },
      {
        name: "unsafe",
        options: { zip64RecordSize: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
        message: /safe integer/
      },
      {
        name: "truncated",
        options: { truncateZip64Record: true },
        message: /ZIP64 directory record/
      }
    ] as const;
    for (const testCase of cases) {
      const archivePath = path.join(directory, `${testCase.name}.zip`);
      writeFileSync(archivePath, zip64Archive(testCase.options));
      await assert.rejects(
        inventoryUploadArchives([archivePath]),
        testCase.message
      );
    }
  });
});

test("CLI maps --max-total-entries to the upload safety limit", async () => {
  await withDirectory(async (directory) => {
    const archivePath = path.join(directory, "uploads.zip");
    writeFileSync(
      archivePath,
      zipArchive(["uploads/one.jpg", "uploads/two.jpg"])
    );
    await assert.rejects(
      runWordPressSourceInventory([
        "--database",
        fixture,
        "--uploads",
        archivePath,
        "--max-total-entries",
        "1"
      ]),
      /total entry limit/
    );
  });
});

test("source inventory reports malformed SQL instead of omitting rows", async () => {
  await withDirectory(async (directory) => {
    const malformed = path.join(directory, "malformed.sql");
    writeFileSync(
      malformed,
      [
        "CREATE TABLE `wp_posts` (`ID` bigint NOT NULL, `post_type` varchar(20) NOT NULL);",
        "INSERT INTO `wp_posts` (`ID`, `post_type`) VALUES (1);"
      ].join("\n")
    );
    await assert.rejects(
      inventoryWordPressSource({ database: malformed }),
      /wrong number of values/
    );
  });
});
