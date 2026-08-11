import type { Locale, RecipeRecord } from "@/content/schema";
import { createRecipeCatalogEntries } from "@/lib/recipe-catalog-data";
import { getLandingCopy } from "@/lib/site";
import { RecipeCatalog } from "./recipe-catalog";
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
          <RecipeCatalog
            labels={{
              clearSearch: copy.clearSearch,
              emptyCatalog: copy.emptyCatalog,
              noSearchResults: copy.noSearchResults,
              searchLabel: copy.searchLabel,
              searchPlaceholder: copy.searchPlaceholder,
              searchResults: copy.searchResults,
              viewRecipe: copy.viewRecipe
            }}
            locale={locale}
            recipes={createRecipeCatalogEntries(recipes)}
          />
        </section>
      </main>
      <footer lang={locale}>{copy.footer}</footer>
    </>
  );
}
