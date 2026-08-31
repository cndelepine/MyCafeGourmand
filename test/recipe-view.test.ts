import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecipeView } from "../src/components/recipe-view";
import { createAuthoredRecipeDocument } from "../src/content/authored-recipe";
import {
  normalizeRecipeDocument,
  recipeRecordSchema
} from "../src/content/schema";
import { recipeFixture } from "./fixtures/recipe";

test("static recipe rendering preserves semantic instruction groups and headings", () => {
  const recipe = recipeRecordSchema.parse({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      notes: "Keep covered until serving.",
      equipment: [{
        sourceIndex: 0,
        sourceId: "17",
        name: "Dutch oven",
        amount: "1 large",
        notes: "with a lid"
      }],
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
  assert.match(markup, /id="equipment-title">Equipment<\/h2>/u);
  assert.match(markup, /<li>1 large Dutch oven, with a lid<\/li>/u);
  assert.match(markup, /id="method-title">Method<\/h2>/u);
  assert.match(markup, /id="recipe-notes-title">Notes<\/h2>/u);
  assert.match(markup, /<p>Keep covered until serving\.<\/p>/u);
});

test("authored v2 renders notes and source-neutral equipment", () => {
  const recipe = normalizeRecipeDocument(createAuthoredRecipeDocument({
    locale: "en",
    slug: "authored-extras",
    title: "Authored extras",
    description: null,
    publishedAt: null,
    modifiedAt: null,
    categories: [],
    recipe: {
      notes: "Serve immediately.",
      servings: null,
      equipment: [{
        name: "Mixing bowl",
        amount: null,
        notes: "chilled"
      }],
      times: {
        prep: null,
        cook: null,
        rest: null,
        total: null,
        custom: null
      },
      ingredientGroups: [{
        name: null,
        items: [{
          raw: "1 apple",
          quantity: null,
          name: "apple",
          notes: null
        }]
      }],
      instructionGroups: [{
        name: null,
        steps: [{ text: "Mix." }]
      }]
    },
    seo: null
  }, "119642b8-18b3-42b9-a426-b2be7e42c572", "2026-08-31T00:00:00Z"));
  const markup = renderToStaticMarkup(createElement(RecipeView, {
    catalog: [recipe],
    recipe
  }));

  assert.match(markup, /<li>Mixing bowl, chilled<\/li>/u);
  assert.match(markup, /<p>Serve immediately\.<\/p>/u);
});

test("print styles retain notes and equipment", () => {
  const css = readFileSync(
    path.join(process.cwd(), "src", "app", "globals.css"),
    "utf8"
  );
  const printStyles = css.slice(css.indexOf("@media print"));

  assert.match(
    printStyles,
    /\.equipment, \.recipe-notes \{ break-inside:avoid; padding-bottom:35px; \}/u
  );
  assert.doesNotMatch(
    printStyles,
    /\.equipment[^}]*display:none|\.recipe-notes[^}]*display:none/u
  );
});
