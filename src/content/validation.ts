import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  defaultRecipesRoot,
  loadRecipeCatalogWithSources
} from "./catalog";
import {
  defaultRecipeMediaManifestPath,
  loadRecipeMediaManifest,
  validateRecipeMediaManifestClosure,
  type RecipeMediaManifest
} from "./media-manifest";
import {
  isWordPressRecipeMediaObjectKey,
  validateRecipeMediaPath
} from "./media";
import { localeValues, type Locale, type RecipeRecord } from "./schema";
import {
  findRecipeBySegments,
  getRecipeLanguageAlternates,
  getRecipePath,
  getRecipeSegments,
  getRecipeTranslations,
  getStaticPageParams
} from "../lib/recipe-routes";
import { recipeMatchesQuery } from "../lib/recipe-search";
import { getRecipeStructuredData } from "../lib/recipe-structured-data";

export const defaultPublicRoot = path.resolve(process.cwd(), "public");
const renderableHtmlMarkup =
  /(?:<!--|<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?\/?\s*>)/u;

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
  publicRoot: string = defaultPublicRoot,
  mediaManifest?: RecipeMediaManifest
) {
  for (const record of records) {
    for (const media of record.media) {
      try {
        validateRecipeMediaPath(media.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid media for recipe "${record.id}" (${media.id}): ${message}`,
          { cause: error }
        );
      }
      if (isWordPressRecipeMediaObjectKey(media.path)) {
        if (mediaManifest === undefined) {
          throw new Error(
            `Invalid media for recipe "${record.id}" (${media.id}): ` +
            `Promoted media requires a validated media manifest: ${media.path}`
          );
        }
        continue;
      }
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

function assertNormalizedDisplayText(record: RecipeRecord, field: string, value: string | null) {
  if (value !== null && renderableHtmlMarkup.test(value)) {
    throw new Error(`Recipe display field contains HTML markup: ${record.id} (${field})`);
  }
}

export function validateNormalizedRecipeDisplayText(records: readonly RecipeRecord[]) {
  for (const record of records) {
    assertNormalizedDisplayText(record, "title", record.title);
    assertNormalizedDisplayText(record, "description", record.description);
    assertNormalizedDisplayText(record, "seo.title", record.seo?.title ?? null);
    assertNormalizedDisplayText(record, "seo.description", record.seo?.description ?? null);
    for (const taxonomy of record.taxonomies) {
      assertNormalizedDisplayText(record, "taxonomy.name", taxonomy.name);
    }
    assertNormalizedDisplayText(record, "recipe.notes", record.recipe.notes);
    if (record.recipe.servings !== null) {
      assertNormalizedDisplayText(record, "recipe.servings.raw", record.recipe.servings.raw);
      assertNormalizedDisplayText(record, "recipe.servings.unit", record.recipe.servings.unit);
    }
    if (record.recipe.nutrition !== undefined && record.recipe.nutrition !== null) {
      assertNormalizedDisplayText(
        record,
        "recipe.nutrition.calories.raw",
        record.recipe.nutrition.calories?.raw ?? null
      );
      assertNormalizedDisplayText(
        record,
        "recipe.nutrition.servingSize.raw",
        record.recipe.nutrition.servingSize?.raw ?? null
      );
      assertNormalizedDisplayText(
        record,
        "recipe.nutrition.servingUnit",
        record.recipe.nutrition.servingUnit
      );
    }
    for (const [name, duration] of [
      ["prep", record.recipe.times.prep],
      ["cook", record.recipe.times.cook],
      ["rest", record.recipe.times.rest],
      ["total", record.recipe.times.total]
    ] as const) {
      if (duration !== null) {
        assertNormalizedDisplayText(record, `recipe.times.${name}.raw`, duration.raw);
      }
    }
    if (record.recipe.times.custom !== null) {
      assertNormalizedDisplayText(
        record,
        "recipe.times.custom.label",
        record.recipe.times.custom.label
      );
      assertNormalizedDisplayText(
        record,
        "recipe.times.custom.duration.raw",
        record.recipe.times.custom.duration.raw
      );
    }
    for (const equipment of record.recipe.equipment ?? []) {
      assertNormalizedDisplayText(record, "recipe.equipment.name", equipment.name);
      assertNormalizedDisplayText(record, "recipe.equipment.amount", equipment.amount);
      assertNormalizedDisplayText(record, "recipe.equipment.notes", equipment.notes);
    }
    for (const group of record.recipe.ingredientGroups) {
      assertNormalizedDisplayText(record, "recipe.ingredientGroups.name", group.name);
      for (const item of group.items) {
        assertNormalizedDisplayText(record, "recipe.ingredient.raw", item.raw);
        assertNormalizedDisplayText(record, "recipe.ingredient.name", item.name);
        assertNormalizedDisplayText(record, "recipe.ingredient.pluralName", item.pluralName ?? null);
        assertNormalizedDisplayText(record, "recipe.ingredient.notes", item.notes);
        if (item.quantity !== null) {
          assertNormalizedDisplayText(record, "recipe.ingredient.quantity.raw", item.quantity.raw);
          assertNormalizedDisplayText(record, "recipe.ingredient.quantity.unit", item.quantity.unit);
        }
      }
    }
    for (const group of record.recipe.instructionGroups) {
      assertNormalizedDisplayText(record, "recipe.instructionGroups.name", group.name);
      for (const step of group.steps) {
        assertNormalizedDisplayText(record, "recipe.instruction.text", step.text);
      }
    }
    for (const media of record.media) {
      assertNormalizedDisplayText(record, "media.alt", media.alt);
    }
  }
  return records;
}

export const validateNormalizedDescriptions = validateNormalizedRecipeDisplayText;

export function validateContent(options: {
  mediaManifestPath?: string;
  publicRoot?: string;
  recipesRoot?: string;
} = {}) {
  const loaded = loadRecipeCatalogWithSources(options.recipesRoot ?? defaultRecipesRoot);
  validateNormalizedRecipeDisplayText(loaded.records);
  const mediaManifest = loadRecipeMediaManifest(
    options.mediaManifestPath ?? defaultRecipeMediaManifestPath
  );
  validateMediaPaths(
    loaded.records,
    options.publicRoot ?? defaultPublicRoot,
    mediaManifest
  );
  validateRecipeMediaManifestClosure(loaded.records, mediaManifest);
  return { ...loaded, mediaManifest };
}

export type CatalogBehaviorSummary = {
  readonly byLocale: Readonly<Record<Locale, number>>;
  readonly ids: number;
  readonly localizedSlugs: number;
  readonly staticPaths: number;
  readonly translationLinks: number;
};

function canonicalRecipeUrlPath(record: RecipeRecord) {
  const path = getRecipePath(record);
  return path.endsWith("/") ? path : `${path}/`;
}

export function validateCatalogBehavior(
  records: readonly RecipeRecord[]
): CatalogBehaviorSummary {
  validateNormalizedRecipeDisplayText(records);
  const ids = new Set<string>();
  const localizedSlugs = new Set<string>();
  const byLocale: Record<Locale, number> = {
    en: 0,
    fr: 0,
    ru: 0
  };
  let translationLinks = 0;

  for (const record of records) {
    if (ids.has(record.id)) {
      throw new Error(`Duplicate validated content ID: ${record.id}`);
    }
    ids.add(record.id);
    const localizedSlug = `${record.locale}:${record.slug}`;
    if (localizedSlugs.has(localizedSlug)) {
      throw new Error(`Duplicate validated localized slug: ${localizedSlug}`);
    }
    localizedSlugs.add(localizedSlug);
    byLocale[record.locale] += 1;

    const translations = getRecipeTranslations(record, records);
    const alternates = getRecipeLanguageAlternates(record, records);
    if (
      translations.length !== alternates.length
      || translations.some((translation) => !records.includes(translation))
      || alternates.some((alternate) =>
        !translations.some(
          (translation) =>
            translation.locale === alternate.locale
            && getRecipePath(translation) === alternate.path
        )
      )
    ) {
      throw new Error(`Invalid translation links for recipe: ${record.id}`);
    }
    translationLinks += alternates.length;

    const data = getRecipeStructuredData(record);
    const categories = record.taxonomies
      .filter((taxonomy) => taxonomy.taxonomy === "category")
      .map((taxonomy) => taxonomy.name);
    if (
      data["@type"] !== "Recipe"
      || data.name !== record.title
      || data.inLanguage !== record.locale
      || new URL(data.url).pathname !== canonicalRecipeUrlPath(record)
      || data.recipeIngredient.length
        !== record.recipe.ingredientGroups.reduce(
          (count, group) => count + group.items.length,
          0
        )
      || data.recipeInstructions.length
        !== record.recipe.instructionGroups.reduce(
          (count, group) => count + group.steps.length,
          0
        )
      || JSON.stringify(data.recipeCategory ?? []) !== JSON.stringify(categories)
    ) {
      throw new Error(`Invalid Recipe JSON-LD for recipe: ${record.id}`);
    }
    if (
      !recipeMatchesQuery(record, record.title)
      || record.taxonomies.some((taxonomy) => !recipeMatchesQuery(record, taxonomy.name))
    ) {
      throw new Error(`Invalid search or category behavior for recipe: ${record.id}`);
    }
    if (findRecipeBySegments(getRecipeSegments(record), records) !== record) {
      throw new Error(`Invalid static recipe route for recipe: ${record.id}`);
    }
  }

  const staticPaths = getStaticPageParams(records);
  const uniqueStaticPaths = new Set(
    staticPaths.map(({ segments }) => segments.map(encodeURIComponent).join("/"))
  );
  if (
    staticPaths.length !== records.length + localeValues.length
    || uniqueStaticPaths.size !== staticPaths.length
  ) {
    throw new Error("Static recipe routes are not unique or complete.");
  }
  return {
    byLocale,
    ids: ids.size,
    localizedSlugs: localizedSlugs.size,
    staticPaths: staticPaths.length,
    translationLinks
  };
}
