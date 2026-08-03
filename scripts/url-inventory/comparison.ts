import type { RecipeRecord } from "../../src/content/schema";
import {
  getLocaleHomePath,
  getRecipePath,
  supportedLocales
} from "../../src/lib/recipe-routes";
import { uniqueSorted } from "./common";
import type {
  ComparisonStatus,
  InventoryComparison,
  InventoryUrlEntry
} from "./types";

function getCatalogPaths(catalog: readonly RecipeRecord[]) {
  const currentPaths = [
    "/",
    ...supportedLocales.map(getLocaleHomePath),
    ...catalog.map(getRecipePath)
  ];
  const redirectPaths = catalog.flatMap((record) => record.redirectFrom);
  return {
    currentPaths: uniqueSorted(currentPaths),
    redirectPaths: uniqueSorted(redirectPaths)
  };
}

function comparisonPathKey(value: string) {
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);
  const equivalentPathname =
    pathname.length > 1 ? pathname.replace(/\/+$/u, "") || "/" : pathname;
  return `${equivalentPathname}${query}`;
}

export function compareDiscoveredPaths(
  discovered: readonly (Pick<InventoryUrlEntry, "path"> | string)[],
  catalog: readonly RecipeRecord[]
): InventoryComparison {
  const { currentPaths, redirectPaths } = getCatalogPaths(catalog);
  const current = new Set(currentPaths.map(comparisonPathKey));
  const redirects = new Set(redirectPaths.map(comparisonPathKey));
  const entries = uniqueSorted(
    discovered.map((entry) => typeof entry === "string" ? entry : entry.path)
  ).map((pathValue) => {
    const status: ComparisonStatus = current.has(comparisonPathKey(pathValue))
      ? "current-covered"
      : redirects.has(comparisonPathKey(pathValue))
        ? "redirect-covered"
        : "discovered-only";
    return { path: pathValue, status };
  });

  return {
    entries,
    discoveredOnly: entries
      .filter((entry) => entry.status === "discovered-only")
      .map((entry) => entry.path),
    currentCovered: entries
      .filter((entry) => entry.status === "current-covered")
      .map((entry) => entry.path),
    redirectCovered: entries
      .filter((entry) => entry.status === "redirect-covered")
      .map((entry) => entry.path),
    knownCurrentPaths: currentPaths,
    knownRedirectPaths: redirectPaths
  };
}

export const compareInventoryToCatalog = compareDiscoveredPaths;
export const compareInventoryPaths = compareDiscoveredPaths;
