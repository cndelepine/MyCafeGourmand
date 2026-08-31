import type { Locale } from "./locales";
import { validateRecipeSlug } from "./url-path";

export const recipeRouteSegment = "recipes";

export type RecipePathRecord = {
  readonly locale: Locale;
  readonly slug: string;
};

export function getRecipePath(record: RecipePathRecord) {
  validateRecipeSlug(record.slug);
  const segments = record.locale === "en"
    ? [recipeRouteSegment, record.slug]
    : [record.locale, recipeRouteSegment, record.slug];
  return `/${segments
    .map((segment, index) =>
      index === segments.length - 1 ? encodeURIComponent(segment) : segment
    )
    .join("/")}`;
}

export function getCanonicalRecipePath(record: RecipePathRecord) {
  return `${getRecipePath(record)}/`;
}
