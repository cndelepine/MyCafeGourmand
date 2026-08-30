"use client";

import { useEffect, useState } from "react";
import type { Locale } from "@/content/schema";
import {
  searchRecipeCatalogEntries,
  type RecipeCatalogEntry
} from "@/lib/recipe-catalog-data";
import { parseRecipeSearchIndex } from "@/lib/recipe-search-index";
import { RecipeCardGrid } from "./recipe-card-grid";

type RecipeCatalogLabels = {
  readonly clearSearch: string;
  readonly emptyCatalog: string;
  readonly loadingSearch: string;
  readonly noSearchResults: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly searchResults: string;
  readonly searchUnavailable: string;
  readonly viewRecipe: string;
};

type RecipeCatalogProps = {
  readonly labels: RecipeCatalogLabels;
  readonly locale: Locale;
  readonly recipes: readonly RecipeCatalogEntry[];
  readonly searchIndexPath: string;
};

export function RecipeCatalog({
  labels,
  locale,
  recipes,
  searchIndexPath
}: RecipeCatalogProps) {
  const [query, setQuery] = useState("");
  const [searchRecipes, setSearchRecipes] = useState<readonly RecipeCatalogEntry[]>();
  const [searchFailed, setSearchFailed] = useState(false);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!searching || searchRecipes !== undefined || searchFailed) {
      return;
    }
    const controller = new AbortController();

    void fetch(searchIndexPath, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Recipe search index request failed.");
        }
        const payload: unknown = await response.json();
        const index = parseRecipeSearchIndex(payload, locale);
        if (index === undefined) {
          throw new Error("Recipe search index is invalid.");
        }
        if (!controller.signal.aborted) {
          setSearchRecipes(index.recipes);
        }
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted
          && !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setSearchFailed(true);
        }
      });

    return () => controller.abort();
  }, [locale, searchFailed, searchIndexPath, searchRecipes, searching]);

  const matchingRecipes = searching && searchRecipes !== undefined
    ? searchRecipeCatalogEntries(searchRecipes, query)
    : searching
      ? []
      : recipes;
  const searchId = `recipe-search-${locale}`;
  const statusId = `${searchId}-status`;
  const status = searchFailed
    ? labels.searchUnavailable
    : searching && searchRecipes === undefined
      ? labels.loadingSearch
      : `${matchingRecipes.length} ${labels.searchResults}`;

  return (
    <>
      <form
        className="catalog-search"
        onReset={(event) => {
          event.preventDefault();
          setQuery("");
          setSearchFailed(false);
        }}
        onSubmit={(event) => event.preventDefault()}
        role="search"
      >
        <label htmlFor={searchId}>{labels.searchLabel}</label>
        <div className="catalog-search-row">
          <input
            aria-describedby={statusId}
            id={searchId}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchFailed(false);
            }}
            placeholder={labels.searchPlaceholder}
            type="search"
            value={query}
          />
          <button type="reset">{labels.clearSearch}</button>
        </div>
      </form>

      <p aria-live="polite" className="search-status" id={statusId}>
        {status}
      </p>

      {matchingRecipes.length > 0 ? (
        <RecipeCardGrid recipes={matchingRecipes} viewRecipe={labels.viewRecipe} />
      ) : (
        <p className="empty-catalog">
          {searchFailed
            ? labels.searchUnavailable
            : searching
              ? labels.noSearchResults
              : labels.emptyCatalog}
        </p>
      )}
    </>
  );
}
