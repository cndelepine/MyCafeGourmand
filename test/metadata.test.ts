import assert from "node:assert/strict";
import test from "node:test";
import { recipeFixture } from "./fixtures/recipe";
import { recipeRecordSchema } from "../src/content/schema";
import {
  getLandingCopy,
  getLandingMetadata,
  getOpenGraphLocale,
  getRecipeMetadata
} from "../src/lib/site";

test("locale Open Graph values use region-qualified codes", () => {
  assert.equal(getOpenGraphLocale("en"), "en_US");
  assert.equal(getOpenGraphLocale("fr"), "fr_FR");
  assert.equal(getOpenGraphLocale("ru"), "ru_RU");
});

test("landing and recipe metadata use mapped Open Graph locales", () => {
  const landing = getLandingMetadata("fr");
  const recipe = getRecipeMetadata(recipeFixture);

  assert.equal(landing.openGraph?.locale, "fr_FR");
  assert.equal(recipe.openGraph?.locale, "en_US");
});

test("canonical metadata URLs encode raw Unicode slugs once", () => {
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
  const canonical =
    "https://mycafegourmand.com/ru/recipes/" +
    "%D1%81%D1%83%D0%BF-%D1%81-%D1%84%D1%80%D0%B8%D0%BA%D0%B0%D0%B4%D0%B5%D0%BB%D1%8C%D0%BA%D0%B0%D0%BC%D0%B8/";
  const metadata = getRecipeMetadata(localized, [localized]);

  assert.equal(metadata.alternates?.canonical, canonical);
  assert.equal(metadata.openGraph?.url, canonical);
});

test("landing search controls have localized labels", () => {
  assert.equal(getLandingCopy("en").searchLabel, "Search recipes");
  assert.equal(getLandingCopy("fr").clearSearch, "Effacer");
  assert.equal(getLandingCopy("ru").searchPlaceholder, "Искать по названию, ингредиенту или способу");
});
