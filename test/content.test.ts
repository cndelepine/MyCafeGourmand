import assert from "node:assert/strict";
import test from "node:test";
import { recipeCatalog, validateCatalog } from "../src/content/catalog";
import { recipeRecordSchema } from "../src/content/schema";
import {
  decodeRecipeSlug,
  validateSafeLocalPath
} from "../src/content/url-path";

const meatballsSoup = recipeCatalog[0]!;

test("the production catalog passes the canonical schema", () => {
  const [record] = validateCatalog(recipeCatalog);

  assert.equal(record.id, "wordpress:wprm:2980");
  assert.equal(record.locale, "en");
  assert.equal(record.translationGroupId, null);
  assert.equal(record.source.editorialPostId, null);
  assert.equal(record.taxonomies[0]?.scope, null);
  assert.equal(record.recipe.notes, null);
  assert.equal(record.recipe.times.custom, null);
});

test("missing translations remain missing", () => {
  const catalog = validateCatalog([meatballsSoup]);

  assert.deepEqual(catalog.map((record) => record.locale), ["en"]);
});

test("the schema rejects dangling media references", () => {
  const invalid = {
    ...meatballsSoup,
    recipe: {
      ...meatballsSoup.recipe,
      heroMediaId: "missing"
    }
  };

  assert.throws(() => recipeRecordSchema.parse(invalid), /Unknown media reference/);
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
      () => recipeRecordSchema.parse({ ...meatballsSoup, slug }),
      /unsafe path segment|URL encoding|raw Unicode/
    );
  }

  const cyrillic = recipeRecordSchema.parse({
    ...meatballsSoup,
    locale: "ru",
    slug: "суп-с-фрикадельками",
    redirectFrom: []
  });

  assert.equal(cyrillic.slug, "суп-с-фрикадельками");

  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
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
    ...meatballsSoup,
    id: "wordpress:wprm:9999",
    source: {
      ...meatballsSoup.source,
      recipeId: "9999"
    }
  };

  assert.throws(
    () => validateCatalog([meatballsSoup, duplicate]),
    /Duplicate localized slug/
  );
});

test("recipe redirect sources preserve encoded Unicode and reject unsafe paths", () => {
  const source = "/ru/%D1%81%D1%83%D0%BF/";
  const record = recipeRecordSchema.parse({
    ...meatballsSoup,
    locale: "ru",
    slug: "суп",
    redirectFrom: [source]
  });

  assert.equal(record.redirectFrom[0], source);
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["//external.example/recipe"]
    }),
    /root-relative/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["https://example.com/recipe"]
    }),
    /root-relative/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["/old?source=archive"]
    }),
    /query, fragment/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
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
      () => recipeRecordSchema.parse({ ...meatballsSoup, redirectFrom: [redirectFrom] }),
      /traversal|unsafe separator|unsafe character/
    );
  }
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["/malformed%"]
    }),
    /valid URL encoding/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
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
      ...meatballsSoup,
      redirectFrom: ["/old", "/old/"]
    }),
    /Duplicate recipe redirect source/
  );
  assert.throws(
    () => recipeRecordSchema.parse({
      ...meatballsSoup,
      redirectFrom: ["/recipes/meatballs-soup/"]
    }),
    /canonical recipe route/
  );
});
