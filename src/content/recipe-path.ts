import type { RecipeRecord } from "./schema";
import { validateRecipeSlug } from "./url-path";

export const recipeRouteSegment = "recipes";

export function getRecipePath(record: RecipeRecord) {
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

export function getCanonicalRecipePath(record: RecipeRecord) {
  return `${getRecipePath(record)}/`;
}
