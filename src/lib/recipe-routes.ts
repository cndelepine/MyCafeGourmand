import { recipeCatalog } from "@/content/catalog";
import { localeValues, type Locale, type RecipeRecord } from "@/content/schema";

export type LocalizedLocale = Exclude<Locale, "en">;

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

export function getRecipeSegments(record: RecipeRecord) {
  return record.locale === "en"
    ? ["recipes", record.slug]
    : [record.locale, "recipes", record.slug];
}

export function getRecipePath(record: RecipeRecord) {
  const segments = getRecipeSegments(record);
  return `/${segments
    .map((segment, index) =>
      index === segments.length - 1 ? encodeURIComponent(segment) : segment
    )
    .join("/")}`;
}

function decodeRouteSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function findRecipeByRoute(
  localeValue: string,
  slug: string,
  catalog: readonly RecipeRecord[] = recipeCatalog
) {
  if (!isLocale(localeValue)) {
    return undefined;
  }

  const decodedSlug = decodeRouteSegment(slug);
  return catalog.find(
    (record) =>
      record.locale === localeValue &&
      (record.slug === slug || record.slug === decodedSlug)
  );
}

export function getRecipesByLocale(
  localeValue: string,
  catalog: readonly RecipeRecord[] = recipeCatalog
) {
  if (!isLocale(localeValue)) {
    return [];
  }

  return catalog.filter((record) => record.locale === localeValue);
}

export function getEnglishRecipeParams(
  catalog: readonly RecipeRecord[] = recipeCatalog
) {
  return catalog
    .filter((record) => record.locale === "en")
    .map((record) => ({ slug: record.slug }));
}

export function getLocalizedRecipeParams(
  catalog: readonly RecipeRecord[] = recipeCatalog
): Array<{ locale: LocalizedLocale; slug: string }> {
  return catalog
    .filter((record): record is RecipeRecord & { locale: LocalizedLocale } =>
      isLocalizedLocale(record.locale)
    )
    .map((record) => ({ locale: record.locale, slug: record.slug }));
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

export function getStaticPageParams(
  catalog: readonly RecipeRecord[] = recipeCatalog
) {
  const rootParams = [{ segments: [] }];
  const landingParams = getLocalizedLandingParams().map(({ locale }) => ({
    segments: [locale]
  }));
  const recipeParams = catalog.map((record) => ({
    segments: getRecipeSegments(record)
  }));

  return [...rootParams, ...landingParams, ...recipeParams];
}

export function findRecipeBySegments(
  segments: readonly string[],
  catalog: readonly RecipeRecord[] = recipeCatalog
) {
  if (segments.length === 2 && segments[0] === "recipes") {
    return findRecipeByRoute("en", segments[1], catalog);
  }
  if (
    segments.length === 3 &&
    isLocalizedLocale(segments[0]) &&
    segments[1] === "recipes"
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

export function getRecipeTranslations(
  record: RecipeRecord,
  catalog: readonly RecipeRecord[] = recipeCatalog
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
  catalog: readonly RecipeRecord[] = recipeCatalog
) {
  return getRecipeTranslations(record, catalog).map((translation) => ({
    locale: translation.locale,
    path: getRecipePath(translation)
  }));
}
