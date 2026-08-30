import type { Locale, RecipeRecord } from "@/content/schema";
import {
  getCategoryCatalog,
  getRecipeCategories,
  type RecipeCategory
} from "@/content/categories";
import { resolveRecipeMediaUrl } from "./recipe-media";
import { getCategoryPath, getRecipePath } from "./recipe-routes";
import { getRecipeSearchText, normalizeSearchText } from "./recipe-search";

export type RecipeCatalogCategory = {
  readonly name: string;
  readonly path: string;
};

export type RecipeCatalogEntry = {
  readonly categories: readonly RecipeCatalogCategory[];
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
  recipes: readonly RecipeRecord[],
  categories: readonly RecipeCategory[] = getCategoryCatalog(recipes)
): readonly RecipeCatalogEntry[] {
  return recipes.map((recipe) => {
    const hero = recipe.recipe.heroMediaId === null
      ? undefined
      : recipe.media.find((asset) => asset.id === recipe.recipe.heroMediaId);
    return {
      categories: getRecipeCategories(recipe, categories).map((category) => ({
        name: category.name,
        path: getCategoryPath(category)
      })),
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
