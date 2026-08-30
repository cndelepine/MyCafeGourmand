import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import robots from "../src/app/robots";
import { LandingPage } from "../src/components/landing-page";
import {
  findCategoryByRoute,
  getCategoryCatalog
} from "../src/content/categories";
import { recipeRecordSchema, type Locale, type RecipeRecord } from "../src/content/schema";
import { createStaticWebAppConfig } from "../src/content/staticwebapp";
import { getCategoryBreadcrumbStructuredData } from "../src/lib/category-structured-data";
import {
  getPageCount,
  getPageNumbers,
  getPaginationPage
} from "../src/lib/pagination";
import {
  createRecipeCatalogEntries,
  searchRecipeCatalogEntries
} from "../src/lib/recipe-catalog-data";
import {
  createRecipeSearchIndex,
  parseRecipeSearchIndex
} from "../src/lib/recipe-search-index";
import {
  findCategoryBySegments,
  findLandingPageBySegments,
  findRecipeBySegments,
  getCategoryPagePath,
  getCategoryPath,
  getLandingPagePath,
  getStaticPageParams
} from "../src/lib/recipe-routes";
import {
  getCategoryMetadata,
  getLandingMetadata
} from "../src/lib/site";
import { getSitemapEntries } from "../src/lib/site-map";
import { recipeFixture } from "./fixtures/recipe";

type CategoryInput = {
  readonly name: string;
  readonly slug: string;
  readonly sourceId?: string | null;
  readonly sourceTaxonomyId?: string | null;
};

function recipeWithCategory(
  index: number,
  locale: Locale,
  slug: string,
  category: CategoryInput,
  title = `Recipe ${index}`
): RecipeRecord {
  return recipeRecordSchema.parse({
    ...recipeFixture,
    id: `test:category:${index}`,
    locale,
    slug,
    source: {
      ...recipeFixture.source,
      recipeId: String(10_000 + index),
      sourceSlug: slug
    },
    taxonomies: [{
      scope: "editorial",
      taxonomy: "category",
      sourceId: category.sourceId === undefined ? "100" : category.sourceId,
      sourceTaxonomyId:
        category.sourceTaxonomyId === undefined ? "200" : category.sourceTaxonomyId,
      name: category.name,
      slug: category.slug
    }],
    title
  });
}

function paginatedEnglishCatalog() {
  return Array.from({ length: 25 }, (_, index) =>
    recipeWithCategory(
      index + 1,
      "en",
      `recipe-${index + 1}`,
      {
        name: "Starters",
        slug: "starters",
        sourceId: "100",
        sourceTaxonomyId: "200"
      },
      index === 24 ? "Beyond the first page" : `Recipe ${index + 1}`
    )
  );
}

test("category and pagination paths preserve locale prefixes and canonical page one", () => {
  const [english] = getCategoryCatalog([
    recipeWithCategory(1, "en", "english", { name: "Starters", slug: "starters" })
  ]);
  const [french] = getCategoryCatalog([
    recipeWithCategory(2, "fr", "francais", { name: "Entrées", slug: "entrees" })
  ]);
  const [russian] = getCategoryCatalog([
    recipeWithCategory(3, "ru", "russkiy", {
      name: "Супы",
      slug: encodeURIComponent("супы")
    })
  ]);

  assert.ok(english);
  assert.ok(french);
  assert.ok(russian);
  assert.equal(getLandingPagePath("en", 1), "/");
  assert.equal(getLandingPagePath("fr", 2), "/fr/page/2");
  assert.equal(getLandingPagePath("ru", 3), "/ru/page/3");
  assert.equal(getCategoryPath(english), "/category/starters");
  assert.equal(getCategoryPagePath(english, 2), "/category/starters/page/2");
  assert.equal(getCategoryPath(french), "/fr/category/entrees");
  assert.equal(
    getCategoryPath(russian),
    `/ru/category/${encodeURIComponent("супы")}`
  );
});

test("category archives decode encoded Cyrillic once and resolve raw or encoded route segments", () => {
  const catalog = [
    recipeWithCategory(1, "ru", "sup", {
      name: "Супы",
      slug: encodeURIComponent("супы")
    })
  ];
  const [category] = getCategoryCatalog(catalog);

  assert.ok(category);
  assert.equal(category.slug, "супы");
  assert.equal(
    findCategoryByRoute("ru", encodeURIComponent("супы"), catalog)?.identity,
    category.identity
  );
  assert.equal(
    findCategoryBySegments(["ru", "category", "супы"], catalog)?.category.identity,
    category.identity
  );
});

test("category catalog rejects unsafe, missing, and colliding source identities", () => {
  for (const slug of ["..", "unsafe%252fpath", "malformed%"]) {
    assert.throws(
      () => getCategoryCatalog([
        recipeWithCategory(1, "en", "safe-recipe", {
          name: "Unsafe",
          slug
        })
      ]),
      /unsafe path segment|unsafe separator|URL encoding/
    );
  }
  assert.throws(
    () => getCategoryCatalog([
      recipeWithCategory(1, "en", "safe-recipe", {
        name: "Missing source",
        slug: "missing-source",
        sourceId: null
      })
    ]),
    /must preserve both source term IDs/
  );
  assert.throws(
    () => getCategoryCatalog([
      recipeWithCategory(1, "en", "first", {
        name: "First",
        slug: "same",
        sourceTaxonomyId: "200"
      }),
      recipeWithCategory(2, "en", "second", {
        name: "Second",
        slug: "same",
        sourceTaxonomyId: "201"
      })
    ]),
    /Duplicate localized category slug/
  );
});

test("category membership excludes tags, ingredients, and recipe taxonomies", () => {
  const record = recipeRecordSchema.parse({
    ...recipeWithCategory(1, "en", "archive-category", {
      name: "Archive category",
      slug: "archive-category"
    }),
    taxonomies: [
      {
        scope: "editorial",
        taxonomy: "category",
        sourceId: "100",
        sourceTaxonomyId: "200",
        name: "Archive category",
        slug: "archive-category"
      },
      {
        scope: "editorial",
        taxonomy: "post_tag",
        sourceId: "101",
        sourceTaxonomyId: "201",
        name: "Tag only",
        slug: "tag-only"
      },
      {
        scope: "editorial",
        taxonomy: "ingredient",
        sourceId: "102",
        sourceTaxonomyId: "202",
        name: "Ingredient only",
        slug: "ingredient-only"
      },
      {
        scope: "recipe",
        taxonomy: "category",
        sourceId: "103",
        sourceTaxonomyId: "203",
        name: "Recipe-only category",
        slug: "recipe-only-category"
      }
    ]
  });
  const categories = getCategoryCatalog([record]);
  const entries = createRecipeCatalogEntries([record], categories);

  assert.deepEqual(categories.map((category) => category.name), ["Archive category"]);
  assert.deepEqual(entries[0]?.categories, [{
    name: "Archive category",
    path: "/category/archive-category"
  }]);
});

test("pagination rejects empty, invalid, and page-one duplicate routes", () => {
  const catalog = paginatedEnglishCatalog();
  const category = getCategoryCatalog(catalog)[0];
  const staticParams = getStaticPageParams(catalog);

  assert.equal(getPageCount(0), 0);
  assert.deepEqual(getPageNumbers(0), []);
  assert.equal(getPaginationPage([], 1), undefined);
  assert.equal(findLandingPageBySegments(["page", "1"], catalog), undefined);
  assert.equal(findLandingPageBySegments(["page", "0"], catalog), undefined);
  assert.equal(findLandingPageBySegments(["page", "01"], catalog), undefined);
  assert.equal(findLandingPageBySegments(["page", "3"], catalog), undefined);
  assert.equal(findCategoryBySegments(["category", "starters", "page", "1"], catalog), undefined);
  assert.equal(findCategoryBySegments(["category", "starters", "page", "3"], catalog), undefined);
  assert.equal(findCategoryBySegments(["category", "missing"], catalog), undefined);
  assert.ok(category);
  assert.equal(
    staticParams.some(({ segments }) =>
      segments.includes("page") && segments.at(-1) === "1"
    ),
    false
  );
});

test("pagination has deterministic bounded page boundaries and static routes", () => {
  const catalog = paginatedEnglishCatalog();
  const category = getCategoryCatalog(catalog)[0];
  const firstPage = getPaginationPage(catalog, 1);
  const secondPage = getPaginationPage(catalog, 2);
  const params = getStaticPageParams(catalog);

  assert.ok(category);
  assert.equal(firstPage?.items.length, 24);
  assert.equal(secondPage?.items.length, 1);
  assert.equal(secondPage?.items[0]?.title, "Beyond the first page");
  assert.equal(getPageCount(catalog.length), 2);
  assert.equal(getPageCount(category.recipes.length), 2);
  assert.equal(params.length, 31);
  assert.deepEqual(params, getStaticPageParams(catalog));
  assert.equal(
    params.some(({ segments }) => segments.join("/") === "page/2"),
    true
  );
  assert.equal(
    params.some(({ segments }) => segments.join("/") === "category/starters/page/2"),
    true
  );
  assert.equal(
    findRecipeBySegments(["category", "starters"], catalog),
    undefined
  );
});

test("generated redirect checks reserve canonical category and pagination paths", () => {
  const catalog = paginatedEnglishCatalog();

  for (const redirectFrom of ["/category/starters", "/page/2"]) {
    const withRedirect = recipeRecordSchema.parse({
      ...catalog[0],
      redirectFrom: [redirectFrom]
    });
    assert.throws(
      () => createStaticWebAppConfig([withRedirect, ...catalog.slice(1)]),
      /conflicts with a canonical route/
    );
  }
});

test("landing and category metadata canonicalize paginated pages without guessed hreflang", () => {
  const catalog = paginatedEnglishCatalog();
  const [category] = getCategoryCatalog(catalog);

  assert.ok(category);
  const landing = getLandingMetadata("fr", 2);
  const archive = getCategoryMetadata(category, 2);

  assert.equal(
    landing.alternates?.canonical,
    "https://mycafegourmand.com/fr/page/2/"
  );
  assert.equal(landing.alternates?.languages, undefined);
  assert.equal(
    archive.alternates?.canonical,
    "https://mycafegourmand.com/category/starters/page/2/"
  );
  assert.equal(archive.alternates?.languages, undefined);
  assert.equal(archive.openGraph?.url, archive.alternates?.canonical);
});

test("category archives emit localized breadcrumb structured data", () => {
  const [category] = getCategoryCatalog(paginatedEnglishCatalog());

  assert.ok(category);
  assert.deepEqual(
    getCategoryBreadcrumbStructuredData(category, 2, {
      home: "All recipes",
      page: (page) => `Page ${page}`
    }).itemListElement,
    [
      {
        "@type": "ListItem",
        item: "https://mycafegourmand.com/",
        name: "All recipes",
        position: 1
      },
      {
        "@type": "ListItem",
        item: "https://mycafegourmand.com/category/starters/",
        name: "Starters",
        position: 2
      },
      {
        "@type": "ListItem",
        item: "https://mycafegourmand.com/category/starters/page/2/",
        name: "Page 2",
        position: 3
      }
    ]
  );
});

test("server rendering keeps category discovery and page navigation usable without JavaScript", () => {
  const markup = renderToStaticMarkup(createElement(LandingPage, {
    catalog: paginatedEnglishCatalog(),
    locale: "en",
    page: 1
  }));

  assert.match(markup, /href="\/category\/starters"/u);
  assert.match(markup, /href="\/page\/2"/u);
  assert.match(markup, /Recipe 1/u);
});

test("the on-demand locale search index covers recipes beyond the visible page", () => {
  const catalog = paginatedEnglishCatalog();
  const entries = createRecipeCatalogEntries(catalog, getCategoryCatalog(catalog));
  const index = createRecipeSearchIndex("en", entries);
  const query = "beyond the first page";

  assert.deepEqual(searchRecipeCatalogEntries(entries.slice(0, 24), query), []);
  assert.deepEqual(
    searchRecipeCatalogEntries(index.recipes, query).map((recipe) => recipe.title),
    ["Beyond the first page"]
  );
  assert.deepEqual(parseRecipeSearchIndex(JSON.parse(JSON.stringify(index)), "en"), index);
});

test("sitemap includes canonical locale pagination and category archive pages", () => {
  const catalog = paginatedEnglishCatalog();
  const urls = getSitemapEntries(catalog).map((entry) => entry.url);

  assert.equal(urls.includes("https://mycafegourmand.com/page/2/"), true);
  assert.equal(
    urls.includes("https://mycafegourmand.com/category/starters/"),
    true
  );
  assert.equal(
    urls.includes("https://mycafegourmand.com/category/starters/page/2/"),
    true
  );
  assert.equal(urls.includes("https://mycafegourmand.com/page/1/"), false);
});

test("robots excludes the generated search index from crawling", () => {
  assert.deepEqual(robots().rules, {
    userAgent: "*",
    allow: "/",
    disallow: "/_search/"
  });
});
