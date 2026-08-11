import assert from "node:assert/strict";
import test from "node:test";
import { recipeFixture } from "./fixtures/recipe";
import {
  getRecipeStructuredData,
  serializeRecipeStructuredData
} from "../src/lib/recipe-structured-data";

test("recipe structured data is derived from the validated record", () => {
  const data = getRecipeStructuredData(recipeFixture);

  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "Recipe");
  assert.equal(data.name, "Fixture Recipe");
  assert.equal(data.inLanguage, "en");
  assert.equal(data.url, "https://mycafegourmand.com/recipes/fixture-recipe/");
  assert.equal(data.prepTime, "PT30M");
  assert.equal(data.recipeYield, "5–6 servings");
  assert.equal(data.recipeIngredient[0], "½ lb ground turkey");
  assert.equal(data.recipeInstructions[0]?.["@type"], "HowToStep");
  assert.equal(
    data.recipeInstructions[0]?.image,
    "https://mycafegourmand.com/recipes/fixture-recipe/steps/01.png"
  );
});

test("recipe structured data preserves available source nutrition", () => {
  const data = getRecipeStructuredData({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      nutrition: {
        calories: { raw: "220", value: 220 },
        servingSize: { raw: "1", value: 1 },
        servingUnit: "bowl"
      }
    }
  });

  assert.deepEqual(data.nutrition, {
    "@type": "NutritionInformation",
    calories: "220 calories",
    servingSize: "1 bowl"
  });
});

test("structured nutrition emits only safe nonnegative calorie numbers", () => {
  const withCalories = (calories: { raw: string; value?: number } | null) => ({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      nutrition: {
        calories,
        servingSize: null,
        servingUnit: null
      }
    }
  });

  assert.equal(
    getRecipeStructuredData(withCalories({ raw: "220.50", value: 220.5 })).nutrition?.calories,
    "220.5 calories"
  );
  assert.equal(
    getRecipeStructuredData(withCalories({ raw: "220 calories" })).nutrition,
    undefined
  );
  assert.equal(
    getRecipeStructuredData(withCalories({ raw: "-1" })).nutrition,
    undefined
  );
  assert.equal(getRecipeStructuredData(withCalories(null)).nutrition, undefined);
});

test("structured data serialization escapes script-breaking markup", () => {
  const data = getRecipeStructuredData({
    ...recipeFixture,
    title: "</script><script>alert(1)</script>"
  });

  const serialized = serializeRecipeStructuredData(data);
  assert.equal(serialized.includes("</script>"), false);
  assert.equal(serialized.includes("\\u003c/script>"), true);
});
