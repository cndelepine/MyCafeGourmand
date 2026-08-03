import assert from "node:assert/strict";
import test from "node:test";
import { recipeCatalog } from "../src/content/catalog";
import {
  getRecipeStructuredData,
  serializeRecipeStructuredData
} from "../src/lib/recipe-structured-data";

const meatballsSoup = recipeCatalog[0]!;

test("recipe structured data is derived from the validated record", () => {
  const data = getRecipeStructuredData(meatballsSoup);

  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "Recipe");
  assert.equal(data.name, "Meatballs Soup");
  assert.equal(data.inLanguage, "en");
  assert.equal(data.url, "https://mycafegourmand.com/recipes/meatballs-soup/");
  assert.equal(data.prepTime, "PT30M");
  assert.equal(data.recipeYield, "5–6 servings");
  assert.equal(data.recipeIngredient[0], "½ lb ground turkey");
  assert.equal(data.recipeInstructions[0]?.["@type"], "HowToStep");
  assert.equal(
    data.recipeInstructions[0]?.image,
    "https://mycafegourmand.com/recipes/meatballs-soup/steps/01-meatball-mix.png"
  );
});

test("structured data serialization escapes script-breaking markup", () => {
  const data = getRecipeStructuredData({
    ...meatballsSoup,
    title: "</script><script>alert(1)</script>"
  });

  const serialized = serializeRecipeStructuredData(data);
  assert.equal(serialized.includes("</script>"), false);
  assert.equal(serialized.includes("\\u003c/script>"), true);
});
