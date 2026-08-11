import assert from "node:assert/strict";
import test from "node:test";
import { createRecipeCatalogEntries } from "../src/lib/recipe-catalog-data";
import { recipeRecordSchema } from "../src/content/schema";
import { recipeFixture } from "./fixtures/recipe";

test("client catalog data resolves promoted media before Flight serialization", () => {
  const previous = process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL;
  process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL =
    "https://media.example.test/recipe-container";
  try {
    const recipe = recipeRecordSchema.parse({
      ...recipeFixture,
      recipe: {
        ...recipeFixture.recipe,
        heroMediaId: "wordpress-attachment:900",
        instructionGroups: recipeFixture.recipe.instructionGroups.map((group) => ({
          ...group,
          steps: group.steps.map((step) => ({ ...step, mediaId: null }))
        }))
      },
      media: [{
        ...recipeFixture.media[0]!,
        id: "wordpress-attachment:900",
        sourceId: "900",
        path: "/recipes/media/wordpress/900.jpg"
      }]
    });
    const entries = createRecipeCatalogEntries([recipe]);
    assert.equal(
      entries[0]?.hero?.src,
      "https://media.example.test/recipe-container/recipes/media/wordpress/900.jpg"
    );
    assert.equal(
      JSON.stringify(entries).includes("\"path\":\"/recipes/media/wordpress/"),
      false
    );
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL = previous;
    }
  }
});
