import type { Locale } from "@/content/schema";
import { validateSafeLocalPath } from "@/content/url-path";
import type {
  RecipeCatalogCategory,
  RecipeCatalogEntry
} from "./recipe-catalog-data";

export const recipeSearchIndexSchemaVersion = 1;
export const maxRecipeSearchIndexBytes = 4 * 1024 * 1024;
export const maxRecipeSearchIndexEntries = 2_000;

export type RecipeSearchIndex = {
  readonly locale: Locale;
  readonly recipes: readonly RecipeCatalogEntry[];
  readonly schemaVersion: typeof recipeSearchIndexSchemaVersion;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeLocalPath(value: unknown) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    validateSafeLocalPath(value, "Recipe search index path");
    return true;
  } catch {
    return false;
  }
}

function isSafeImageSource(value: unknown) {
  if (isSafeLocalPath(value)) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function isNullableText(value: unknown) {
  return value === null || typeof value === "string";
}

function isNullablePositiveInteger(value: unknown) {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isRecipeCatalogCategory(value: unknown): value is RecipeCatalogCategory {
  return isRecord(value)
    && typeof value.name === "string"
    && value.name.length > 0
    && isSafeLocalPath(value.path);
}

function isRecipeCatalogEntry(
  value: unknown,
  locale: Locale
): value is RecipeCatalogEntry {
  if (
    !isRecord(value)
    || !Array.isArray(value.categories)
    || !value.categories.every(isRecipeCatalogCategory)
    || !isNullableText(value.description)
    || typeof value.id !== "string"
    || value.id.length === 0
    || value.locale !== locale
    || !isSafeLocalPath(value.path)
    || typeof value.searchText !== "string"
    || typeof value.title !== "string"
    || value.title.length === 0
  ) {
    return false;
  }
  if (value.hero === null) {
    return true;
  }
  return isRecord(value.hero)
    && isNullableText(value.hero.alt)
    && isNullablePositiveInteger(value.hero.height)
    && isSafeImageSource(value.hero.src)
    && isNullablePositiveInteger(value.hero.width);
}

export function createRecipeSearchIndex(
  locale: Locale,
  recipes: readonly RecipeCatalogEntry[]
): RecipeSearchIndex {
  if (recipes.length > maxRecipeSearchIndexEntries) {
    throw new Error(
      `Recipe search index exceeds ${maxRecipeSearchIndexEntries} entries for locale "${locale}".`
    );
  }
  if (!recipes.every((recipe) => recipe.locale === locale)) {
    throw new Error(`Recipe search index includes another locale for "${locale}".`);
  }
  return {
    locale,
    recipes,
    schemaVersion: recipeSearchIndexSchemaVersion
  };
}

export function serializeRecipeSearchIndex(index: RecipeSearchIndex) {
  const serialized = `${JSON.stringify(index)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > maxRecipeSearchIndexBytes) {
    throw new Error(
      `Recipe search index exceeds ${maxRecipeSearchIndexBytes} bytes for locale "${index.locale}".`
    );
  }
  return serialized;
}

export function parseRecipeSearchIndex(
  value: unknown,
  locale: Locale
): RecipeSearchIndex | undefined {
  if (
    !isRecord(value)
    || value.schemaVersion !== recipeSearchIndexSchemaVersion
    || value.locale !== locale
    || !Array.isArray(value.recipes)
    || value.recipes.length > maxRecipeSearchIndexEntries
    || !value.recipes.every((recipe) => isRecipeCatalogEntry(recipe, locale))
  ) {
    return undefined;
  }
  return {
    locale,
    recipes: value.recipes,
    schemaVersion: recipeSearchIndexSchemaVersion
  };
}
