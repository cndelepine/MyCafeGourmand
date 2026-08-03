import type { RecipeRecord } from "@/content/schema";

/**
 * Normalize human-entered search text without transliterating non-Latin scripts.
 * NFKD separates accents from their base characters; removing only combining
 * marks makes "crème" match "creme" while leaving Cyrillic intact.
 */
export function normalizeSearchText(value: string) {
  return value
    .replaceAll("œ", "oe")
    .replaceAll("Œ", "OE")
    .replaceAll("æ", "ae")
    .replaceAll("Æ", "AE")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function getRecipeSearchText(record: RecipeRecord) {
  return normalizeSearchText([
    record.title,
    record.description ?? "",
    ...record.taxonomies.flatMap((taxonomy) => [
      taxonomy.taxonomy,
      taxonomy.name,
      taxonomy.slug
    ]),
    ...record.recipe.ingredientGroups.flatMap((group) => [
      group.name ?? "",
      ...group.items.flatMap((item) => [
        item.raw,
        item.name,
        item.pluralName ?? "",
        item.notes ?? ""
      ])
    ]),
    ...record.recipe.instructionGroups.flatMap((group) => [
      group.name ?? "",
      ...group.steps.map((step) => step.text)
    ])
  ].join(" "));
}

export function recipeMatchesQuery(record: RecipeRecord, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return true;
  }

  const searchableText = getRecipeSearchText(record);
  return normalizedQuery
    .split(" ")
    .every((term) => searchableText.includes(term));
}

export function searchRecipes(
  recipes: readonly RecipeRecord[],
  query: string
) {
  return recipes.filter((recipe) => recipeMatchesQuery(recipe, query));
}
