import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  defaultRecipesRoot,
  loadRecipeCatalogWithSources
} from "./catalog";
import type { RecipeRecord } from "./schema";

export const defaultPublicRoot = path.resolve(process.cwd(), "public");

function isWithinDirectory(candidate: string, directory: string) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

export function resolveLocalMediaPath(
  mediaPath: string,
  publicRoot: string = defaultPublicRoot
) {
  if (!mediaPath.startsWith("/") || mediaPath.startsWith("//")) {
    throw new Error(`Media path must be root-relative: ${mediaPath}`);
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(mediaPath.slice(1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Media path is not valid URL encoding: ${mediaPath}: ${message}`, {
      cause: error
    });
  }

  if (
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    decodedPath.includes("\\") ||
    decodedPath.includes("?") ||
    decodedPath.includes("#")
  ) {
    throw new Error(`Media path is unsafe: ${mediaPath}`);
  }

  const segments = decodedPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Media path contains traversal: ${mediaPath}`);
  }

  const root = path.resolve(publicRoot);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Public media root is not available: "${root}": ${message}`, {
      cause: error
    });
  }

  const candidate = path.resolve(root, ...segments);
  if (!isWithinDirectory(candidate, root)) {
    throw new Error(`Media path escapes the public directory: ${mediaPath}`);
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Missing media file "${mediaPath}": ${message}`, {
      cause: error
    });
  }

  if (!isWithinDirectory(realCandidate, realRoot)) {
    throw new Error(`Media path escapes the public directory: ${mediaPath}`);
  }

  try {
    if (!statSync(realCandidate).isFile()) {
      throw new Error("path is not a regular file");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Media path is not a regular file "${mediaPath}": ${message}`, {
      cause: error
    });
  }

  return realCandidate;
}

export function validateMediaPaths(
  records: readonly RecipeRecord[],
  publicRoot: string = defaultPublicRoot
) {
  for (const record of records) {
    for (const media of record.media) {
      try {
        resolveLocalMediaPath(media.path, publicRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid media for recipe "${record.id}" (${media.id}): ${message}`,
          { cause: error }
        );
      }
    }
  }

  return records;
}

export function validateContent(options: {
  publicRoot?: string;
  recipesRoot?: string;
} = {}) {
  const loaded = loadRecipeCatalogWithSources(options.recipesRoot ?? defaultRecipesRoot);
  validateMediaPaths(loaded.records, options.publicRoot ?? defaultPublicRoot);
  return loaded;
}
