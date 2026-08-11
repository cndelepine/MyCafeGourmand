import assert from "node:assert/strict";
import test from "node:test";
import { recipeCatalog, validateCatalog } from "../src/content/catalog";
import { recipeFixture } from "./fixtures/recipe";
import { recipeRecordSchema } from "../src/content/schema";
import {
  decodeRecipeSlug,
  validateSafeLocalPath
} from "../src/content/url-path";
import {
  validateNormalizedRecipeDisplayText
} from "../src/content/validation";

test("the production catalog passes the canonical schema", () => {
  const validated = validateCatalog(recipeCatalog);
  const localeCounts = Object.fromEntries(
    ["en", "fr", "ru"].map((locale) => [
      locale,
      validated.filter((record) => record.locale === locale).length
    ])
  );

  assert.equal(validated.length, 519);
  assert.deepEqual(localeCounts, { en: 161, fr: 171, ru: 187 });
  assert.equal(new Set(validated.map((record) => record.id)).size, validated.length);
  assert.equal(
    validated.every((record) => record.schemaVersion === 1 && record.kind === "recipe"),
    true
  );
  assert.doesNotThrow(() => validateNormalizedRecipeDisplayText(validated));

  const authoritative = validated.find((record) => record.id === "wordpress:wprm:21681");
  assert.ok(authoritative);
  assert.equal(authoritative.locale, "en");
  assert.equal(authoritative.slug, "meatballs-soup");
  assert.equal(authoritative.source.recipeId, "21681");
});

test("missing translations remain missing", () => {
  const catalog = validateCatalog([recipeFixture]);

  assert.deepEqual(catalog.map((record) => record.locale), ["en"]);
});

test("the schema rejects dangling media references", () => {
  const invalid = {
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      heroMediaId: "missing"
    }
  };

  assert.throws(() => recipeRecordSchema.parse(invalid), /Unknown media reference/);
});

test("content validation rejects HTML from every normalized recipe display field", () => {
  assert.throws(
    () => validateNormalizedRecipeDisplayText([recipeRecordSchema.parse({
      ...recipeFixture,
      description: "<p>Unnormalized description</p>"
    })]),
    /contains HTML markup/
  );
  assert.throws(
    () => validateNormalizedRecipeDisplayText([recipeRecordSchema.parse({
      ...recipeFixture,
      recipe: {
        ...recipeFixture.recipe,
        instructionGroups: [{
          ...recipeFixture.recipe.instructionGroups[0]!,
          name: "<strong>Unnormalized group</strong>"
        }]
      }
    })]),
    /contains HTML markup/
  );
  assert.doesNotThrow(() => validateNormalizedRecipeDisplayText([recipeRecordSchema.parse({
    ...recipeFixture,
    description: "Normalized description."
  })]));
});

test("recipe slugs reject unsafe encoded path segments and preserve Cyrillic", () => {
  for (const slug of [
    ".",
    "..",
    "%2e",
    "%252e%252e",
    "%25252e%25252e",
    "unsafe/slug",
    "unsafe%2fslug",
    "unsafe%252fslug",
    "unsafe%5cslug",
    "malformed%",
    "malformed%2"
  ]) {
    assert.throws(
      () => recipeRecordSchema.parse({ ...recipeFixture, slug }),
      /unsafe path segment|URL encoding|raw Unicode/
    );
  }

  const cyrillic = recipeRecordSchema.parse({
    ...recipeFixture,
    locale: "ru",
    slug: "суп-с-фрикадельками",
    redirectFrom: []
  });

  assert.equal(cyrillic.slug, "суп-с-фрикадельками");

  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      locale: "ru",
      slug: "%D1%81%D1%83%D0%BF",
      redirectFrom: []
    }),
    /raw Unicode/
  );
});

test("recipe slug boundary decoding accepts Unicode but rejects unsafe layers", () => {
  const encoded = encodeURIComponent("суп-с-фрикадельками");
  assert.equal(decodeRecipeSlug(encoded), "суп-с-фрикадельками");
  assert.equal(decodeRecipeSlug(encodeURIComponent(encoded)), "суп-с-фрикадельками");

  for (const slug of [
    "unsafe/slug",
    "unsafe%2fslug",
    "unsafe%252fslug",
    "%2e%2e",
    "%252e%252e",
    "%3fquery",
    "%20space",
    "%2awildcard",
    "malformed%",
    "literal%25"
  ]) {
    assert.throws(() => decodeRecipeSlug(slug));
  }

  let excessivelyEncoded = "%41";
  for (let index = 0; index < 10; index += 1) {
    excessivelyEncoded = encodeURIComponent(excessivelyEncoded);
  }
  assert.throws(
    () => decodeRecipeSlug(excessivelyEncoded),
    /excessive URL encoding/
  );
});

test("the catalog rejects duplicate localized slugs", () => {
  const duplicate = {
    ...recipeFixture,
    id: "test:recipe:9999",
    source: {
      ...recipeFixture.source,
      recipeId: "9999"
    }
  };

  assert.throws(
    () => validateCatalog([recipeFixture, duplicate]),
    /Duplicate localized slug/
  );
});

test("recipe redirect sources preserve encoded Unicode and reject unsafe paths", () => {
  const source = "/ru/%D1%81%D1%83%D0%BF/";
  const record = recipeRecordSchema.parse({
    ...recipeFixture,
    locale: "ru",
    slug: "суп",
    redirectFrom: [source]
  });

  assert.equal(record.redirectFrom[0], source);
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["//external.example/recipe"]
    }),
    /root-relative/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["https://example.com/recipe"]
    }),
    /root-relative/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/old?source=archive"]
    }),
    /query, fragment/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/%2e%2e/private"]
    }),
    /traversal/
  );
  for (const redirectFrom of [
    "/%252e%252e/private",
    "/%25252e%25252e/private",
    "/%2fprivate",
    "/%252fprivate",
    "/safe%2fprivate",
    "/safe%252fprivate",
    "/%5cprivate",
    "/%255cprivate"
  ]) {
    assert.throws(
      () => recipeRecordSchema.parse({ ...recipeFixture, redirectFrom: [redirectFrom] }),
      /traversal|unsafe separator|unsafe character/
    );
  }
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/malformed%"]
    }),
    /valid URL encoding/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/"]
    }),
    /site root/
  );
});

test("safe local paths inspect repeated encodings and preserve encoded Unicode", () => {
  for (const path of [
    "/%2e%2e/private",
    "/%252e%252e/private",
    "/%25252e%25252e/private",
    "/%2fprivate",
    "/%252fprivate",
    "/safe%2fprivate",
    "/safe%252fprivate",
    "/%5cprivate",
    "/malformed%",
    "/malformed%2"
  ]) {
    assert.throws(() => validateSafeLocalPath(path, "Test path"));
  }

  assert.doesNotThrow(() =>
    validateSafeLocalPath(
      "/ru/%D1%81%D1%83%D0%BF/",
      "Test path"
    )
  );
  assert.doesNotThrow(() => validateSafeLocalPath("/recipe%25", "Test path"));

  let excessivelyEncoded = "%41";
  for (let index = 0; index < 10; index += 1) {
    excessivelyEncoded = encodeURIComponent(excessivelyEncoded);
  }
  assert.throws(
    () => validateSafeLocalPath(`/${excessivelyEncoded}`, "Test path"),
    /excessive URL encoding/
  );
});

test("recipe redirect sources reject duplicates and the canonical route", () => {
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/old", "/old/"]
    }),
    /Duplicate recipe redirect source/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...recipeFixture,
      redirectFrom: ["/recipes/fixture-recipe/"]
    }),
    /canonical recipe route/
  );
});
