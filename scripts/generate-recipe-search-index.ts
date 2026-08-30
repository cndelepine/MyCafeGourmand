#!/usr/bin/env node

import {
  mkdirSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCategoryCatalog } from "../src/content/categories";
import { recipeCatalog } from "../src/content/catalog";
import { type Locale, localeValues, type RecipeRecord } from "../src/content/schema";
import { createRecipeCatalogEntries } from "../src/lib/recipe-catalog-data";
import {
  createRecipeSearchIndex,
  serializeRecipeSearchIndex
} from "../src/lib/recipe-search-index";
import { getRecipesByLocale } from "../src/lib/recipe-routes";

export type RecipeSearchIndexOutput = {
  readonly bytes: Readonly<Record<Locale, number>>;
  readonly entries: Readonly<Record<Locale, number>>;
  readonly outputDirectory: string;
};

export function generateRecipeSearchIndexes(
  catalog: readonly RecipeRecord[] = recipeCatalog,
  outputDirectory = path.resolve(process.cwd(), "public/_search")
): RecipeSearchIndexOutput {
  const categories = getCategoryCatalog(catalog);
  const directory = path.resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const bytes: Record<Locale, number> = { en: 0, fr: 0, ru: 0 };
  const entries: Record<Locale, number> = { en: 0, fr: 0, ru: 0 };

  for (const locale of localeValues) {
    const recipes = createRecipeCatalogEntries(
      getRecipesByLocale(locale, catalog),
      categories
    );
    const serialized = serializeRecipeSearchIndex(
      createRecipeSearchIndex(locale, recipes)
    );
    writeFileSync(path.join(directory, `${locale}.json`), serialized, "utf8");
    bytes[locale] = new TextEncoder().encode(serialized).byteLength;
    entries[locale] = recipes.length;
  }

  return {
    bytes,
    entries,
    outputDirectory: directory
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("Recipe search index generation does not accept arguments.");
    }
    const result = generateRecipeSearchIndexes();
    console.log(
      `Generated ${result.entries.en + result.entries.fr + result.entries.ru} ` +
      `recipe search index entries in ${result.outputDirectory}.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
