import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  normalizeAttachmentPath,
  normalizeMediaBasePath,
  runImporter
} from "../scripts/import-wordpress-recipe";
import { parsePhpSerialized } from "../scripts/wordpress/php-serialize";
import { getPostMeta } from "../scripts/wordpress/sql-dump";

const fixture = fileURLToPath(
  new URL("./fixtures/wordpress/wprm-minimal.sql", import.meta.url)
);

test("PHP serialization uses UTF-8 byte lengths", () => {
  assert.equal(parsePhpSerialized('s:2:"½";'), "½");
  assert.throws(() => parsePhpSerialized('s:1:"½";'), /UTF-8 string length/);
  assert.throws(() => parsePhpSerialized('s:2:"½";trailing'), /trailing/);
});

test("post metadata parsing preserves SQL-escaped apostrophes", async () => {
  const sql = await readFile(fixture, "utf8");
  const metadata = getPostMeta(sql, "42");

  assert.equal(metadata.get("recipe_description"), "Une recette d'essai.");
});

test("the importer is dry-run by default and validates its record", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;

  try {
    const record = await runImporter([
      "--database",
      fixture,
      "--recipe-id",
      "42",
      "--slug",
      "soupe-test",
      "--locale",
      "fr",
      "--dry-run"
    ]);

    assert.equal(record.locale, "fr");
    assert.equal(record.title, "Soupe de test");
    assert.deepEqual(record.redirectFrom, []);
    assert.equal(record.recipe.ingredientGroups[0].items[0].raw, "½ lb ground turkey");
    assert.equal(record.recipe.heroMediaId, "wordpress-attachment:100");
    assert.equal(
      record.recipe.instructionGroups[0].steps[0].mediaId,
      "wordpress-attachment:101"
    );
    assert.deepEqual(
      record.media.map((media) => media.path),
      ["/wordpress-uploads/2026/08/hero.jpg", "/wordpress-uploads/2026/08/step.jpg"]
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("the importer requires an explicit output before writing", async () => {
  await assert.rejects(
    runImporter([
      "--database",
      fixture,
      "--recipe-id",
      "42",
      "--slug",
      "soupe-test",
      "--locale",
      "fr",
      "--write"
    ]),
    /requires an explicit --output/
  );
});

test("media paths reject encoded traversal and normalize the root base", () => {
  assert.equal(normalizeMediaBasePath("/"), "/");
  assert.equal(normalizeMediaBasePath("/recipes/media/"), "/recipes/media/");
  assert.throws(
    () => normalizeAttachmentPath("%2e%2e/admin", "100"),
    /unsafe path segment/
  );
  assert.throws(
    () => normalizeAttachmentPath("safe/%252e%252e/admin", "100"),
    /unsafe path segment/
  );
});

test("the importer rejects encoded and malformed recipe slugs", async () => {
  for (const slug of [
    ".",
    "..",
    "%2e",
    "%252e%252e",
    "%25252e%25252e",
    "unsafe/%2f",
    "unsafe%252fpath",
    "unsafe%5cpath",
    "malformed%",
    "malformed%2"
  ]) {
    await assert.rejects(
      runImporter([
        "--database",
        fixture,
        "--recipe-id",
        "42",
        "--slug",
        slug,
        "--locale",
        "fr",
        "--dry-run"
      ]),
      slug.includes("%") ? /--slug.*raw Unicode/ : /--slug/
    );
  }
});

test("dry-run and write modes cannot be combined", async () => {
  await assert.rejects(
    runImporter([
      "--database",
      fixture,
      "--recipe-id",
      "42",
      "--slug",
      "soupe-test",
      "--locale",
      "fr",
      "--dry-run",
      "--write",
      "--output",
      "/tmp/should-not-be-written.json"
    ]),
    /cannot be used together/
  );
});
