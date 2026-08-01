import assert from "node:assert/strict";
import test from "node:test";
import { recipeCatalog } from "../src/content/catalog";
import {
  formatIngredient,
  formatQuantity,
  scaleQuantity
} from "../src/lib/scale-quantity";

const meatballsSoup = recipeCatalog[0]!;

test("scales parsed values while preserving the source text", () => {
  const scaled = scaleQuantity({
    raw: "1 1/2 cups",
    value: 1.5,
    unit: "cups",
    scalable: true
  }, 2);

  assert.equal(scaled.raw, "1 1/2 cups");
  assert.equal(scaled.value, 3);
});

test("does not alter quantities that were not safely parsed", () => {
  const quantity = {
    raw: "salt to taste",
    unit: null,
    scalable: false
  } as const;

  assert.equal(scaleQuantity(quantity, 3), quantity);
});

test("rejects invalid scale factors", () => {
  assert.throws(
    () => scaleQuantity({ raw: "1 cup", value: 1, unit: "cup", scalable: true }, 0),
    /positive finite/
  );
  assert.throws(
    () => formatQuantity({ raw: "1 cup", value: 1, unit: "cup", scalable: true }, Number.NaN),
    /positive finite/
  );
});

test("keeps every original ingredient and yield string at 1x", () => {
  const items = meatballsSoup.recipe.ingredientGroups.flatMap(
    (group) => group.items
  );

  assert.deepEqual(
    items.map((item) => formatIngredient(item, 1)),
    items.map((item) => item.raw)
  );
  assert.equal(
    formatQuantity(meatballsSoup.recipe.servings!, 1),
    "5–6 servings"
  );
});

test("scales parsed ingredients while retaining notes and leaves unparsed items alone", () => {
  const items = meatballsSoup.recipe.ingredientGroups.flatMap(
    (group) => group.items
  );

  assert.equal(formatIngredient(items[0]!, 2), "1 lb ground turkey");
  assert.equal(formatIngredient(items[2]!, 2), "1 onion, finely diced");
  assert.equal(formatIngredient(items[2]!, 3), "1 ½ onions, finely diced");
  assert.equal(formatIngredient(items[3]!, 3), "Salt, to taste");
  assert.equal(formatIngredient(items[5]!, 3), "3 Tbsp chicken bouillon paste (optional)");
  assert.equal(formatIngredient(items[10]!, 2), "2 large carrots, shredded");
});

test("formats mixed fractions and ranges without changing raw quantities", () => {
  const mixed = {
    raw: "1 1/2 cups",
    value: 1.5,
    unit: "cups",
    scalable: true
  } as const;

  assert.equal(formatQuantity(mixed, 2), "3 cups");
  assert.equal(formatQuantity(mixed, 3), "4 ½ cups");
  assert.equal(
    formatQuantity(meatballsSoup.recipe.servings!, 2),
    "10–12 servings"
  );
  assert.equal(
    formatQuantity(meatballsSoup.recipe.servings!, 3),
    "15–18 servings"
  );
  assert.equal(mixed.raw, "1 1/2 cups");
});
