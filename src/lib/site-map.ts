import type { MetadataRoute } from "next";
import { getCategoryCatalog } from "@/content/categories";
import type { EditorialPageRecord } from "@/content/editorial-schema";
import type { GalleryRecord } from "@/content/gallery-schema";
import type { RecipeRecord } from "@/content/schema";
import {
  getRecipeModifiedAt,
  getRecipePublishedAt
} from "@/content/recipe-dates";
import { resolveManagedMediaUrl, resolveRecipeMediaUrl } from "./recipe-media";
import {
  getEditorialLanguageAlternates,
  getEditorialPath
} from "./editorial-routes";
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
  catalog: readonly RecipeRecord[],
  editorial: readonly EditorialPageRecord[] = [],
  galleries: readonly GalleryRecord[] = []
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
    const modified = getRecipeModifiedAt(recipe) ?? getRecipePublishedAt(recipe);

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
  const editorialEntries = editorial.map((page) => {
    const featured = page.featuredMediaId === null
      ? undefined
      : page.media?.find((media) => media.id === page.featuredMediaId);
    const modified = page.modifiedAt ?? page.source.modifiedAt ?? page.publishedAt ?? page.source.createdAt;

    return {
      url: canonicalUrl(getEditorialPath(page)),
      ...(modified ? { lastModified: modified } : {}),
      alternates: {
        languages: Object.fromEntries(
          getEditorialLanguageAlternates(page, editorial).map(({ locale, path }) => [
            locale,
            canonicalUrl(path)
          ])
        )
      },
      ...(featured === undefined
        ? {}
        : { images: [absoluteUrl(resolveManagedMediaUrl(featured.path))] })
    };
  });
  const galleryEntries = galleries.map((gallery) => ({
    url: canonicalUrl(gallery.canonicalPath),
    ...(gallery.images.length === 0
      ? {}
      : {
        images: gallery.images.map((image) => {
          const media = gallery.media?.find(
            (candidate) => candidate.id === image.originalMediaId
          );
          if (media === undefined) {
            throw new Error(`Gallery image media is missing: ${image.originalMediaId}`);
          }
          return absoluteUrl(resolveManagedMediaUrl(media.path));
        })
      })
  }));

  return [
    ...landingEntries,
    ...landingPageEntries,
    ...categoryEntries,
    ...recipeEntries,
    ...editorialEntries,
    ...galleryEntries
  ];
}
