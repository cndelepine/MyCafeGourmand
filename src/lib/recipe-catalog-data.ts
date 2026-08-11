import type { Locale, RecipeRecord } from "@/content/schema";
import { resolveRecipeMediaUrl } from "./recipe-media";
import { getRecipePath } from "./recipe-routes";
import { getRecipeSearchText, normalizeSearchText } from "./recipe-search";

export type RecipeCatalogEntry = {
  readonly category: string | null;
  readonly description: string | null;
  readonly hero: {
    readonly alt: string | null;
    readonly height: number | null;
    readonly src: string;
    readonly width: number | null;
  } | null;
  readonly id: string;
  readonly locale: Locale;
  readonly path: string;
  readonly searchText: string;
  readonly title: string;
};

export function createRecipeCatalogEntries(
  recipes: readonly RecipeRecord[]
): readonly RecipeCatalogEntry[] {
  return recipes.map((recipe) => {
    const hero = recipe.recipe.heroMediaId === null
      ? undefined
      : recipe.media.find((asset) => asset.id === recipe.recipe.heroMediaId);
    const category = recipe.taxonomies.find(
      (taxonomy) => taxonomy.taxonomy === "category"
    );
    return {
      category: category?.name ?? null,
      description: recipe.description,
      hero: hero === undefined
        ? null
        : {
          alt: hero.alt,
          height: hero.height,
          src: resolveRecipeMediaUrl(hero.path),
          width: hero.width
        },
      id: recipe.id,
      locale: recipe.locale,
      path: getRecipePath(recipe),
      searchText: getRecipeSearchText(recipe),
      title: recipe.title
    };
  });
}

export function searchRecipeCatalogEntries(
  recipes: readonly RecipeCatalogEntry[],
  query: string
) {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) {
    return recipes;
  }
  return recipes.filter((recipe) =>
    normalizedQuery
      .split(" ")
      .every((term) => recipe.searchText.includes(term))
  );
}
