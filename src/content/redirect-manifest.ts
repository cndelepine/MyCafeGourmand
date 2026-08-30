import type { EditorialPageRecord } from "./editorial-schema";
import type { GalleryRecord } from "./gallery-schema";
import type { RecipeRecord } from "./schema";
import { localPathKey, validateSafeLocalPath } from "./url-path";
import { getEditorialPath } from "../lib/editorial-routes";
import { getOwnedPublicPaths } from "../lib/public-routes";
import { getRecipePath } from "../lib/recipe-routes";

export type ExactRedirect = {
  source: string;
  destination: string;
  status: 301;
};

export type ExactRedirectManifest = {
  schemaVersion: 1;
  redirects: ExactRedirect[];
};

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getRecipeRedirectDestination(record: RecipeRecord) {
  const route = getRecipePath(record);
  return route.endsWith("/") ? route : `${route}/`;
}

function getEditorialRedirectDestination(record: EditorialPageRecord) {
  const route = getEditorialPath(record);
  return route.endsWith("/") ? route : `${route}/`;
}

function getCanonicalPathKeys(
  records: readonly RecipeRecord[],
  editorialRecords: readonly EditorialPageRecord[],
  galleryRecords: readonly GalleryRecord[]
) {
  return new Set(
    getOwnedPublicPaths(records, editorialRecords, galleryRecords).map(localPathKey)
  );
}

function validateExactRedirects(
  redirects: readonly ExactRedirect[],
  records: readonly RecipeRecord[],
  editorialRecords: readonly EditorialPageRecord[],
  galleryRecords: readonly GalleryRecord[]
) {
  const currentPaths = getCanonicalPathKeys(records, editorialRecords, galleryRecords);
  const sourcePaths = new Set<string>();
  const redirectGraph = new Map<string, string>();

  for (const redirect of redirects) {
    validateSafeLocalPath(redirect.source, "Exact redirect source");
    validateSafeLocalPath(redirect.destination, "Exact redirect destination");

    const sourceKey = localPathKey(redirect.source);
    const destinationKey = localPathKey(redirect.destination);
    if (sourceKey === "/") {
      throw new Error("Exact redirect source cannot be the site root.");
    }
    if (sourceKey === destinationKey) {
      throw new Error(`Self-redirect is not allowed: ${redirect.source}`);
    }
    if (currentPaths.has(sourceKey)) {
      throw new Error(
        `Exact redirect source conflicts with a canonical route: ${redirect.source}`
      );
    }
    if (sourcePaths.has(sourceKey)) {
      throw new Error(`Exact redirect source conflict: ${redirect.source}`);
    }
    sourcePaths.add(sourceKey);
    redirectGraph.set(sourceKey, destinationKey);
  }

  for (const source of redirectGraph.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = source;
    while (current !== undefined && redirectGraph.has(current)) {
      if (visited.has(current)) {
        throw new Error(`Exact redirect loop detected from ${source}`);
      }
      visited.add(current);
      current = redirectGraph.get(current);
    }
  }
}

export function createExactRedirectManifest(
  records: readonly RecipeRecord[],
  editorialRecords: readonly EditorialPageRecord[] = [],
  galleryRecords: readonly GalleryRecord[] = []
): ExactRedirectManifest {
  const redirects: ExactRedirect[] = [];
  for (const record of records) {
    for (const redirectFrom of record.redirectFrom) {
      redirects.push({
        source: redirectFrom,
        destination: getRecipeRedirectDestination(record),
        status: 301
      });
    }
  }
  for (const record of editorialRecords) {
    for (const redirectFrom of record.redirectFrom ?? []) {
      redirects.push({
        source: redirectFrom,
        destination: getEditorialRedirectDestination(record),
        status: 301
      });
    }
  }

  validateExactRedirects(redirects, records, editorialRecords, galleryRecords);
  redirects.sort((left, right) =>
    compareStrings(localPathKey(left.source), localPathKey(right.source))
      || compareStrings(left.source, right.source)
      || compareStrings(left.destination, right.destination)
  );
  return {
    schemaVersion: 1,
    redirects
  };
}

export function serializeExactRedirectManifest(manifest: ExactRedirectManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
