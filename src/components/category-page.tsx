import Link from "next/link";
import {
  getCategoryCatalog,
  type RecipeCategory
} from "@/content/categories";
import type { RecipeRecord } from "@/content/schema";
import {
  getCategoryBreadcrumbStructuredData,
  serializeCategoryStructuredData
} from "@/lib/category-structured-data";
import { getPageCount, getPaginationPage } from "@/lib/pagination";
import { createRecipeCatalogEntries } from "@/lib/recipe-catalog-data";
import {
  getCategoryPagePath,
  getCategoryPath,
  getLocaleHomePath
} from "@/lib/recipe-routes";
import { getLandingCopy } from "@/lib/site";
import { Pagination } from "./pagination";
import { RecipeCardGrid } from "./recipe-card-grid";
import { SiteHeader } from "./site-header";

type CategoryPageProps = {
  readonly catalog: readonly RecipeRecord[];
  readonly category: RecipeCategory;
  readonly page: number;
};

export function CategoryPage({ catalog, category, page }: CategoryPageProps) {
  const copy = getLandingCopy(category.locale);
  const pagination = getPaginationPage(category.recipes, page);
  if (pagination === undefined) {
    throw new Error(`Invalid category page ${page} for "${category.identity}".`);
  }
  const structuredData = getCategoryBreadcrumbStructuredData(category, page, {
    home: copy.backToCatalog,
    page: (value) => copy.currentPage(value, pagination.totalPages)
  });
  const categories = getCategoryCatalog(catalog);

  return (
    <>
      <SiteHeader locale={category.locale} page="landing" />
      <main lang={category.locale}>
        <nav aria-label={copy.categoryDirectoryEyebrow} className="breadcrumbs">
          <ol>
            <li>
              <Link href={getLocaleHomePath(category.locale)}>{copy.backToCatalog}</Link>
            </li>
            {page > 1 ? (
              <li>
                <Link href={getCategoryPath(category)}>{category.name}</Link>
              </li>
            ) : null}
            <li aria-current="page">
              {page > 1 ? copy.currentPage(page, pagination.totalPages) : category.name}
            </li>
          </ol>
        </nav>

        <section className="archive-hero">
          <div className="archive-hero-copy">
            <p className="eyebrow">{copy.categoryArchiveEyebrow}</p>
            <h1>{category.name}</h1>
            <p className="intro">
              {copy.categoryDescription(category.name, category.recipes.length)}
            </p>
            <Link className="jump-link" href={getLocaleHomePath(category.locale)}>
              {copy.backToCatalog} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>

        <section className="catalog" id="recipes" aria-labelledby="category-recipes-title">
          <div className="catalog-heading">
            <p className="eyebrow">{copy.categoryRecipeCount(category.recipes.length)}</p>
            <h2 id="category-recipes-title">{copy.categoryArchiveTitle}</h2>
          </div>
          <RecipeCardGrid
            recipes={createRecipeCatalogEntries(pagination.items, categories)}
            viewRecipe={copy.viewRecipe}
          />
          <Pagination
            currentPage={page}
            getPagePath={(targetPage) => getCategoryPagePath(category, targetPage)}
            labels={{
              currentPage: copy.currentPage,
              navigation: copy.paginationNavigation,
              next: copy.nextPage,
              previous: copy.previousPage
            }}
            totalPages={getPageCount(category.recipes.length)}
          />
        </section>
      </main>
      <footer lang={category.locale}>{copy.footer}</footer>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeCategoryStructuredData(structuredData)
        }}
      />
    </>
  );
}
