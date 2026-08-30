import Link from "next/link";
import { getCategoryCatalog } from "@/content/categories";
import type { Locale, RecipeRecord } from "@/content/schema";
import { getPageCount, getPaginationPage } from "@/lib/pagination";
import { createRecipeCatalogEntries } from "@/lib/recipe-catalog-data";
import {
  getCategoryPath,
  getLandingPagePath,
  getRecipesByLocale
} from "@/lib/recipe-routes";
import { getLandingCopy } from "@/lib/site";
import { Pagination } from "./pagination";
import { RecipeCatalog } from "./recipe-catalog";
import { SiteHeader } from "./site-header";

type LandingPageProps = {
  readonly catalog: readonly RecipeRecord[];
  readonly locale: Locale;
  readonly page: number;
};

export function LandingPage({ catalog, locale, page }: LandingPageProps) {
  const copy = getLandingCopy(locale);
  const localeRecipes = getRecipesByLocale(locale, catalog);
  const pagination = getPaginationPage(localeRecipes, page);
  if (pagination === undefined && !(page === 1 && localeRecipes.length === 0)) {
    throw new Error(`Invalid landing page ${page} for locale "${locale}".`);
  }
  const categories = getCategoryCatalog(catalog);
  const localeCategories = categories.filter((category) => category.locale === locale);
  const visibleRecipes = pagination?.items ?? [];
  const totalPages = pagination?.totalPages ?? getPageCount(localeRecipes.length);

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

        {localeCategories.length > 0 ? (
          <section className="category-directory" aria-labelledby="category-directory-title">
            <div className="category-directory-heading">
              <p className="eyebrow">{copy.categoryDirectoryEyebrow}</p>
              <h2 id="category-directory-title">{copy.categoryDirectoryTitle}</h2>
            </div>
            <ul>
              {localeCategories.map((category) => (
                <li key={category.identity}>
                  <Link href={getCategoryPath(category)}>{category.name}</Link>
                  <span>{copy.categoryRecipeCount(category.recipes.length)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="catalog" id="recipes" aria-labelledby="catalog-title">
          <div className="catalog-heading">
            <p className="eyebrow">{copy.catalogEyebrow}</p>
            <h2 id="catalog-title">{copy.catalogTitle}</h2>
          </div>
          <RecipeCatalog
            labels={{
              clearSearch: copy.clearSearch,
              emptyCatalog: copy.emptyCatalog,
              loadingSearch: copy.loadingSearch,
              noSearchResults: copy.noSearchResults,
              searchLabel: copy.searchLabel,
              searchPlaceholder: copy.searchPlaceholder,
              searchResults: copy.searchResults,
              searchUnavailable: copy.searchUnavailable,
              viewRecipe: copy.viewRecipe
            }}
            locale={locale}
            recipes={createRecipeCatalogEntries(visibleRecipes, categories)}
            searchIndexPath={`/_search/${locale}.json`}
          />
          <Pagination
            currentPage={page}
            getPagePath={(targetPage) => getLandingPagePath(locale, targetPage)}
            labels={{
              currentPage: copy.currentPage,
              navigation: copy.paginationNavigation,
              next: copy.nextPage,
              previous: copy.previousPage
            }}
            totalPages={totalPages}
          />
        </section>
      </main>
      <footer lang={locale}>{copy.footer}</footer>
    </>
  );
}
