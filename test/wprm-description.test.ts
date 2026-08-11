import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  normalizeWprmRichText,
  WprmRichTextNormalizationError
} from "../scripts/wordpress/html-to-text";
import { runWprmBulkImport } from "../scripts/wordpress/wprm-import-runner";

const fixture = path.resolve(process.cwd(), "test/fixtures/wordpress/wprm-bulk.sql");

test("WPRM rich text becomes bounded plain text with entity and block semantics", () => {
  const normalized = normalizeWprmRichText(
    "<p>First &amp; <em>second</em><br>third.</p><ul><li>Next&#x21;</li><li>Last</li></ul>",
    { maxInputBytes: 1_024 }
  );

  assert.equal(normalized, "First & second\nthird.\n\nNext!\n\nLast");
  assert.equal(
    normalizeWprmRichText("Salt &amp; pepper &quot;always&quot;.", {
      maxInputBytes: 1_024
    }),
    "Salt & pepper \"always\"."
  );
  assert.equal(/<\s*\/?[A-Za-z][^>]*>/u.test(normalized ?? ""), false);
});

test("WPRM rich-text normalization rejects malformed and excessive source values", () => {
  for (const value of ["<p", "<p>unclosed", "<script>unsafe</script>", "Text &unknown;"]) {
    assert.throws(
      () => normalizeWprmRichText(value, { maxInputBytes: 1_024 }),
      (error: unknown) =>
        error instanceof WprmRichTextNormalizationError
        && error.code === "malformed-wprm-rich-text"
    );
  }
  assert.throws(
    () => normalizeWprmRichText("x".repeat(32), { maxInputBytes: 16 }),
    (error: unknown) =>
      error instanceof WprmRichTextNormalizationError
      && error.code === "rich-text-normalization-limit"
  );
});

test("the mapper normalizes every displayed WPRM rich-text field", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-description-test-"));
  try {
    const database = path.join(directory, "source.sql");
    const key = path.join(directory, "fingerprint.key");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        "'Time review description'",
        "'<p>First &amp; <em>second</em>.</p><p>Next&#x21;</p>'"
      ).replace(
        "'Ready recipe'",
        "'<strong>Ready &amp; recipe</strong>'"
      ).replace(
        "'[{\"ingredients\":[{\"amount\":\"1 1/2\",\"unit\":\"cups\",\"name\":\"Flour\",\"notes\":\"sifted\",\"raw\":\"1 1/2 cups Flour, sifted\"}],\"name\":\"Main\",\"uid\":\"g1\"}]'",
        "'[{\"ingredients\":[{\"amount\":\"<em>1 1/2</em>\",\"unit\":\"<strong>cups</strong>\",\"name\":\"Flour &amp; <em>salt</em>\",\"notes\":\"<p>sifted</p>\",\"raw\":\"<p>1 1/2 <em>cups</em> Flour &amp; salt<br>well mixed</p>\"}],\"name\":\"<h2>Main &amp; group</h2>\",\"uid\":\"g1\"}]'"
      ).replace(
        "'[{\"instructions\":[{\"text\":\"Mix exactly.\",\"image\":null}],\"name\":\"Steps\",\"uid\":\"s1\"}]'",
        "'[{\"instructions\":[{\"text\":\"<p>Mix <strong>exactly</strong>.</p><ul><li>Then rest.</li></ul>\",\"image\":null}],\"name\":\"<h2>Steps &amp; method</h2>\",\"uid\":\"s1\"}]'"
      ).replace(
        "'Cooling'",
        "'<strong>Cooling &amp; resting</strong>'"
      ).replace(
        "'Keep covered.'",
        "'<p>Keep <em>covered</em>.</p>'"
      ).replace(
        "'a:1:{i:0;a:4:{s:2:\"id\";i:17;s:4:\"name\";s:17:\"Fixture equipment\";s:6:\"amount\";s:1:\"1\";s:5:\"notes\";s:0:\"\";}}'",
        "'[{\"id\":17,\"name\":\"<em>Fixture equipment</em>\",\"amount\":\"<strong>1</strong>\",\"notes\":\"<p>clean</p>\"}]'"
      ).replace(
        "'Fixture alt'",
        "'<em>Fixture &amp; alt</em>'"
      ).replace(
        "'Recipe category'",
        "'<em>Recipe &amp; category</em>'"
      ).replace(
        "'Editorial FR body'",
        "'<p>Source <em>editorial</em>.</p>'"
      ).replace("  (14, 100, '_thumbnail_id', '900'),\n", ""),
      { mode: 0o600 }
    );
    writeFileSync(key, randomBytes(32), { mode: 0o600 });

    const result = await runWprmBulkImport({
      database,
      fingerprintKeyFile: key,
      dryRun: true
    });
    const descriptionOutcome = result.outcomes.find((candidate) => candidate.recipeId === "104");
    assert.ok(descriptionOutcome?.record);
    assert.equal(descriptionOutcome.record.description, "First & second.\n\nNext!");
    assert.equal(
      descriptionOutcome.record.editorial.content,
      "<p>Source <em>editorial</em>.</p>"
    );
    assert.equal(descriptionOutcome.record.editorial.excerpt, "Editorial FR excerpt");

    const outcome = result.outcomes.find((candidate) => candidate.recipeId === "100");
    assert.ok(outcome?.record);
    assert.equal(outcome.record.title, "Ready & recipe");
    assert.equal(outcome.record.taxonomies[0]?.name, "Recipe & category");
    assert.equal(outcome.record.recipe.notes, "Keep covered.");
    assert.equal(outcome.record.recipe.times.custom?.label, "Cooling & resting");
    assert.equal(outcome.record.recipe.equipment?.[0]?.name, "Fixture equipment");
    assert.equal(outcome.record.recipe.equipment?.[0]?.amount, "1");
    assert.equal(outcome.record.recipe.equipment?.[0]?.notes, "clean");
    const ingredientGroup = outcome.record.recipe.ingredientGroups[0];
    const ingredient = ingredientGroup?.items[0];
    assert.equal(ingredientGroup?.name, "Main & group");
    assert.equal(ingredient?.name, "Flour & salt");
    assert.equal(ingredient?.notes, "sifted");
    assert.equal(ingredient?.quantity?.raw, "1 1/2 cups");
    assert.equal(ingredient?.raw, "1 1/2 cups Flour & salt\nwell mixed");
    const instructionGroup = outcome.record.recipe.instructionGroups[0];
    assert.equal(instructionGroup?.name, "Steps & method");
    assert.equal(instructionGroup?.steps[0]?.text, "Mix exactly.\n\nThen rest.");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("the mapper classifies malformed rich-text markup as an explicit error", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-description-error-test-"));
  try {
    const database = path.join(directory, "source.sql");
    const key = path.join(directory, "fingerprint.key");
    writeFileSync(
      database,
      readFileSync(fixture, "utf8").replace(
        "'Time review description'",
        "'<p'"
      ),
      { mode: 0o600 }
    );
    writeFileSync(key, randomBytes(32), { mode: 0o600 });

    const result = await runWprmBulkImport({
      database,
      fingerprintKeyFile: key,
      dryRun: true
    });
    const outcome = result.outcomes.find((candidate) => candidate.recipeId === "104");
    assert.ok(outcome);
    assert.equal(outcome.status, "error");
    assert.equal(outcome.record, null);
    assert.equal(outcome.codes.includes("malformed-wprm-rich-text"), true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
