import {
  findCategoryByRoute,
  getCategoryCatalog,
  type RecipeCategory
} from "@/content/categories";
import { localeValues, type Locale } from "@/content/locales";
import type { RecipeRecord } from "@/content/schema";
import { decodeRecipeSlug, validateRecipeSlug } from "@/content/url-path";
import {
  getPageCount,
  getPageNumbers,
  parsePageNumber
} from "./pagination";

export type LocalizedLocale = Exclude<Locale, "en">;

export type CategoryRoute = {
  readonly category: RecipeCategory;
  readonly page: number;
};

export type LandingRoute = {
  readonly locale: Locale;
  readonly page: number;
};

export const categoryRouteSegment = "category";
export const paginationRouteSegment = "page";
export const recipeRouteSegment = "recipes";
export const supportedLocales = localeValues;

export function isLocale(value: string): value is Locale {
  return supportedLocales.some((locale) => locale === value);
}

export function isLocalizedLocale(value: string): value is LocalizedLocale {
  return value === "fr" || value === "ru";
}

export function getLocaleHomePath(locale: Locale) {
  return locale === "en" ? "/" : `/${locale}`;
}

function validateCanonicalPage(page: number) {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error(`Page number must be a positive safe integer: ${page}`);
  }
}

export function getLandingPagePath(locale: Locale, page: number) {
  validateCanonicalPage(page);
  if (page === 1) {
    return getLocaleHomePath(locale);
  }
  const prefix = locale === "en" ? "" : `/${locale}`;
  return `${prefix}/${paginationRouteSegment}/${page}`;
}

export function getRecipeSegments(record: RecipeRecord) {
  validateRecipeSlug(record.slug);
  return record.locale === "en"
    ? [recipeRouteSegment, record.slug]
    : [record.locale, recipeRouteSegment, record.slug];
}

export function getRecipePath(record: RecipeRecord) {
  const segments = getRecipeSegments(record);
  return `/${segments
    .map((segment, index) =>
      index === segments.length - 1 ? encodeURIComponent(segment) : segment
    )
    .join("/")}`;
}

export function getCategorySegments(category: RecipeCategory) {
  validateRecipeSlug(category.slug, "Category slug");
  return category.locale === "en"
    ? [categoryRouteSegment, category.slug]
    : [category.locale, categoryRouteSegment, category.slug];
}

export function getCategoryPageSegments(
  category: RecipeCategory,
  page: number
) {
  validateCanonicalPage(page);
  const segments = getCategorySegments(category);
  return page === 1
    ? segments
    : [...segments, paginationRouteSegment, String(page)];
}

export function getCategoryPath(category: RecipeCategory) {
  const segments = getCategorySegments(category);
  return `/${segments
    .map((segment, index) =>
      index === segments.length - 1 ? encodeURIComponent(segment) : segment
    )
    .join("/")}`;
}

export function getCategoryPagePath(
  category: RecipeCategory,
  page: number
) {
  validateCanonicalPage(page);
  if (page === 1) {
    return getCategoryPath(category);
  }
  return `${getCategoryPath(category)}/${paginationRouteSegment}/${page}`;
}

export function findRecipeByRoute(
  localeValue: string,
  slug: string,
  catalog: readonly RecipeRecord[]
) {
  if (!isLocale(localeValue)) {
    return undefined;
  }

  let decodedSlug: string;
  try {
    decodedSlug = decodeRecipeSlug(slug, "Recipe route slug");
  } catch {
    return undefined;
  }

  return catalog.find(
    (record) =>
      record.locale === localeValue
      && record.slug === decodedSlug
  );
}

export function getRecipesByLocale(
  localeValue: string,
  catalog: readonly RecipeRecord[]
) {
  if (!isLocale(localeValue)) {
    return [];
  }

  return catalog.filter((record) => record.locale === localeValue);
}

export function getEnglishRecipeParams(
  catalog: readonly RecipeRecord[]
) {
  return catalog
    .filter((record) => record.locale === "en")
    .map((record) => {
      validateRecipeSlug(record.slug);
      return { slug: record.slug };
    });
}

export function getLocalizedRecipeParams(
  catalog: readonly RecipeRecord[]
): Array<{ locale: LocalizedLocale; slug: string }> {
  return catalog
    .filter((record): record is RecipeRecord & { locale: LocalizedLocale } =>
      isLocalizedLocale(record.locale)
    )
    .map((record) => {
      validateRecipeSlug(record.slug);
      return { locale: record.locale, slug: record.slug };
    });
}

export function getLocalizedLandingParams() {
  return supportedLocales
    .filter((locale): locale is LocalizedLocale => isLocalizedLocale(locale))
    .map((locale) => ({ locale }));
}

export function getPageLocale(segments: readonly string[] = []) {
  const firstSegment = segments[0];
  return firstSegment && isLocalizedLocale(firstSegment)
    ? firstSegment
    : "en";
}

function landingPageSegments(locale: Locale, page: number) {
  return page === 1
    ? locale === "en" ? [] : [locale]
    : locale === "en"
      ? [paginationRouteSegment, String(page)]
      : [locale, paginationRouteSegment, String(page)];
}

function landingPaginationParams(catalog: readonly RecipeRecord[]) {
  return supportedLocales.flatMap((locale) =>
    getPageNumbers(getRecipesByLocale(locale, catalog).length)
      .slice(1)
      .map((page) => ({ segments: landingPageSegments(locale, page) }))
  );
}

function categoryStaticParams(catalog: readonly RecipeRecord[]) {
  return getCategoryCatalog(catalog).flatMap((category) =>
    getPageNumbers(category.recipes.length).map((page) => ({
      segments: getCategoryPageSegments(category, page)
    }))
  );
}

export function getStaticPageParams(
  catalog: readonly RecipeRecord[]
) {
  const rootParams = [{ segments: [] }];
  const landingParams = getLocalizedLandingParams().map(({ locale }) => ({
    segments: [locale]
  }));
  const recipeParams = catalog.map((record) => ({
    segments: getRecipeSegments(record)
  }));

  return [
    ...rootParams,
    ...landingParams,
    ...landingPaginationParams(catalog),
    ...categoryStaticParams(catalog),
    ...recipeParams
  ];
}

export function findRecipeBySegments(
  segments: readonly string[],
  catalog: readonly RecipeRecord[]
) {
  if (segments.length === 2 && segments[0] === recipeRouteSegment) {
    return findRecipeByRoute("en", segments[1], catalog);
  }
  if (
    segments.length === 3
    && isLocalizedLocale(segments[0])
    && segments[1] === recipeRouteSegment
  ) {
    return findRecipeByRoute(segments[0], segments[2], catalog);
  }
  return undefined;
}

export function findLandingLocaleBySegments(segments: readonly string[]) {
  return segments.length === 1 && isLocalizedLocale(segments[0])
    ? segments[0]
    : undefined;
}

function validatedLandingRoute(
  locale: Locale,
  pageValue: string,
  catalog: readonly RecipeRecord[]
) {
  const page = parsePageNumber(pageValue);
  const totalPages = getPageCount(getRecipesByLocale(locale, catalog).length);
  if (page === undefined || page <= 1 || page > totalPages) {
    return undefined;
  }
  return { locale, page } satisfies LandingRoute;
}

export function findLandingPageBySegments(
  segments: readonly string[],
  catalog: readonly RecipeRecord[]
) {
  if (segments.length === 0) {
    return { locale: "en", page: 1 } satisfies LandingRoute;
  }
  const landingLocale = findLandingLocaleBySegments(segments);
  if (landingLocale !== undefined) {
    return { locale: landingLocale, page: 1 } satisfies LandingRoute;
  }
  if (
    segments.length === 2
    && segments[0] === paginationRouteSegment
  ) {
    return validatedLandingRoute("en", segments[1], catalog);
  }
  if (
    segments.length === 3
    && isLocalizedLocale(segments[0])
    && segments[1] === paginationRouteSegment
  ) {
    return validatedLandingRoute(segments[0], segments[2], catalog);
  }
  return undefined;
}

function categoryRouteForSegments(
  locale: Locale,
  segments: readonly string[],
  catalog: readonly RecipeRecord[]
) {
  if (segments[0] !== categoryRouteSegment || segments.length < 2) {
    return undefined;
  }
  const category = findCategoryByRoute(locale, segments[1] ?? "", catalog);
  if (category === undefined) {
    return undefined;
  }
  if (segments.length === 2) {
    return { category, page: 1 } satisfies CategoryRoute;
  }
  if (
    segments.length !== 4
    || segments[2] !== paginationRouteSegment
  ) {
    return undefined;
  }
  const page = parsePageNumber(segments[3] ?? "");
  if (
    page === undefined
    || page <= 1
    || page > getPageCount(category.recipes.length)
  ) {
    return undefined;
  }
  return { category, page } satisfies CategoryRoute;
}

export function findCategoryBySegments(
  segments: readonly string[],
  catalog: readonly RecipeRecord[]
) {
  if (segments.length >= 2 && segments[0] === categoryRouteSegment) {
    return categoryRouteForSegments("en", segments, catalog);
  }
  if (
    segments.length >= 3
    && isLocalizedLocale(segments[0])
    && segments[1] === categoryRouteSegment
  ) {
    return categoryRouteForSegments(segments[0], segments.slice(1), catalog);
  }
  return undefined;
}

export function getRecipeTranslations(
  record: RecipeRecord,
  catalog: readonly RecipeRecord[]
) {
  if (record.translationGroupId === null) {
    return [record];
  }

  return catalog.filter(
    (candidate) => candidate.translationGroupId === record.translationGroupId
  );
}

export function getRecipeLanguageAlternates(
  record: RecipeRecord,
  catalog: readonly RecipeRecord[]
) {
  return getRecipeTranslations(record, catalog).map((translation) => ({
    locale: translation.locale,
    path: getRecipePath(translation)
  }));
}
