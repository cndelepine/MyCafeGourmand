import assert from "node:assert/strict";
import test from "node:test";
import { meatballsSoup } from "../src/content/recipes/meatballs-soup";
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
  assert.deepEqual(getEnglishRecipeParams([meatballsSoup]), [
    { slug: "meatballs-soup" }
  ]);
  assert.deepEqual(getLocalizedRecipeParams([meatballsSoup]), []);
  assert.deepEqual(getLocalizedLandingParams(), [
    { locale: "fr" },
    { locale: "ru" }
  ]);
  assert.equal(getPageLocale(), "en");
  assert.equal(getPageLocale(["fr"]), "fr");
  assert.equal(getPageLocale(["ru", "recipes", "soupe"]), "ru");
  assert.equal(getPageLocale(["de"]), "en");
  assert.deepEqual(getStaticPageParams([meatballsSoup]), [
    { segments: [] },
    { segments: ["fr"] },
    { segments: ["ru"] },
    { segments: ["recipes", "meatballs-soup"] }
  ]);
  assert.equal(getLocaleHomePath("en"), "/");
  assert.equal(getLocaleHomePath("fr"), "/fr");
  assert.equal(getRecipePath(meatballsSoup), "/recipes/meatballs-soup");
});

test("locale lookup rejects unsupported locales and missing records", () => {
  assert.equal(findRecipeByRoute("de", "meatballs-soup"), undefined);
  assert.equal(findRecipeByRoute("en", "does-not-exist"), undefined);
  assert.deepEqual(getRecipesByLocale("de"), []);
  assert.equal(isLocalizedLocale("en"), false);
  assert.equal(isLocalizedLocale("de"), false);
});

test("route generation and lookup preserve encoded localized slugs", () => {
  const localized = recipeRecordSchema.parse({
    ...meatballsSoup,
    id: "wordpress:wprm:2981",
    locale: "ru",
    slug: "суп-с-фрикадельками",
    source: {
      ...meatballsSoup.source,
      recipeId: "2981"
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
  assert.deepEqual(getRecipeLanguageAlternates(localized, catalog), [
    { locale: "ru", path: getRecipePath(localized) }
  ]);
});
