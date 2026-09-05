import type { EditorialPageRecord } from "@/content/editorial-schema";
import type { GalleryRecord } from "@/content/gallery-schema";
import { localPathKey } from "@/content/url-path";
import type { RecipeRecord } from "@/content/schema";
import {
  findContactSuccessLocale,
  getContactSuccessStaticParams
} from "./contact-routes";
import {
  findCategoryBySegments,
  findLandingPageBySegments,
  findRecipeBySegments,
  getStaticPageParams
} from "./recipe-routes";
import {
  findEditorialBySegments,
  findGalleryBySegments,
  getEditorialStaticParams,
  getGalleryStaticParams,
  type EditorialRouteParams
} from "./editorial-routes";

export const generatedStaticAssetPaths = [
  "/robots.txt",
  "/sitemap.xml",
  "/staticwebapp.config.json",
  "/_search/en.json",
  "/_search/fr.json",
  "/_search/ru.json"
] as const;

export function getStaticPathFromSegments(segments: readonly string[]) {
  return segments.length === 0
    ? "/"
    : `/${segments.map(encodeURIComponent).join("/")}`;
}

export function getReservedPublicPaths(records: readonly RecipeRecord[]) {
  return [
    ...getStaticPageParams(records).map(({ segments }) =>
      getStaticPathFromSegments(segments)
    ),
    ...getContactSuccessStaticParams().map(({ segments }) =>
      getStaticPathFromSegments(segments)
    ),
    ...generatedStaticAssetPaths
  ];
}

export function getPublicStaticPageParams(
  recipes: readonly RecipeRecord[],
  editorial: readonly EditorialPageRecord[],
  galleries: readonly GalleryRecord[]
): EditorialRouteParams[] {
  return [
    ...getStaticPageParams(recipes),
    ...getEditorialStaticParams(editorial),
    ...getGalleryStaticParams(galleries),
    ...getContactSuccessStaticParams()
  ];
}

export function getOwnedPublicPaths(
  recipes: readonly RecipeRecord[],
  editorial: readonly EditorialPageRecord[],
  galleries: readonly GalleryRecord[]
) {
  return [
    ...getPublicStaticPageParams(recipes, editorial, galleries).map(
      ({ segments }) => getStaticPathFromSegments(segments)
    ),
    ...generatedStaticAssetPaths
  ];
}

export type PublicStaticRouteSummary = {
  readonly sitemapPaths: number;
  readonly staticPaths: number;
};

export function validatePublicStaticRoutes(
  recipes: readonly RecipeRecord[],
  editorial: readonly EditorialPageRecord[],
  galleries: readonly GalleryRecord[],
  sitemapPaths: readonly string[]
): PublicStaticRouteSummary {
  const staticRoutes = getPublicStaticPageParams(recipes, editorial, galleries);
  const staticPathKeys = staticRoutes.map(({ segments }) =>
    localPathKey(getStaticPathFromSegments(segments))
  );
  const uniqueStaticPathKeys = new Set(staticPathKeys);
  if (uniqueStaticPathKeys.size !== staticPathKeys.length) {
    throw new Error("Public static routes are not unique.");
  }

  for (const { segments } of staticRoutes) {
    const matches = [
      findLandingPageBySegments(segments, recipes) !== undefined,
      findCategoryBySegments(segments, recipes) !== undefined,
      findRecipeBySegments(segments, recipes) !== undefined,
      findEditorialBySegments(segments, editorial) !== undefined,
      findGalleryBySegments(segments, galleries) !== undefined,
      findContactSuccessLocale(segments) !== undefined
    ].filter(Boolean).length;
    if (matches !== 1) {
      throw new Error(
        `Public static route shadow or lookup failure: ${getStaticPathFromSegments(segments)}`
      );
    }
  }

  const sitemapPathKeys = sitemapPaths.map((path) => localPathKey(path));
  const sitemapStaticPathKeys = staticRoutes
    .filter(({ segments }) => findContactSuccessLocale(segments) === undefined)
    .map(({ segments }) => localPathKey(getStaticPathFromSegments(segments)));
  const uniqueSitemapPathKeys = new Set(sitemapPathKeys);
  if (
    sitemapPathKeys.length !== sitemapStaticPathKeys.length
    || uniqueSitemapPathKeys.size !== sitemapPathKeys.length
    || sitemapPathKeys.some((path) => !sitemapStaticPathKeys.includes(path))
  ) {
    throw new Error("Sitemap paths are not unique or do not match public static routes.");
  }

  return {
    sitemapPaths: sitemapPathKeys.length,
    staticPaths: staticPathKeys.length
  };
}
