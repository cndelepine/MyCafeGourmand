import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import { recipeRecordSchema, localeValues, type Locale, type RecipeRecord } from "./schema";

export const defaultRecipesRoot = path.resolve(process.cwd(), "content/recipes");

export type RecipeSourceFile = {
  locale: Locale;
  path: string;
};

export type LoadedRecipeCatalog = {
  records: RecipeRecord[];
  files: RecipeSourceFile[];
};

type CatalogValidationOptions = {
  sourceFiles?: readonly RecipeSourceFile[];
};

function formatSchemaIssues(issues: Array<{ message: string; path: PropertyKey[] }>) {
  return issues
    .map((issue) => {
      const issuePath = issue.path.length > 0
        ? issue.path.map((part) => String(part)).join(".")
        : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function getDirectoryEntries(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to discover recipe files in "${directory}": ${message}`, {
      cause: error
    });
  }
}

function compareNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Discover JSON records in locale order and filename order. Missing locale
 * folders are intentional: an untranslated locale has no records yet.
 */
export function discoverRecipeFiles(
  recipesRoot: string = defaultRecipesRoot
): RecipeSourceFile[] {
  const root = path.resolve(recipesRoot);

  if (!existsSync(root)) {
    return [];
  }
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Recipe content root is not a directory: "${root}"`);
  }

  for (const entry of getDirectoryEntries(root)) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in recipe content: "${path.join(root, entry.name)}"`);
    }
    if (
      entry.isDirectory() &&
      !localeValues.some((locale) => locale === entry.name)
    ) {
      throw new Error(`Unsupported locale folder "${entry.name}" in "${root}"`);
    }
  }

  return localeValues.flatMap((locale) => {
    const localeDirectory = path.join(root, locale);

    if (!existsSync(localeDirectory)) {
      return [];
    }
    const localeStats = lstatSync(localeDirectory);
    if (localeStats.isSymbolicLink() || !localeStats.isDirectory()) {
      throw new Error(`Locale content path is not a directory: "${localeDirectory}"`);
    }

    const entries = getDirectoryEntries(localeDirectory);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are not allowed in recipe content: "${path.join(localeDirectory, entry.name)}"`
        );
      }
    }

    return entries
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".json")
      .map((entry) => entry.name)
      .sort(compareNames)
      .map((fileName) => ({
        locale,
        path: path.join(localeDirectory, fileName)
      }));
  });
}

export function parseRecipeRecord(input: unknown, sourcePath?: string): RecipeRecord {
  const result = recipeRecordSchema.safeParse(input);

  if (!result.success) {
    const context = sourcePath ? ` in "${sourcePath}"` : "";
    throw new Error(`Invalid recipe record${context}: ${formatSchemaIssues(result.error.issues)}`, {
      cause: result.error
    });
  }

  return result.data;
}

function readRecipeRecord(source: RecipeSourceFile) {
  let contents: string;

  try {
    contents = readFileSync(source.path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read recipe file "${source.path}": ${message}`, {
      cause: error
    });
  }

  let input: unknown;
  try {
    input = JSON.parse(contents) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed JSON in "${source.path}": ${message}`, {
      cause: error
    });
  }

  const record = parseRecipeRecord(input, source.path);
  if (record.locale !== source.locale) {
    throw new Error(
      `Locale-folder mismatch in "${source.path}": record locale "${record.locale}" ` +
      `does not match folder "${source.locale}".`
    );
  }

  return record;
}

export function validateCatalog(
  catalog?: readonly unknown[],
  options: CatalogValidationOptions = {}
): RecipeRecord[] {
  const input = catalog ?? loadRecipeCatalogWithSources().records;
  const parsed = input.map((record, index) =>
    parseRecipeRecord(record, options.sourceFiles?.[index]?.path)
  );
  const ids = new Map<string, number>();
  const localizedSlugs = new Map<string, number>();
  const translationGroupLocales = new Map<string, number>();

  for (const [index, record] of parsed.entries()) {
    const sourcePath = options.sourceFiles?.[index]?.path;
    const context = sourcePath ? ` in "${sourcePath}"` : "";

    if (ids.has(record.id)) {
      throw new Error(`Duplicate content ID${context}: ${record.id}`);
    }
    ids.set(record.id, index);

    const localizedSlug = `${record.locale}:${record.slug}`;
    if (localizedSlugs.has(localizedSlug)) {
      throw new Error(`Duplicate localized slug${context}: ${localizedSlug}`);
    }
    localizedSlugs.set(localizedSlug, index);

    if (record.translationGroupId !== null) {
      const translationGroupLocale = `${record.translationGroupId}:${record.locale}`;
      const previousIndex = translationGroupLocales.get(translationGroupLocale);
      if (previousIndex !== undefined) {
        const previousSourcePath = options.sourceFiles?.[previousIndex]?.path;
        const previousContext = previousSourcePath
          ? ` (already defined in "${previousSourcePath}")`
          : "";
        throw new Error(
          `Duplicate translation group locale${context}: ${translationGroupLocale}` +
          `${previousContext}`
        );
      }
      translationGroupLocales.set(translationGroupLocale, index);
    }
  }

  return parsed;
}

export function loadRecipeCatalogWithSources(
  recipesRoot: string = defaultRecipesRoot
): LoadedRecipeCatalog {
  const files = discoverRecipeFiles(recipesRoot);
  const records = files.map(readRecipeRecord);
  return {
    files,
    records: validateCatalog(records, { sourceFiles: files })
  };
}

export function loadRecipeCatalog(
  recipesRoot: string = defaultRecipesRoot
): RecipeRecord[] {
  return loadRecipeCatalogWithSources(recipesRoot).records;
}

export const recipeCatalog = loadRecipeCatalog();
