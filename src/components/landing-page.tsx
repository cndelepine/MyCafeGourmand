import Image from "next/image";
import Link from "next/link";
import type { Locale, RecipeRecord } from "@/content/schema";
import { getRecipePath } from "@/lib/recipe-routes";
import { getLandingCopy } from "@/lib/site";
import { SiteHeader } from "./site-header";

type LandingPageProps = {
  locale: Locale;
  recipes: readonly RecipeRecord[];
};

export function LandingPage({ locale, recipes }: LandingPageProps) {
  const copy = getLandingCopy(locale);

  return (
    <>
      <SiteHeader locale={locale} page="landing" />
      <main lang={locale}>
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p className="intro">{copy.description}</p>
          </div>
        </section>

        <section className="catalog" id="recipes" aria-labelledby="catalog-title">
          <div className="catalog-heading">
            <p className="eyebrow">{copy.catalogEyebrow}</p>
            <h2 id="catalog-title">{copy.catalogTitle}</h2>
          </div>
          {recipes.length > 0 ? (
            <div className="recipe-grid">
              {recipes.map((recipe) => {
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
                        {copy.viewRecipe} <span aria-hidden="true">→</span>
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="empty-catalog">{copy.emptyCatalog}</p>
          )}
        </section>
      </main>
      <footer lang={locale}>{copy.footer}</footer>
    </>
  );
}
