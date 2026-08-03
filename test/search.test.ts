import assert from "node:assert/strict";
import test from "node:test";
import { recipeCatalog } from "../src/content/catalog";
import { recipeRecordSchema } from "../src/content/schema";
import {
  normalizeSearchText,
  recipeMatchesQuery,
  searchRecipes
} from "../src/lib/recipe-search";

const meatballsSoup = recipeCatalog[0]!;

const frenchRecipe = recipeRecordSchema.parse({
  ...meatballsSoup,
  id: "wordpress:wprm:2981",
  locale: "fr",
  slug: "soupe-a-la-creme",
  source: {
    ...meatballsSoup.source,
    recipeId: "2981"
  },
  title: "Soupe à la crème",
  description: "Une soupe fraîche et réconfortante.",
  taxonomies: [
    {
      taxonomy: "category",
      sourceId: null,
      name: "Déjeuners",
      slug: "dejeuners"
    }
  ],
  recipe: {
    ...meatballsSoup.recipe,
    ingredientGroups: [
      {
        ...meatballsSoup.recipe.ingredientGroups[0],
        items: [
          {
            ...meatballsSoup.recipe.ingredientGroups[0].items[0],
            raw: "2 cuillères de crème fraîche",
            quantity: null,
            name: "crème fraîche",
            notes: null
          }
        ]
      }
    ],
    instructionGroups: [
      {
        ...meatballsSoup.recipe.instructionGroups[0],
        steps: [
          {
            ...meatballsSoup.recipe.instructionGroups[0].steps[0],
            text: "Émincer les légumes et laisser frémir la soupe."
          }
        ]
      }
    ]
  }
});

const russianRecipe = recipeRecordSchema.parse({
  ...meatballsSoup,
  id: "wordpress:wprm:2982",
  locale: "ru",
  slug: "sup-s-frikadelkami",
  source: {
    ...meatballsSoup.source,
    recipeId: "2982"
  },
  title: "Суп с фрикадельками",
  description: "Тёплый домашний суп.",
  taxonomies: [
    {
      taxonomy: "category",
      sourceId: null,
      name: "Супы",
      slug: "supy"
    }
  ],
  recipe: {
    ...meatballsSoup.recipe,
    ingredientGroups: [
      {
        ...meatballsSoup.recipe.ingredientGroups[0],
        items: [
          {
            ...meatballsSoup.recipe.ingredientGroups[0].items[0],
            raw: "500 г говядины",
            quantity: null,
            name: "говядины",
            notes: null
          }
        ]
      }
    ],
    instructionGroups: [
      {
        ...meatballsSoup.recipe.instructionGroups[0],
        steps: [
          {
            ...meatballsSoup.recipe.instructionGroups[0].steps[0],
            text: "Добавьте фрикадельки и варите суп."
          }
        ]
      }
    ]
  }
});

test("search normalization removes Latin diacritics but preserves Cyrillic", () => {
  assert.equal(normalizeSearchText("Crème fraîche"), "creme fraiche");
  assert.equal(normalizeSearchText("Œufs et cæur"), "oeufs et caeur");
  assert.equal(normalizeSearchText("ФРИКАДЕЛЬКИ"), "фрикадельки");
});

test("search matches localized titles, taxonomies, ingredients, and instructions", () => {
  assert.equal(recipeMatchesQuery(frenchRecipe, "CREME"), true);
  assert.equal(recipeMatchesQuery(frenchRecipe, "déjeuners"), true);
  assert.equal(recipeMatchesQuery(frenchRecipe, "ÉMINCER"), true);
  assert.equal(
    recipeMatchesQuery({ ...frenchRecipe, title: "Omelette aux œufs" }, "oeufs"),
    true
  );
  assert.equal(recipeMatchesQuery(russianRecipe, "Фрикадельки"), true);
  assert.equal(recipeMatchesQuery(russianRecipe, "говядины"), true);
  assert.deepEqual(searchRecipes([frenchRecipe, russianRecipe], "суп"), [
    russianRecipe
  ]);
});

test("search includes authored scaled ingredient names", () => {
  assert.equal(recipeMatchesQuery(meatballsSoup, "carrots"), true);
  assert.equal(recipeMatchesQuery(meatballsSoup, "onions"), true);
});
