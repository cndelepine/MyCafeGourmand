import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecipeView } from "../src/components/recipe-view";
import { recipeRecordSchema } from "../src/content/schema";
import { recipeFixture } from "./fixtures/recipe";

test("static recipe rendering preserves semantic instruction groups and headings", () => {
  const recipe = recipeRecordSchema.parse({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      instructionGroups: [
        {
          name: "Prepare the filling",
          sourceIndex: 0,
          steps: [{
            sourceIndex: 0,
            text: "Mix the ingredients.",
            mediaId: "step-1"
          }]
        },
        {
          name: "Finish and serve",
          sourceIndex: 1,
          steps: [{
            sourceIndex: 1,
            text: "Cook and serve.",
            mediaId: null
          }]
        }
      ]
    }
  });
  const markup = renderToStaticMarkup(createElement(RecipeView, {
    catalog: [recipe],
    recipe
  }));

  assert.match(
    markup,
    /<section aria-labelledby="instruction-group-0-0" class="instruction-group">/u
  );
  assert.match(markup, /<h3 id="instruction-group-0-0">Prepare the filling<\/h3>/u);
  assert.match(markup, /<h3 id="instruction-group-1-1">Finish and serve<\/h3>/u);
  assert.match(markup, /<ol start="1">/u);
  assert.match(markup, /<ol start="2">/u);
  assert.equal((markup.match(/<ol/g) ?? []).length, 2);
  assert.match(markup, /<span>02<\/span><div><p>Cook and serve\.<\/p>/u);
});
