import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { decodeRecipeSlug } from "../src/content/url-path";
import {
  runEditorialImportCli
} from "../scripts/import-wordpress-editorial";
import {
  runEditorialImport,
  serializeEditorialManifest
} from "../scripts/wordpress/editorial-import-runner";
import { runWprmBulkImport } from "../scripts/wordpress/wprm-import-runner";
import { normalizeBwgArchivePath } from "../scripts/wordpress/source-evidence";
import { repositoryRoot } from "../scripts/wordpress/wprm-import-stage";

const fixture = path.resolve(process.cwd(), "test/fixtures/wordpress/editorial.sql");
const wprmFixture = path.resolve(process.cwd(), "test/fixtures/wordpress/wprm-bulk.sql");

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
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
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
  const directory = mkdtempSync(path.join(process.cwd(), ".editorial-import-test-"));
  return callback(directory).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

function stagingTreeSnapshot(root: string) {
  const walk = (current: string, relative: string): string[] => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    return entries.flatMap((entry) => {
      const target = path.join(current, entry.name);
      const targetRelative = path.join(relative, entry.name);
      const stats = lstatSync(target);
      if (entry.isDirectory()) {
        return [
          `directory:${targetRelative}:${stats.mode & 0o777}`,
          ...walk(target, targetRelative)
        ];
      }
      return [
        `file:${targetRelative}:${stats.mode & 0o777}:${readFileSync(target).toString("hex")}`
      ];
    });
  };
  return walk(root, ".").join("\n");
}

function fixtureOptions(directory: string, database = fixture) {
  const archive = path.join(directory, "uploads.zip");
  const key = path.join(directory, "fingerprint.key");
  writeFileSync(
    archive,
    zipArchive([
      "uploads/2026/01/photo.jpg",
      "uploads/photo-gallery/album/original.jpg",
      "uploads/photo-gallery/album/thumb.jpg"
    ])
  );
  writeFileSync(key, randomBytes(32), { mode: 0o600 });
  chmodSync(key, 0o600);
  return {
    database,
    uploadArchives: [archive],
    fingerprintKeyFile: key,
    dryRun: true
  } as const;
}

test("editorial extraction is deterministic and preserves partial and ungrouped translations", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    const first = await runEditorialImport(options);
    const second = await runEditorialImport(options);

    assert.deepEqual(second.manifest, first.manifest);
    assert.equal(first.manifest.pages.total, 4);
    assert.deepEqual(first.manifest.pages.status, {
      ready: 1,
      review: 2,
      "publication-excluded": 1
    });
    assert.deepEqual(first.manifest.pages.locales, {
      en: 3,
      fr: 1,
      ru: 0,
      unlocalized: 0
    });
    assert.deepEqual(first.manifest.pages.translation, {
      groups: 1,
      completeTriples: 0,
      enFrPairs: 1,
      ungrouped: 2
    });
    const partial = first.outcomes.find((outcome) => outcome.sourceId === "2");
    const ungrouped = first.outcomes.find((outcome) => outcome.sourceId === "3");
    const privatePage = first.outcomes.find((outcome) => outcome.sourceId === "4");
    assert.equal(partial?.record.sourcePath, "/fr/à-propos/");
    assert.equal(partial?.record.translationGroupId, "100");
    assert.equal(ungrouped?.record.translationGroupId, null);
    assert.equal(ungrouped?.status, "ready");
    assert.equal(privatePage?.status, "publication-excluded");
    assert.equal(privatePage?.publication, "publication-excluded");
    assert.equal(first.snapshot.graph.terms.get("1")?.name, "Test English Locale");
    assert.equal(first.snapshot.options.wpTilesPagination, "ajax");
  });
});

test("page_for_posts is a source-backed archive disposition, not a publishable editorial page", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "page-for-posts.sql");
    writeFileSync(
      database,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_options\` (\`option_id\`, \`option_name\`, \`option_value\`) VALUES
  (5, 'page_for_posts', '3');
`,
      { mode: 0o600 }
    );
    const result = await runEditorialImport(fixtureOptions(directory, database));
    const archive = result.outcomes.find((outcome) => outcome.sourceId === "3");

    assert.equal(result.snapshot.options.pageForPosts, "3");
    assert.equal(archive?.record.publicationDisposition, "posts-archive");
    assert.equal(archive?.publication, "publication-excluded");
    assert.equal(archive?.status, "publication-excluded");
    assert.deepEqual(archive?.issueCodes, ["page-for-posts-archive"]);
    assert.deepEqual(result.manifest.pages.status, {
      ready: 0,
      review: 2,
      "publication-excluded": 2
    });
    assert.equal(
      result.manifest.pages.outcomes.find((outcome) =>
        outcome.publicationDisposition === "posts-archive"
      )?.status,
      "publication-excluded"
    );
  });
});

test("page_for_posts source options reject malformed and unresolved designations", async () => {
  await withDirectory(async (directory) => {
    for (const [name, value, code] of [
      ["malformed", "not-a-page", "invalid-page-for-posts-option"],
      ["unresolved", "999", "unresolved-page-for-posts"],
      ["nonpage", "10", "page-for-posts-not-page"]
    ] as const) {
      const database = path.join(directory, `${name}-page-for-posts.sql`);
      writeFileSync(
        database,
        `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_options\` (\`option_id\`, \`option_name\`, \`option_value\`) VALUES
  (5, 'page_for_posts', '${value}');
`,
        { mode: 0o600 }
      );
      await assert.rejects(
        runEditorialImport(fixtureOptions(directory, database)),
        (error: unknown) =>
          error instanceof Error
          && "code" in error
          && error.code === code
      );
    }
  });
});

test("WP Tiles global pagination is authenticated and rejects malformed or unsupported values", async () => {
  await withDirectory(async (directory) => {
    const validOption = 'a:2:{s:12:"default_grid";s:7:"Default";s:10:"pagination";s:4:"ajax";}';
    for (const [name, replacement, code] of [
      [
        "malformed",
        'a:2:{s:12:"default_grid";s:7:"Default";s:10:"pagination";i:1;}',
        "invalid-wp-tiles-pagination-option"
      ],
      [
        "unsupported",
        'a:2:{s:12:"default_grid";s:7:"Default";s:10:"pagination";s:6:"paging";}',
        "unsupported-wp-tiles-pagination-option"
      ]
    ] as const) {
      const database = path.join(directory, `${name}-wp-tiles.sql`);
      writeFileSync(
        database,
        readFileSync(fixture, "utf8").replace(validOption, replacement),
        { mode: 0o600 }
      );
      await assert.rejects(
        runEditorialImport(fixtureOptions(directory, database)),
        (error: unknown) =>
          error instanceof Error
          && "code" in error
          && error.code === code
      );
    }
    const oversized = "a".repeat(4_097);
    const oversizedDatabase = path.join(directory, "oversized-wp-tiles.sql");
    writeFileSync(
      oversizedDatabase,
      readFileSync(fixture, "utf8").replace(
        validOption,
        `a:2:{s:12:"default_grid";s:7:"Default";s:10:"pagination";s:${oversized.length}:"${oversized}";}`
      ),
      { mode: 0o600 }
    );
    await assert.rejects(
      runEditorialImport(fixtureOptions(directory, oversizedDatabase)),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && error.code === "invalid-wp-tiles-pagination-option"
    );
  });
});

test("editorial mapping classifies unsupported source structures without stripping source", async () => {
  await withDirectory(async (directory) => {
    const result = await runEditorialImport(fixtureOptions(directory));
    const tiles = result.outcomes.find((outcome) => outcome.sourceId === "1");
    const form = result.outcomes.find((outcome) => outcome.sourceId === "2");

    assert.deepEqual(tiles?.issueCodes, [
      "unsupported-block",
      "unsupported-wp-tiles"
    ]);
    assert.deepEqual(form?.issueCodes, ["unsupported-contact-form-7"]);
    assert.equal(tiles?.record.source.body?.includes("Source wording"), true);
    assert.equal(tiles?.record.structure.model, "lossless-wordpress-html-v2");
    assert.equal(tiles?.record.structure.shortcodeCounts[0]?.name, "wp-tiles");
  });
});

test("editorial media and BWG assets require archive-backed safe paths", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    const galleryDatabase = path.join(directory, "gallery.sql");
    writeFileSync(
      galleryDatabase,
      readFileSync(fixture, "utf8").replace(
        "<p>Ungrouped source wording</p>",
        "[bwg id=\"300\"]<p>Ungrouped source wording</p>"
      )
    );
    const galleryOptions = fixtureOptions(directory, galleryDatabase);
    const result = await runEditorialImport(galleryOptions);

    assert.deepEqual(result.manifest.pages.media, {
      uniqueAttachments: 1,
      archiveBackedAttachments: 1,
      featuredReferences: 1,
      inlineReferences: 2,
      unresolvedReferences: 0
    });
    assert.equal(result.outcomes[0]?.record.media[0]?.attachedFile, "2026/01/photo.jpg");
    assert.deepEqual(result.outcomes[0]?.record.media[0]?.roles, [
      "featured",
      "inline"
    ]);
    assert.equal(result.outcomes[0]?.record.media[0]?.archiveMatch, "matched");
    assert.equal(result.gallery?.record.assets.length, 2);
    assert.equal(result.gallery?.record.publishedImages, 1);
    assert.equal(
      result.gallery?.record.assets.every((asset) => asset.normalization === "matched"),
      true
    );
    assert.deepEqual(normalizeBwgArchivePath("photo-gallery/album/original.jpg"), {
      kind: "already-archive-relative",
      archivePath: "photo-gallery/album/original.jpg"
    });
    assert.equal(normalizeBwgArchivePath("../unsafe.jpg").kind, "unsafe");

    const missingMediaArchive = path.join(directory, "missing-page-media.zip");
    writeFileSync(
      missingMediaArchive,
      zipArchive([
        "uploads/photo-gallery/album/original.jpg",
        "uploads/photo-gallery/album/thumb.jpg"
      ])
    );
    const missing = await runEditorialImport({
      ...options,
      uploadArchives: [missingMediaArchive]
    });
    assert.equal(
      missing.outcomes.find((outcome) => outcome.sourceId === "1")
        ?.issueCodes.includes("attachment-archive-missing"),
      true
    );
  });
});

test("editorial manifest counts every authoritative featured-media reference", async () => {
  await withDirectory(async (directory) => {
    const duplicateDatabase = path.join(directory, "duplicate-featured.sql");
    writeFileSync(
      duplicateDatabase,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_postmeta\` (\`meta_id\`, \`post_id\`, \`meta_key\`, \`meta_value\`) VALUES
  (4, 1, '_thumbnail_id', '999');
`
    );

    const result = await runEditorialImport(
      fixtureOptions(directory, duplicateDatabase)
    );

    assert.equal(result.manifest.pages.media.featuredReferences, 2);
    assert.equal(result.manifest.pages.media.unresolvedReferences, 1);
    assert.equal(
      result.outcomes.find((outcome) => outcome.sourceId === "1")
        ?.record.media.filter((media) => media.roles.includes("featured")).length,
      1
    );
  });
});

test("editorial URL mapping retains raw Unicode and rejects encoded separators", async () => {
  await withDirectory(async (directory) => {
    const unsafe = path.join(directory, "unsafe.sql");
    writeFileSync(
      unsafe,
      readFileSync(fixture, "utf8").replace("'solo'", "'%252f'")
    );
    const result = await runEditorialImport(fixtureOptions(directory, unsafe));
    const ungrouped = result.outcomes.find((outcome) => outcome.sourceId === "3");

    assert.equal(ungrouped?.status, "review");
    assert.equal(ungrouped?.issueCodes.includes("unsafe-canonical-slug"), true);
    assert.equal(decodeRecipeSlug("%D0%BA%D0%B5%D0%BA%D1%81"), "кекс");
    assert.throws(() => decodeRecipeSlug("%252f"), /unsafe separator/);
  });
});

test("editorial mapping flags unresolved same-origin links for review", async () => {
  await withDirectory(async (directory) => {
    const unresolved = path.join(directory, "unresolved.sql");
    writeFileSync(
      unresolved,
      readFileSync(fixture, "utf8").replace(
        "<p>Ungrouped source wording</p>",
        "<a href=\"/missing-page/\">Unresolved source wording</a>"
      )
    );
    const result = await runEditorialImport(fixtureOptions(directory, unresolved));
    const page = result.outcomes.find((outcome) => outcome.sourceId === "3");

    assert.equal(page?.status, "review");
    assert.equal(page?.issueCodes.includes("unresolved-internal-link"), true);
    assert.equal(
      result.manifest.gallery.issueCodes.includes("gallery-reference-missing"),
      true
    );
  });
});

test("editorial manifests emit only aggregate metadata and keyed candidate fingerprints", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    const result = await runEditorialImport(options);
    const serialized = serializeEditorialManifest(result.manifest);

    for (const forbidden of [
      "English page",
      "Source wording",
      "Source alt text",
      "Private gallery wording",
      "photo.jpg",
      "à-propos",
      "Test English Locale"
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(result.manifest.privacy.candidateIdentifiersAreKeyedHmac, true);
    assert.equal(serialized.includes(options.uploadArchives[0]), false);
    assert.equal(
      result.manifest.pages.outcomes.every((outcome) =>
        /^[a-f0-9]{64}$/u.test(outcome.fingerprint)
      ),
      true
    );
    assert.equal(result.manifest.pages.outcomes.some((outcome) => "sourceId" in outcome), false);
  });
});

test("editorial staging is private, resumable, and conflicts on changed markers", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    const suffix = randomBytes(8).toString("hex");
    const stagingDir = path.join(
      repositoryRoot,
      "migration-output",
      `.editorial-import-${suffix}`
    );
    try {
      const first = await runEditorialImport({
        ...options,
        dryRun: false,
        write: true,
        stagingDir
      });
      assert.equal(lstatSync(stagingDir).mode & 0o777, 0o700);
      assert.equal(
        lstatSync(path.join(stagingDir, "candidates", "page-1.json")).mode & 0o777,
        0o600
      );
      assert.equal(
        lstatSync(path.join(stagingDir, "candidates", "gallery-300.json")).mode & 0o777,
        0o600
      );
      assert.equal(stagingTreeSnapshot(stagingDir).includes("Test English Locale"), false);
      const candidatePath = path.join(stagingDir, "candidates", "page-1.json");
      const originalCandidate = readFileSync(candidatePath, "utf8");
      const resumed = await runEditorialImport({
        ...options,
        dryRun: false,
        write: true,
        stagingDir,
        resume: true
      });
      assert.deepEqual(resumed.manifest, first.manifest);
      const unexpectedPath = path.join(stagingDir, "manifest.json.tmp");
      writeFileSync(unexpectedPath, "residual", { mode: 0o600 });
      await assert.rejects(
        runEditorialImport({
          ...options,
          dryRun: false,
          write: true,
          stagingDir,
          resume: true
        }),
        (error: unknown) =>
          error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "staging-conflict"
      );
      rmSync(unexpectedPath);
      writeFileSync(candidatePath, "{}", { mode: 0o600 });
      await assert.rejects(
        runEditorialImport({
          ...options,
          dryRun: false,
          write: true,
          stagingDir,
          resume: true
        }),
        (error: unknown) =>
          error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "staging-conflict"
      );
      writeFileSync(candidatePath, originalCandidate, { mode: 0o600 });
      const markerPath = path.join(stagingDir, ".editorial-staging.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
      marker.importerContractVersion = "wordpress-editorial-staging-v0";
      writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
      await assert.rejects(
        runEditorialImport({
          ...options,
          dryRun: false,
          write: true,
          stagingDir,
          resume: true
        }),
        (error: unknown) =>
          error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "staging-conflict"
      );
      await assert.rejects(
        runEditorialImport({
          ...options,
          dryRun: false,
          write: true,
          stagingDir: "src/editorial-staging-test"
        }),
        (error: unknown) =>
          error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "unsafe-staging-dir"
      );
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});

test("editorial staging retries after an empty candidates-only interruption", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    const suffix = randomBytes(8).toString("hex");
    const stagingDir = path.join(
      repositoryRoot,
      "migration-output",
      `.editorial-interrupted-${suffix}`
    );
    try {
      mkdirSync(path.join(stagingDir, "candidates"), {
        recursive: true,
        mode: 0o700
      });
      chmodSync(stagingDir, 0o700);
      chmodSync(path.join(stagingDir, "candidates"), 0o700);

      const result = await runEditorialImport({
        ...options,
        dryRun: false,
        write: true,
        stagingDir
      });

      assert.equal(result.manifest.pages.total, 4);
      assert.equal(
        lstatSync(path.join(stagingDir, ".editorial-staging.json")).mode & 0o777,
        0o600
      );
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});

test("editorial staging rejects populated foreign roots without changing bytes", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    const suffix = randomBytes(8).toString("hex");
    const roots = [
      {
        name: "foreign-wprm",
        marker: ".wprm-staging.json",
        content: "{\"kind\":\"wprm-bulk-staging\"}\n"
      },
      {
        name: "foreign-editorial",
        marker: ".editorial-staging.json",
        content: "{\"kind\":\"wordpress-editorial-staging\"}\n"
      },
      {
        name: "unknown",
        marker: "unrelated.json",
        content: "{\"sentinel\":true}\n"
      }
    ] as const;
    try {
      for (const root of roots) {
        const stagingDir = path.join(
          repositoryRoot,
          "migration-output",
          `.editorial-foreign-${root.name}-${suffix}`
        );
        mkdirSync(path.join(stagingDir, "candidates"), { recursive: true, mode: 0o700 });
        chmodSync(stagingDir, 0o700);
        chmodSync(path.join(stagingDir, "candidates"), 0o700);
        writeFileSync(path.join(stagingDir, root.marker), root.content, { mode: 0o600 });
        writeFileSync(path.join(stagingDir, "candidates", "sentinel.json"), "{}\n", {
          mode: 0o600
        });
        const before = stagingTreeSnapshot(stagingDir);
        await assert.rejects(
          runEditorialImport({
            ...options,
            dryRun: false,
            write: true,
            stagingDir
          }),
          (error: unknown) =>
            error !== null
            && typeof error === "object"
            && "code" in error
            && error.code === "staging-conflict"
        );
        assert.equal(stagingTreeSnapshot(stagingDir), before);
        rmSync(stagingDir, { recursive: true, force: true });
      }
    } finally {
      for (const root of roots) {
        rmSync(
          path.join(
            repositoryRoot,
            "migration-output",
            `.editorial-foreign-${root.name}-${suffix}`
          ),
          { recursive: true, force: true }
        );
      }
    }
  });
});

test("editorial and WPRM writers contend on one root-scoped lock", async () => {
  await withDirectory(async (directory) => {
    const editorial = fixtureOptions(directory);
    const suffix = randomBytes(8).toString("hex");
    const stagingDir = path.join(
      repositoryRoot,
      "migration-output",
      `.shared-staging-lock-${suffix}`
    );
    try {
      const results = await Promise.allSettled([
        runEditorialImport({
          ...editorial,
          dryRun: false,
          write: true,
          stagingDir
        }),
        runWprmBulkImport({
          database: wprmFixture,
          fingerprintKeyFile: editorial.fingerprintKeyFile,
          dryRun: false,
          write: true,
          stagingDir
        })
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      assert.equal(
        rejected?.reason !== null
        && typeof rejected?.reason === "object"
        && "code" in rejected.reason
          ? rejected.reason.code
          : null,
        "staging-conflict"
      );
      assert.equal(
        Number(lstatSync(path.join(stagingDir, ".editorial-staging.json"), {
          throwIfNoEntry: false
        }) !== undefined)
        + Number(lstatSync(path.join(stagingDir, ".wprm-staging.json"), {
          throwIfNoEntry: false
        }) !== undefined),
        1
      );
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
});

test("editorial paths preserve validated WordPress page hierarchy", async () => {
  await withDirectory(async (directory) => {
    const childSource = `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_posts\` (\`ID\`, \`post_author\`, \`post_date\`, \`post_date_gmt\`, \`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_status\`, \`post_password\`, \`post_name\`, \`post_modified\`, \`post_modified_gmt\`, \`post_parent\`, \`guid\`, \`post_type\`, \`post_mime_type\`) VALUES
  (5, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '<p>Child</p>', 'Child page', '', 'publish', '', 'child', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 3, 'https://example.test/solo/child/', 'page', '');
INSERT INTO \`wp_term_relationships\` (\`object_id\`, \`term_taxonomy_id\`) VALUES (5, 10);
`;
    const childDatabase = path.join(directory, "child.sql");
    writeFileSync(childDatabase, childSource);
    const child = await runEditorialImport(fixtureOptions(directory, childDatabase));
    const childOutcome = child.outcomes.find((outcome) => outcome.sourceId === "5");
    assert.equal(childOutcome?.record.sourcePath, "/solo/child/");
    assert.equal(childOutcome?.status, "ready");

    const missingParentDatabase = path.join(directory, "missing-parent.sql");
    writeFileSync(
      missingParentDatabase,
      childSource.replace(
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 3, 'https://example.test/solo/child/'",
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 999, 'https://example.test/solo/child/'"
      )
    );
    const missingParent = await runEditorialImport(
      fixtureOptions(directory, missingParentDatabase)
    );
    const missingParentOutcome = missingParent.outcomes.find(
      (outcome) => outcome.sourceId === "5"
    );
    assert.equal(missingParentOutcome?.record.sourcePath, null);
    assert.equal(missingParentOutcome?.issueCodes.includes("missing-page-parent"), true);

    const nonPageParentDatabase = path.join(directory, "non-page-parent.sql");
    writeFileSync(
      nonPageParentDatabase,
      childSource.replace(
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 3, 'https://example.test/solo/child/'",
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 10, 'https://example.test/solo/child/'"
      )
    );
    const nonPageParent = await runEditorialImport(
      fixtureOptions(directory, nonPageParentDatabase)
    );
    const nonPageParentOutcome = nonPageParent.outcomes.find(
      (outcome) => outcome.sourceId === "5"
    );
    assert.equal(nonPageParentOutcome?.record.sourcePath, null);
    assert.equal(nonPageParentOutcome?.issueCodes.includes("non-page-parent"), true);

    const localeParentDatabase = path.join(directory, "locale-parent.sql");
    writeFileSync(
      localeParentDatabase,
      childSource.replace(
        "INSERT INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`) VALUES (5, 10);",
        "INSERT INTO `wp_term_relationships` (`object_id`, `term_taxonomy_id`) VALUES (5, 11);"
      )
    );
    const localeParent = await runEditorialImport(
      fixtureOptions(directory, localeParentDatabase)
    );
    const localeParentOutcome = localeParent.outcomes.find(
      (outcome) => outcome.sourceId === "5"
    );
    assert.equal(localeParentOutcome?.record.sourcePath, null);
    assert.equal(
      localeParentOutcome?.issueCodes.includes("incompatible-page-parent-locale"),
      true
    );

    const translationParentDatabase = path.join(directory, "translation-parent.sql");
    writeFileSync(
      translationParentDatabase,
      childSource.replace(
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 3, 'https://example.test/solo/child/'",
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 1, 'https://example.test/about/child/'"
      )
    );
    const translationParent = await runEditorialImport(
      fixtureOptions(directory, translationParentDatabase)
    );
    const translationParentOutcome = translationParent.outcomes.find(
      (outcome) => outcome.sourceId === "5"
    );
    assert.equal(translationParentOutcome?.record.sourcePath, null);
    assert.equal(
      translationParentOutcome?.issueCodes.includes("incompatible-page-parent-translation"),
      true
    );

    const unsafeAncestorDatabase = path.join(directory, "unsafe-ancestor.sql");
    writeFileSync(
      unsafeAncestorDatabase,
      childSource.replace(
        "'solo', '2026-01-02 10:00:00'",
        "'%252f', '2026-01-02 10:00:00'"
      )
    );
    const unsafeAncestor = await runEditorialImport(
      fixtureOptions(directory, unsafeAncestorDatabase)
    );
    const unsafeAncestorOutcome = unsafeAncestor.outcomes.find(
      (outcome) => outcome.sourceId === "5"
    );
    assert.equal(unsafeAncestorOutcome?.record.sourcePath, null);
    assert.equal(
      unsafeAncestorOutcome?.issueCodes.includes("unsafe-page-ancestor-slug"),
      true
    );

    const publicationParentDatabase = path.join(directory, "publication-parent.sql");
    writeFileSync(
      publicationParentDatabase,
      childSource.replace(
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 3, 'https://example.test/solo/child/'",
        "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 4, 'https://example.test/private-page/child/'"
      )
    );
    const publicationParent = await runEditorialImport(
      fixtureOptions(directory, publicationParentDatabase)
    );
    const publicationParentOutcome = publicationParent.outcomes.find(
      (outcome) => outcome.sourceId === "5"
    );
    assert.equal(publicationParentOutcome?.record.sourcePath, null);
    assert.equal(
      publicationParentOutcome?.issueCodes.includes("incompatible-page-parent-publication"),
      true
    );

    const cycleDatabase = path.join(directory, "cycle.sql");
    writeFileSync(
      cycleDatabase,
      childSource
        .replace(
          "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/about/'",
          "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 3, 'https://example.test/about/'"
        )
        .replace(
          "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/solo/'",
          "'2026-01-02 10:00:00', '2026-01-02 10:00:00', 1, 'https://example.test/solo/'"
        )
    );
    const cycle = await runEditorialImport(fixtureOptions(directory, cycleDatabase));
    for (const sourceId of ["1", "3"]) {
      const outcome = cycle.outcomes.find((candidate) => candidate.sourceId === sourceId);
      assert.equal(outcome?.record.sourcePath, null);
      assert.equal(outcome?.issueCodes.includes("cyclic-page-parent"), true);
    }
  });
});

test("editorial page hierarchy depth is bounded without overflowing the stack", async () => {
  await withDirectory(async (directory) => {
    const ids = Array.from({ length: 300 }, (_, index) => 1000 + index).reverse();
    const posts = ids.map((id) => {
      const parentId = id === 1000 ? 0 : id - 1;
      return `(${id}, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '<p>Depth</p>', 'Depth', '', 'publish', '', 'depth-${id}', '2026-01-02 10:00:00', '2026-01-02 10:00:00', ${parentId}, 'https://example.test/depth-${id}/', 'page', '')`;
    });
    const relationships = ids.map((id) => `(${id}, 10)`);
    const database = path.join(directory, "deep-hierarchy.sql");
    writeFileSync(
      database,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_posts\` (\`ID\`, \`post_author\`, \`post_date\`, \`post_date_gmt\`, \`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_status\`, \`post_password\`, \`post_name\`, \`post_modified\`, \`post_modified_gmt\`, \`post_parent\`, \`guid\`, \`post_type\`, \`post_mime_type\`) VALUES
  ${posts.join(",\n  ")};
INSERT INTO \`wp_term_relationships\` (\`object_id\`, \`term_taxonomy_id\`) VALUES
  ${relationships.join(",\n  ")};
`
    );

    const result = await runEditorialImport(fixtureOptions(directory, database));
    const deepest = result.outcomes.find((outcome) => outcome.sourceId === "1299");

    assert.equal(deepest?.status, "review");
    assert.equal(deepest?.issueCodes.includes("page-parent-depth-limit"), true);
  });
});

test("editorial parent and relation identifiers reject malformed non-root values", async () => {
  await withDirectory(async (directory) => {
    const malformedPageParent = path.join(directory, "malformed-page-parent.sql");
    writeFileSync(
      malformedPageParent,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_posts\` (\`ID\`, \`post_author\`, \`post_date\`, \`post_date_gmt\`, \`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_status\`, \`post_password\`, \`post_name\`, \`post_modified\`, \`post_modified_gmt\`, \`post_parent\`, \`guid\`, \`post_type\`, \`post_mime_type\`) VALUES
  (5, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '<p>Child</p>', 'Child page', '', 'publish', '', 'child', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 'not-a-parent', 'https://example.test/child/', 'page', '');
INSERT INTO \`wp_term_relationships\` (\`object_id\`, \`term_taxonomy_id\`) VALUES (5, 10);
`
    );
    const malformedPage = await runEditorialImport(
      fixtureOptions(directory, malformedPageParent)
    );
    const page = malformedPage.outcomes.find((outcome) => outcome.sourceId === "5");
    assert.equal(page?.record.sourcePath, null);
    assert.equal(page?.issueCodes.includes("malformed-page-parent"), true);

    const malformedAttachmentParent = path.join(directory, "malformed-attachment-parent.sql");
    writeFileSync(
      malformedAttachmentParent,
      readFileSync(fixture, "utf8").replace(
        "'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'",
        "'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 'not-a-parent', 'https://example.test/wp-content/uploads/2026/01/photo.jpg'"
      )
    );
    const malformedAttachment = await runEditorialImport(
      fixtureOptions(directory, malformedAttachmentParent)
    );
    const pageWithFeaturedMedia = malformedAttachment.outcomes.find(
      (outcome) => outcome.sourceId === "1"
    );
    assert.equal(
      pageWithFeaturedMedia?.issueCodes.includes("malformed-attachment-parent"),
      true
    );

    const malformedRelation = path.join(directory, "malformed-relation.sql");
    writeFileSync(
      malformedRelation,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_term_relationships\` (\`object_id\`, \`term_taxonomy_id\`) VALUES ('not-an-object-id', 10);
`
    );
    await assert.rejects(
      runEditorialImport(fixtureOptions(directory, malformedRelation)),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "malformed-term-relationship"
    );
  });
});

test("editorial image URLs keep unsafe and safe-external classifications distinct", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "unsafe-images.sql");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        "<p>Ungrouped source wording</p>",
        "<img src=\"javascript:alert(1)\"><img src=\"data:image/png;base64,AA==\"><img src=\"/wp-content/uploads/%2e%2e/secret.jpg\"><img src=\"https://cdn.example.test/photo.jpg\">"
      )
    );
    const result = await runEditorialImport(fixtureOptions(directory, database));
    const page = result.outcomes.find((outcome) => outcome.sourceId === "3");
    assert.equal(page?.status, "review");
    assert.equal(page?.issueCodes.includes("unsafe-inline-media"), true);
    assert.equal(page?.record.structure.unsafeImageReferences, 3);
    assert.equal(page?.record.structure.externalImageReferences, 1);
  });
});

test("editorial manifest counts each unresolved image reference", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "unresolved-images.sql");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        "<p>Ungrouped source wording</p>",
        "<img src=\"/wp-content/uploads/missing-one.jpg\"><source src=\"/wp-content/uploads/missing-two.jpg\">"
      )
    );

    const result = await runEditorialImport(fixtureOptions(directory, database));
    const page = result.outcomes.find((outcome) => outcome.sourceId === "3");

    assert.equal(page?.record.structure.unresolvedMediaReferences, 2);
    assert.equal(result.manifest.pages.media.unresolvedReferences, 2);
  });
});

test("editorial scans every img and source srcset candidate before media resolution", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "srcset.sql");
    const markup = [
      "<picture>",
      "<source src=\"/wp-content/uploads/%252e%252e/secret.jpg\"",
      " srcset=\"/wp-content/uploads/2026/01/photo.jpg 1x, /wp-content/uploads/%252e%252e/secret.jpg 2x\">",
      "<img src=\"/wp-content/uploads/2026/01/photo.jpg\"",
      " srcset=\"/wp-content/uploads/2026/01/photo.jpg 1x, /wp-content/uploads/missing.jpg 2x\">",
      "</picture>"
    ].join("");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace("<p>Ungrouped source wording</p>", markup)
    );
    const result = await runEditorialImport(fixtureOptions(directory, database));
    const page = result.outcomes.find((outcome) => outcome.sourceId === "3");
    assert.equal(page?.status, "review");
    assert.equal(page?.record.structure.markupImageReferences, 6);
    assert.equal(page?.record.structure.unsafeImageReferences, 2);
    assert.equal(page?.issueCodes.includes("unsafe-inline-media"), true);
    assert.equal(page?.issueCodes.includes("unresolved-inline-media"), true);
    assert.equal(page?.record.media[0]?.sourceId, "10");

    await assert.rejects(
      runEditorialImport({
        ...fixtureOptions(directory, database),
        limits: { evidence: { maxEvidenceReferences: 10 } }
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "evidence-reference-limit"
    );

    const malformed = path.join(directory, "malformed-srcset.sql");
    writeFileSync(
      malformed,
      readFileSync(fixture, "utf8").replace(
        "<p>Ungrouped source wording</p>",
        "<img srcset=\"/wp-content/uploads/2026/01/photo.jpg 1x, /wp-content/uploads/missing.jpg 2x"
      )
    );
    const malformedResult = await runEditorialImport(fixtureOptions(directory, malformed));
    const malformedPage = malformedResult.outcomes.find(
      (outcome) => outcome.sourceId === "3"
    );
    assert.equal(malformedPage?.issueCodes.includes("malformed-page-content"), true);
  });
});

test("editorial attachment URL lookup retains every canonical owner", async () => {
  await withDirectory(async (directory) => {
    const duplicate = path.join(directory, "duplicate-attachment-url.sql");
    writeFileSync(
      duplicate,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_posts\` (\`ID\`, \`post_author\`, \`post_date\`, \`post_date_gmt\`, \`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_status\`, \`post_password\`, \`post_name\`, \`post_modified\`, \`post_modified_gmt\`, \`post_parent\`, \`guid\`, \`post_type\`, \`post_mime_type\`) VALUES
  (11, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '', '', '', 'private', '', 'duplicate-photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/wp-content/uploads/2026/01/photo.jpg', 'attachment', 'image/jpeg');
INSERT INTO \`wp_postmeta\` (\`meta_id\`, \`post_id\`, \`meta_key\`, \`meta_value\`) VALUES
  (4, 11, '_wp_attached_file', '2026/01/photo.jpg');
`.replace(
        "<p>Ungrouped source wording</p>",
        "<a href=\"/wp-content/uploads/2026/01/photo.jpg\">Attachment</a><img src=\"/wp-content/uploads/2026/01/photo.jpg\">"
      )
    );
    const result = await runEditorialImport(fixtureOptions(directory, duplicate));
    const inlinePage = result.outcomes.find((outcome) => outcome.sourceId === "3");
    const featuredPage = result.outcomes.find((outcome) => outcome.sourceId === "1");
    assert.equal(inlinePage?.issueCodes.includes("ambiguous-inline-media"), true);
    assert.equal(inlinePage?.issueCodes.includes("ambiguous-attachment-path"), true);
    assert.equal(inlinePage?.record.media.length, 0);
    assert.equal(inlinePage?.record.structure.links.unresolved, 1);
    assert.equal(featuredPage?.issueCodes.includes("ambiguous-attachment-path"), true);
  });
});

test("editorial media publication and inherited parent state are review-gated", async () => {
  await withDirectory(async (directory) => {
    const source = readFileSync(fixture, "utf8");
    const privateDatabase = path.join(directory, "private-attachment.sql");
    writeFileSync(
      privateDatabase,
      source.replace(
        "'inherit', '', 'photo', '2026-01-02 10:00:00'",
        "'private', '', 'photo', '2026-01-02 10:00:00'"
      )
    );
    const privateResult = await runEditorialImport(fixtureOptions(directory, privateDatabase));
    const privatePage = privateResult.outcomes.find((outcome) => outcome.sourceId === "1");
    assert.equal(privatePage?.issueCodes.includes("nonpublish-attachment"), true);

    const protectedDatabase = path.join(directory, "protected-attachment.sql");
    writeFileSync(
      protectedDatabase,
      source.replace(
        "'inherit', '', 'photo', '2026-01-02 10:00:00'",
        "'inherit', 'secret', 'photo', '2026-01-02 10:00:00'"
      )
    );
    const protectedResult = await runEditorialImport(
      fixtureOptions(directory, protectedDatabase)
    );
    const protectedPage = protectedResult.outcomes.find((outcome) => outcome.sourceId === "1");
    assert.equal(protectedPage?.issueCodes.includes("protected-attachment"), true);

    const parentDatabase = path.join(directory, "private-parent.sql");
    writeFileSync(
      parentDatabase,
      source.replace(
        "'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'",
        "'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 4, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'"
      )
    );
    const parentResult = await runEditorialImport(fixtureOptions(directory, parentDatabase));
    const parentPage = parentResult.outcomes.find((outcome) => outcome.sourceId === "1");
    assert.equal(parentPage?.issueCodes.includes("nonpublish-attachment-parent"), true);

    const inheritedDatabase = path.join(directory, "public-parent.sql");
    writeFileSync(
      inheritedDatabase,
      source.replace(
        "'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 0, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'",
        "'inherit', '', 'photo', '2026-01-02 10:00:00', '2026-01-02 10:00:00', 1, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'"
      )
    );
    const inheritedResult = await runEditorialImport(
      fixtureOptions(directory, inheritedDatabase)
    );
    const inheritedPage = inheritedResult.outcomes.find((outcome) => outcome.sourceId === "1");
    assert.equal(inheritedPage?.issueCodes.includes("unresolved-attachment-parent"), false);
  });
});

test("editorial attachment ancestry is depth-bounded", async () => {
  await withDirectory(async (directory) => {
    const ids = Array.from({ length: 300 }, (_, index) => 2000 + index);
    const posts = ids.map((id, index) => {
      const parentId = index === ids.length - 1 ? 0 : id + 1;
      return `(${id}, 5, '2026-01-01 10:00:00', '2026-01-01 10:00:00', '', '', '', 'inherit', '', 'attachment-${id}', '2026-01-02 10:00:00', '2026-01-02 10:00:00', ${parentId}, 'https://example.test/wp-content/uploads/attachment-${id}.jpg', 'attachment', 'image/jpeg')`;
    });
    const database = path.join(directory, "deep-attachment-parent.sql");
    writeFileSync(
      database,
      `${readFileSync(fixture, "utf8").replace(
        "0, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'",
        "2000, 'https://example.test/wp-content/uploads/2026/01/photo.jpg'"
      )}
INSERT INTO \`wp_posts\` (\`ID\`, \`post_author\`, \`post_date\`, \`post_date_gmt\`, \`post_content\`, \`post_title\`, \`post_excerpt\`, \`post_status\`, \`post_password\`, \`post_name\`, \`post_modified\`, \`post_modified_gmt\`, \`post_parent\`, \`guid\`, \`post_type\`, \`post_mime_type\`) VALUES
  ${posts.join(",\n  ")};
`
    );

    const result = await runEditorialImport(fixtureOptions(directory, database));
    const page = result.outcomes.find((outcome) => outcome.sourceId === "1");

    assert.equal(page?.issueCodes.includes("attachment-parent-depth-limit"), true);
    assert.equal(page?.issueCodes.includes("unresolved-attachment-parent"), true);
  });
});

test("BWG staging binds only unambiguous referenced galleries", async () => {
  await withDirectory(async (directory) => {
    const source = readFileSync(fixture, "utf8");
    const noReference = await runEditorialImport(fixtureOptions(directory));
    assert.equal(noReference.gallery?.sourceId, "300");
    assert.equal(noReference.gallery?.record.assets.length, 2);
    assert.equal(noReference.gallery?.record.publishedImages, 1);
    assert.equal(
      noReference.gallery?.record.issueCodes.includes("gallery-reference-missing"),
      true
    );
    assert.equal(noReference.manifest.gallery.issueCodes.includes("gallery-reference-missing"), true);

    const validDatabase = path.join(directory, "valid-gallery.sql");
    writeFileSync(
      validDatabase,
      source.replace(
        "<p>Ungrouped source wording</p>",
        "[BWG_GALLERY gallery_id=\"300\"]<p>Ungrouped source wording</p>"
      )
    );
    const valid = await runEditorialImport(fixtureOptions(directory, validDatabase));
    assert.equal(valid.gallery?.sourceId, "300");
    const multipleDatabase = path.join(directory, "multiple-gallery.sql");
    writeFileSync(
      multipleDatabase,
      source
        .replace(
          "(300, 'Private gallery wording');",
          "(300, 'Private gallery wording'),\n  (400, 'Second gallery wording');"
        )
        .replace(
          "(301, 300, 'photo-gallery/album/original.jpg', 'photo-gallery/album/thumb.jpg', '1');",
          "(301, 300, 'photo-gallery/album/original.jpg', 'photo-gallery/album/thumb.jpg', '1'),\n"
          + "  (401, 400, 'photo-gallery/second/original.jpg', 'photo-gallery/second/thumb.jpg', '1');"
        )
    );
    const multiple = await runEditorialImport(
      fixtureOptions(directory, multipleDatabase)
    );
    assert.deepEqual(
      multiple.galleries.map((gallery) => gallery.sourceId),
      ["300", "400"]
    );
    assert.equal(
      multiple.galleries.every((gallery) =>
        gallery.record.issueCodes.includes("gallery-reference-missing")
      ),
      true
    );

    const malformedDatabase = path.join(directory, "malformed-gallery.sql");
    writeFileSync(
      malformedDatabase,
      source.replace(
        "<p>Ungrouped source wording</p>",
        "[bwg ids=\"300\"]<p>Ungrouped source wording</p>"
      )
    );
    const malformed = await runEditorialImport(
      fixtureOptions(directory, malformedDatabase)
    );
    const malformedPage = malformed.outcomes.find((outcome) => outcome.sourceId === "3");
    assert.equal(malformed.gallery?.sourceId, "300");
    assert.equal(malformedPage?.issueCodes.includes("unsupported-gallery-reference"), true);

    const ambiguousDatabase = path.join(directory, "ambiguous-gallery.sql");
    writeFileSync(
      ambiguousDatabase,
      source.replace(
        "<p>Ungrouped source wording</p>",
        "[bwg id=\"300,301\"]<p>Ungrouped source wording</p>"
      )
    );
    const ambiguous = await runEditorialImport(
      fixtureOptions(directory, ambiguousDatabase)
    );
    const ambiguousPage = ambiguous.outcomes.find((outcome) => outcome.sourceId === "3");
    assert.equal(ambiguous.gallery?.sourceId, "300");
    assert.equal(ambiguousPage?.issueCodes.includes("ambiguous-gallery-reference"), true);
  });
});

test("missing BWG gallery references remain visible without gallery candidates", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "missing-gallery.sql");
    const source = readFileSync(fixture, "utf8")
      .replace(
        "INSERT INTO `wp_bwg_gallery` (`id`, `name`) VALUES\n  (300, 'Private gallery wording');\n",
        ""
      )
      .replace(
        "INSERT INTO `wp_bwg_image` (`id`, `gallery_id`, `image_url`, `thumb_url`, `published`) VALUES\n  (301, 300, 'photo-gallery/album/original.jpg', 'photo-gallery/album/thumb.jpg', '1');\n",
        ""
      )
      .replace(
        "<p>Ungrouped source wording</p>",
        "[bwg id=\"999\"]<p>Ungrouped source wording</p>"
      );
    writeFileSync(database, source);

    const result = await runEditorialImport(fixtureOptions(directory, database));

    assert.equal(result.galleries.length, 0);
    assert.equal(
      result.manifest.gallery.issueCodes.includes("gallery-reference-missing"),
      true
    );
  });
});

test("every authoritative BWG gallery is retained with all image assets", async () => {
  await withDirectory(async (directory) => {
    const source = readFileSync(fixture, "utf8");
    const rows = Array.from({ length: 67 }, (_, index) => {
      const imageId = 301 + index;
      const suffix = String(index + 1).padStart(2, "0");
      return `  (${imageId}, 300, 'photo-gallery/authoritative/${suffix}.jpg', 'photo-gallery/authoritative/${suffix}-thumb.jpg', '1')`;
    }).join(",\n");
    const database = path.join(directory, "authoritative-gallery.sql");
    writeFileSync(
      database,
      source.replace(
        /INSERT INTO `wp_bwg_image`[\s\S]*$/u,
        `INSERT INTO \`wp_bwg_image\` (\`id\`, \`gallery_id\`, \`image_url\`, \`thumb_url\`, \`published\`) VALUES\n${rows};\n`
      )
    );
    const archive = path.join(directory, "authoritative-gallery.zip");
    writeFileSync(
      archive,
      zipArchive([
        "uploads/2026/01/photo.jpg",
        ...Array.from({ length: 67 }, (_, index) => {
          const suffix = String(index + 1).padStart(2, "0");
          return [
            `uploads/photo-gallery/authoritative/${suffix}.jpg`,
            `uploads/photo-gallery/authoritative/${suffix}-thumb.jpg`
          ];
        }).flat()
      ])
    );
    const result = await runEditorialImport({
      ...fixtureOptions(directory, database),
      uploadArchives: [archive]
    });
    assert.equal(result.galleries.length, 1);
    assert.equal(
      result.gallery?.record.kind === "wordpress-bwg-gallery-candidate"
        ? result.gallery.record.source.images.length
        : null,
      67
    );
    assert.equal(result.gallery?.record.assets.length, 134);
    assert.equal(
      result.gallery?.record.issueCodes.includes("gallery-reference-missing"),
      true
    );
    assert.equal(result.manifest.gallery.publishedImages, 67);
    assert.equal(result.manifest.gallery.assets, 134);
    assert.equal(result.manifest.gallery.archiveBackedAssets, 134);
  });
});

test("every BWG image row is retained without inventing a missing gallery", async () => {
  await withDirectory(async (directory) => {
    const database = path.join(directory, "unassigned-bwg-images.sql");
    writeFileSync(
      database,
      `${readFileSync(fixture, "utf8")}
INSERT INTO \`wp_bwg_image\` (\`id\`, \`gallery_id\`, \`image_url\`, \`thumb_url\`, \`published\`) VALUES
  (302, NULL, 'photo-gallery/orphan/null.jpg', 'photo-gallery/orphan/null-thumb.jpg', '1'),
  (303, 999, 'photo-gallery/orphan/missing.jpg', 'photo-gallery/orphan/missing-thumb.jpg', '1'),
  (304, 'not-a-gallery-id', 'photo-gallery/orphan/malformed.jpg', 'photo-gallery/orphan/malformed-thumb.jpg', '1');
`
    );
    const archive = path.join(directory, "unassigned-bwg-images.zip");
    writeFileSync(
      archive,
      zipArchive([
        "uploads/2026/01/photo.jpg",
        "uploads/photo-gallery/album/original.jpg",
        "uploads/photo-gallery/album/thumb.jpg",
        "uploads/photo-gallery/orphan/null.jpg",
        "uploads/photo-gallery/orphan/null-thumb.jpg",
        "uploads/photo-gallery/orphan/missing.jpg",
        "uploads/photo-gallery/orphan/missing-thumb.jpg",
        "uploads/photo-gallery/orphan/malformed.jpg",
        "uploads/photo-gallery/orphan/malformed-thumb.jpg"
      ])
    );
    const result = await runEditorialImport({
      ...fixtureOptions(directory, database),
      uploadArchives: [archive]
    });
    assert.deepEqual(
      result.galleries.filter((outcome) => outcome.sourceKind === "gallery")
        .map((outcome) => outcome.sourceId),
      ["300"]
    );
    const unassigned = result.galleries.filter(
      (outcome) => outcome.sourceKind === "unassigned-image"
    );
    assert.deepEqual(unassigned.map((outcome) => outcome.sourceId), ["302", "303", "304"]);
    assert.equal(
      unassigned.find((outcome) => outcome.sourceId === "302")
        ?.record.issueCodes.includes("missing-bwg-image-gallery-id"),
      true
    );
    assert.equal(
      unassigned.find((outcome) => outcome.sourceId === "303")
        ?.record.issueCodes.includes("missing-bwg-image-gallery"),
      true
    );
    assert.equal(
      unassigned.find((outcome) => outcome.sourceId === "304")
        ?.record.issueCodes.includes("malformed-bwg-image-gallery-id"),
      true
    );
    assert.equal(result.manifest.gallery.galleries, 1);
    assert.equal(result.manifest.gallery.imageRows, 4);
    assert.equal(result.manifest.gallery.assignedImages, 1);
    assert.equal(result.manifest.gallery.unassignedImages, 3);
    assert.equal(result.manifest.gallery.candidates, 4);
    assert.equal(result.manifest.gallery.publishedImages, 4);
    assert.equal(result.manifest.gallery.assets, 8);
    assert.equal(result.manifest.gallery.archiveBackedAssets, 8);
    assert.equal(result.manifest.gallery.fingerprints.length, 4);
  });
});

test("editorial CLI rejects publication destinations and source limits fail explicitly", async () => {
  await withDirectory(async (directory) => {
    const options = fixtureOptions(directory);
    await assert.rejects(
      runEditorialImportCli([
        "--database",
        options.database,
        "--uploads-dir",
        directory,
        "--fingerprint-key-file",
        options.fingerprintKeyFile,
        "--output",
        "published.json"
      ]),
      (error: unknown) =>
        error instanceof Error
        && "code" in error
        && error.code === "rejected-option-output"
    );
    await assert.rejects(
      runEditorialImport({
        ...options,
        limits: { maxPageCandidates: 1 }
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "page-candidate-limit"
    );
    await assert.rejects(
      runEditorialImport({
        ...options,
        limits: { evidence: { maxPosts: 1 } }
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "post-limit"
    );
    await assert.rejects(
      runEditorialImport({
        ...options,
        limits: { evidence: { maxEvidenceReferences: 1 } }
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "evidence-reference-limit"
    );
    const sizedArchive = readFileSync(options.uploadArchives[0]);
    const centralOffset = sizedArchive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.notEqual(centralOffset, -1);
    sizedArchive.writeUInt32LE(2, centralOffset + 20);
    sizedArchive.writeUInt32LE(2, centralOffset + 24);
    writeFileSync(options.uploadArchives[0], sizedArchive);
    await assert.rejects(
      runEditorialImportCli([
        "--database",
        options.database,
        "--uploads-dir",
        directory,
        "--fingerprint-key-file",
        options.fingerprintKeyFile,
        "--max-entry-uncompressed-bytes",
        "1"
      ]),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "entry-size-limit"
    );
    const malformed = path.join(directory, "malformed.sql");
    writeFileSync(malformed, "INSERT INTO `wp_posts` (`ID`) VALUES (1");
    await assert.rejects(
      runEditorialImport(fixtureOptions(directory, malformed)),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "malformed-sql"
    );
  });
});
