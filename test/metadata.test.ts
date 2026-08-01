import assert from "node:assert/strict";
import test from "node:test";
import { meatballsSoup } from "../src/content/recipes/meatballs-soup";
import {
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
  const recipe = getRecipeMetadata(meatballsSoup);

  assert.equal(landing.openGraph?.locale, "fr_FR");
  assert.equal(recipe.openGraph?.locale, "en_US");
});
