import assert from "node:assert/strict";
import test from "node:test";
import { recipeCatalog } from "../src/content/catalog";
import {
  getLandingCopy,
  getLandingMetadata,
  getOpenGraphLocale,
  getRecipeMetadata
} from "../src/lib/site";

const meatballsSoup = recipeCatalog[0]!;

test("locale Open Graph values use region-qualified codes", () => {
  assert.equal(getOpenGraphLocale("en"), "en_US");
  assert.equal(getOpenGraphLocale("fr"), "fr_FR");
  assert.equal(getOpenGraphLocale("ru"), "ru_RU");
});

test("landing and recipe metadata use mapped Open Graph locales", () => {
  const landing = getLandingMetadata("fr");
  const recipe = getRecipeMetadata(meatballsSoup);

  assert.equal(landing.openGraph?.locale, "fr_FR");
  assert.equal(recipe.openGraph?.locale, "en_US");
});

test("landing search controls have localized labels", () => {
  assert.equal(getLandingCopy("en").searchLabel, "Search recipes");
  assert.equal(getLandingCopy("fr").clearSearch, "Effacer");
  assert.equal(getLandingCopy("ru").searchPlaceholder, "Искать по названию, ингредиенту или способу");
});
