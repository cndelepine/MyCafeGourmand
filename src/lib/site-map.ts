import type { MetadataRoute } from "next";
import { getCategoryCatalog } from "@/content/categories";
import type { RecipeRecord } from "@/content/schema";
import { resolveRecipeMediaUrl } from "./recipe-media";
import {
  getCategoryPagePath,
  getLandingPagePath,
  getLocaleHomePath,
  getRecipeLanguageAlternates,
  getRecipePath,
  getRecipesByLocale,
  supportedLocales
} from "./recipe-routes";
import { getPageNumbers } from "./pagination";
import { absoluteUrl, canonicalUrl } from "./site";

export function getSitemapEntries(
  catalog: readonly RecipeRecord[]
): MetadataRoute.Sitemap {
  const landingEntries = supportedLocales.map((locale) => ({
    url: canonicalUrl(getLocaleHomePath(locale)),
    alternates: {
      languages: Object.fromEntries(
        supportedLocales.map((alternateLocale) => [
          alternateLocale,
          canonicalUrl(getLocaleHomePath(alternateLocale))
        ])
      )
    }
  }));
  const landingPageEntries = supportedLocales.flatMap((locale) =>
    getPageNumbers(getRecipesByLocale(locale, catalog).length)
      .slice(1)
      .map((page) => ({
        url: canonicalUrl(getLandingPagePath(locale, page))
      }))
  );
  const categoryEntries = getCategoryCatalog(catalog).flatMap((category) =>
    getPageNumbers(category.recipes.length).map((page) => ({
      url: canonicalUrl(getCategoryPagePath(category, page))
    }))
  );
  const recipeEntries = catalog.map((recipe) => {
    const hero = recipe.recipe.heroMediaId
      ? recipe.media.find((media) => media.id === recipe.recipe.heroMediaId)
      : undefined;
    const modified = recipe.source.modifiedAt ?? recipe.source.createdAt;

    return {
      url: canonicalUrl(getRecipePath(recipe)),
      ...(modified ? { lastModified: modified } : {}),
      alternates: {
        languages: Object.fromEntries(
          getRecipeLanguageAlternates(recipe, catalog).map(({ locale, path }) => [
            locale,
            canonicalUrl(path)
          ])
        )
      },
      ...(hero ? { images: [absoluteUrl(resolveRecipeMediaUrl(hero.path))] } : {})
    };
  });

  return [
    ...landingEntries,
    ...landingPageEntries,
    ...categoryEntries,
    ...recipeEntries
  ];
}
