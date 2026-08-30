import assert from "node:assert/strict";
import test from "node:test";
import { recipeFixture } from "./fixtures/recipe";
import { recipeRecordSchema } from "../src/content/schema";
import {
  findRecipeByRoute,
  getEnglishRecipeParams,
  getLocaleHomePath,
  getLocalizedLandingParams,
  getLocalizedRecipeParams,
  getPageLocale,
  getRecipeLanguageAlternates,
  getRecipePath,
  getRecipesByLocale,
  getStaticPageParams,
  isLocalizedLocale
} from "../src/lib/recipe-routes";

test("route generation uses the English root and language prefixes", () => {
  const catalog = [recipeFixture];
  assert.deepEqual(getEnglishRecipeParams(catalog), [
    { slug: "fixture-recipe" }
  ]);
  assert.deepEqual(getLocalizedRecipeParams(catalog), []);
  assert.deepEqual(getLocalizedLandingParams(), [
    { locale: "fr" },
    { locale: "ru" }
  ]);
  assert.equal(getPageLocale(), "en");
  assert.equal(getPageLocale(["fr"]), "fr");
  assert.equal(getPageLocale(["ru", "recipes", "soupe"]), "ru");
  assert.equal(getPageLocale(["de"]), "en");
  assert.deepEqual(getStaticPageParams(catalog), [
    { segments: [] },
    { segments: ["fr"] },
    { segments: ["ru"] },
    { segments: ["recipes", "fixture-recipe"] }
  ]);
  assert.equal(getLocaleHomePath("en"), "/");
  assert.equal(getLocaleHomePath("fr"), "/fr");
  assert.equal(getRecipePath(recipeFixture), "/recipes/fixture-recipe");
});

test("locale lookup rejects unsupported locales and missing records", () => {
  const catalog = [recipeFixture];
  assert.equal(findRecipeByRoute("de", "fixture-recipe", catalog), undefined);
  assert.equal(findRecipeByRoute("en", "does-not-exist", catalog), undefined);
  assert.deepEqual(getRecipesByLocale("de", catalog), []);
  assert.equal(isLocalizedLocale("en"), false);
  assert.equal(isLocalizedLocale("de"), false);
});

test("route generation and lookup encode raw localized slugs once", () => {
  const localized = recipeRecordSchema.parse({
    ...recipeFixture,
    id: "test:recipe:ru",
    locale: "ru",
    slug: "суп-с-фрикадельками",
    source: {
      ...recipeFixture.source,
      recipeId: "2"
    }
  });
  const catalog = [localized];

  assert.equal(
    getRecipePath(localized),
    "/ru/recipes/%D1%81%D1%83%D0%BF-%D1%81-%D1%84%D1%80%D0%B8%D0%BA%D0%B0%D0%B4%D0%B5%D0%BB%D1%8C%D0%BA%D0%B0%D0%BC%D0%B8"
  );
  assert.equal(
    findRecipeByRoute("ru", encodeURIComponent(localized.slug), catalog),
    localized
  );
  assert.deepEqual(getLocalizedRecipeParams(catalog), [
    { locale: "ru", slug: "суп-с-фрикадельками" }
  ]);
  assert.deepEqual(getStaticPageParams(catalog), [
    { segments: [] },
    { segments: ["fr"] },
    { segments: ["ru"] },
    { segments: ["ru", "recipes", "суп-с-фрикадельками"] }
  ]);
  assert.deepEqual(getRecipeLanguageAlternates(localized, catalog), [
    { locale: "ru", path: getRecipePath(localized) }
  ]);
});

test("route generation rejects unsafe slugs even for bypassed records", () => {
  for (const slug of [".", "..", "%252e%252e", "unsafe%252fpath", "malformed%"]) {
    const record = Object.assign({}, recipeFixture, { slug });
    assert.throws(
      () => getRecipePath(record),
      /unsafe path segment|URL encoding|raw Unicode/
    );
    assert.throws(
      () => getStaticPageParams([record]),
      /unsafe path segment|URL encoding|raw Unicode/
    );
  }
});
