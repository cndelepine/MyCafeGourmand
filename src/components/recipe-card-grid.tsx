"use client";

import Image from "next/image";
import Link from "next/link";
import type { RecipeCatalogEntry } from "@/lib/recipe-catalog-data";

type RecipeCardGridProps = {
  readonly recipes: readonly RecipeCatalogEntry[];
  readonly viewRecipe: string;
};

export function RecipeCardGrid({ recipes, viewRecipe }: RecipeCardGridProps) {
  return (
    <div className="recipe-grid">
      {recipes.map((recipe) => (
        <article className="recipe-card" key={recipe.id}>
          {recipe.hero ? (
            <Image
              alt={recipe.hero.alt ?? ""}
              className="recipe-card-image"
              height={recipe.hero.height ?? 592}
              src={recipe.hero.src}
              width={recipe.hero.width ?? 800}
            />
          ) : null}
          <div className="recipe-card-copy">
            {recipe.categories.length > 0 ? (
              <p className="recipe-card-categories">
                {recipe.categories.map((category, index) => (
                  <span key={category.path}>
                    {index > 0 ? <span aria-hidden="true"> · </span> : null}
                    <Link href={category.path}>{category.name}</Link>
                  </span>
                ))}
              </p>
            ) : null}
            <h3>{recipe.title}</h3>
            {recipe.description ? <p>{recipe.description}</p> : null}
            <Link className="jump-link" href={recipe.path}>
              {viewRecipe} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
