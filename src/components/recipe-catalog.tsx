"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import type { Locale, RecipeRecord } from "@/content/schema";
import { searchRecipes } from "@/lib/recipe-search";
import { getRecipePath } from "@/lib/recipe-routes";

type RecipeCatalogLabels = {
  clearSearch: string;
  emptyCatalog: string;
  noSearchResults: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchResults: string;
  viewRecipe: string;
};

type RecipeCatalogProps = {
  labels: RecipeCatalogLabels;
  locale: Locale;
  recipes: readonly RecipeRecord[];
};

export function RecipeCatalog({
  labels,
  locale,
  recipes
}: RecipeCatalogProps) {
  const [query, setQuery] = useState("");
  const localeRecipes = recipes.filter((recipe) => recipe.locale === locale);
  const matchingRecipes = searchRecipes(localeRecipes, query);
  const searchId = `recipe-search-${locale}`;
  const statusId = `${searchId}-status`;

  return (
    <>
      <form
        className="catalog-search"
        onReset={(event) => {
          event.preventDefault();
          setQuery("");
        }}
        onSubmit={(event) => event.preventDefault()}
        role="search"
      >
        <label htmlFor={searchId}>{labels.searchLabel}</label>
        <div className="catalog-search-row">
          <input
            aria-describedby={statusId}
            id={searchId}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.searchPlaceholder}
            type="search"
            value={query}
          />
          <button type="reset">{labels.clearSearch}</button>
        </div>
      </form>

      <p aria-live="polite" className="search-status" id={statusId}>
        {matchingRecipes.length} {labels.searchResults}
      </p>

      {matchingRecipes.length > 0 ? (
        <div className="recipe-grid">
          {matchingRecipes.map((recipe) => {
            const hero = recipe.recipe.heroMediaId
              ? recipe.media.find(
                  (asset) => asset.id === recipe.recipe.heroMediaId
                )
              : undefined;
            const category = recipe.taxonomies.find(
              (taxonomy) => taxonomy.taxonomy === "category"
            );

            return (
              <article className="recipe-card" key={recipe.id}>
                {hero ? (
                  <Image
                    alt={hero.alt ?? ""}
                    className="recipe-card-image"
                    height={hero.height ?? 592}
                    src={hero.path}
                    width={hero.width ?? 800}
                  />
                ) : null}
                <div className="recipe-card-copy">
                  {category ? (
                    <p className="eyebrow">{category.name}</p>
                  ) : null}
                  <h3>{recipe.title}</h3>
                  {recipe.description ? <p>{recipe.description}</p> : null}
                  <Link className="jump-link" href={getRecipePath(recipe)}>
                    {labels.viewRecipe} <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="empty-catalog">
          {query.trim().length > 0
            ? labels.noSearchResults
            : labels.emptyCatalog}
        </p>
      )}
    </>
  );
}
