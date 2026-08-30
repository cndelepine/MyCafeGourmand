import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import {
  editorialPageRecordSchema,
  localeValues,
  publicContentLimits,
  type EditorialPageRecord,
  type Locale
} from "./editorial-schema";
import { galleryCanonicalPath } from "./gallery-schema";
import { localPathKey, validateSafeLocalPath } from "./url-path";

export const defaultEditorialRoot = path.resolve(
  process.cwd(),
  "content",
  "editorial"
);

export type EditorialSourceFile = {
  locale: Locale;
  path: string;
};

export type LoadedEditorialCatalog = {
  records: EditorialPageRecord[];
  files: EditorialSourceFile[];
};

export type EditorialCatalogValidationOptions = {
  sourceFiles?: readonly EditorialSourceFile[];
  reservedPaths?: readonly string[];
};

type EditorialCatalogLoadOptions = Pick<
  EditorialCatalogValidationOptions,
  "reservedPaths"
>;

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
    throw new Error(`Unable to discover editorial files in "${directory}": ${message}`, {
      cause: error
    });
  }
}

function compareNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rejectSymlink(entryPath: string, entryDescription: string) {
  throw new Error(
    `Symbolic links are not allowed in editorial content ${entryDescription}: "${entryPath}"`
  );
}

function assertJsonFile(
  entry: { isSymbolicLink(): boolean; isFile(): boolean; name: string },
  directory: string
) {
  const entryPath = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) {
    rejectSymlink(entryPath, "files");
  }
  if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
    throw new Error(`Unsupported editorial content file: "${entryPath}"`);
  }
}

function assertRecordCount(count: number, label: string) {
  if (count > publicContentLimits.maxRecords) {
    throw new Error(
      `${label} exceeds the maximum of ${publicContentLimits.maxRecords} records.`
    );
  }
}

/**
 * Discover JSON records in locale order and filename order. Missing locale
 * folders are intentional: an untranslated locale has no records yet.
 */
export function discoverEditorialFiles(
  editorialRoot: string = defaultEditorialRoot
): EditorialSourceFile[] {
  const root = path.resolve(editorialRoot);

  if (!existsSync(root)) {
    return [];
  }
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Editorial content root is not a directory: "${root}"`);
  }

  for (const entry of getDirectoryEntries(root)) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      rejectSymlink(entryPath, "directories");
    }
    if (!entry.isDirectory()) {
      throw new Error(`Unsupported editorial content file: "${entryPath}"`);
    }
    if (!localeValues.some((locale) => locale === entry.name)) {
      throw new Error(`Unsupported locale folder "${entry.name}" in "${root}"`);
    }
  }

  const files = localeValues.flatMap((locale) => {
    const localeDirectory = path.join(root, locale);

    if (!existsSync(localeDirectory)) {
      return [];
    }
    const localeStats = lstatSync(localeDirectory);
    if (localeStats.isSymbolicLink() || !localeStats.isDirectory()) {
      throw new Error(`Locale editorial path is not a directory: "${localeDirectory}"`);
    }

    const entries = getDirectoryEntries(localeDirectory);
    assertRecordCount(entries.length, `Editorial locale "${locale}"`);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        throw new Error(
          `Unsupported editorial content directory: "${path.join(localeDirectory, entry.name)}"`
        );
      }
      assertJsonFile(entry, localeDirectory);
    }

    return entries
      .map((entry) => entry.name)
      .sort(compareNames)
      .map((fileName) => ({
        locale,
        path: path.join(localeDirectory, fileName)
      }));
  });

  assertRecordCount(files.length, "Editorial catalog");
  return files;
}

export function parseEditorialRecord(
  input: unknown,
  sourcePath?: string
): EditorialPageRecord {
  const result = editorialPageRecordSchema.safeParse(input);

  if (!result.success) {
    const context = sourcePath ? ` in "${sourcePath}"` : "";
    throw new Error(
      `Invalid editorial page record${context}: ${formatSchemaIssues(result.error.issues)}`,
      { cause: result.error }
    );
  }

  return result.data;
}

function readEditorialRecord(source: EditorialSourceFile) {
  let contents: string;

  try {
    const stats = lstatSync(source.path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("source is not a regular file");
    }
    if (stats.size > publicContentLimits.maxFileBytes) {
      throw new Error(
        `file exceeds the maximum size of ${publicContentLimits.maxFileBytes} bytes`
      );
    }
    const bytes = readFileSync(source.path);
    if (bytes.byteLength > publicContentLimits.maxFileBytes) {
      throw new Error(
        `file exceeds the maximum size of ${publicContentLimits.maxFileBytes} bytes`
      );
    }
    contents = bytes.toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read editorial file "${source.path}": ${message}`, {
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

  const record = parseEditorialRecord(input, source.path);
  if (record.locale !== source.locale) {
    throw new Error(
      `Locale-folder mismatch in "${source.path}": record locale "${record.locale}" ` +
      `does not match folder "${source.locale}".`
    );
  }

  return record;
}

function canonicalRouteKey(value: string, label: string) {
  try {
    validateSafeLocalPath(value, label);
    return localPathKey(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is unsafe: ${value}: ${message}`, { cause: error });
  }
}

function reservedRouteKeys(reservedPaths: readonly string[]) {
  return new Set(reservedPaths.map((reservedPath) =>
    canonicalRouteKey(reservedPath, "Reserved public route")
  ));
}

export function validateEditorialCatalog(
  catalog?: readonly unknown[],
  options: EditorialCatalogValidationOptions = {}
): EditorialPageRecord[] {
  const input = catalog ?? loadEditorialCatalogWithSources().records;
  assertRecordCount(input.length, "Editorial catalog");
  const parsed = input.map((record, index) =>
    parseEditorialRecord(record, options.sourceFiles?.[index]?.path)
  );
  const ids = new Map<string, number>();
  const canonicalRoutes = new Map<string, number>();
  const translationGroupLocales = new Map<string, number>();
  const canonicalReservedRoutes = reservedRouteKeys([
    galleryCanonicalPath,
    ...(options.reservedPaths ?? [])
  ]);

  for (const [index, record] of parsed.entries()) {
    const sourcePath = options.sourceFiles?.[index]?.path;
    const context = sourcePath ? ` in "${sourcePath}"` : "";

    if (ids.has(record.id)) {
      throw new Error(`Duplicate editorial content ID${context}: ${record.id}`);
    }
    ids.set(record.id, index);

    const canonicalKey = canonicalRouteKey(
      record.canonicalPath,
      "Editorial canonical route"
    );
    if (canonicalReservedRoutes.has(canonicalKey)) {
      throw new Error(
        `Editorial canonical route collides with a reserved public route${context}: ` +
        `${record.canonicalPath}`
      );
    }
    const previousCanonicalIndex = canonicalRoutes.get(canonicalKey);
    if (previousCanonicalIndex !== undefined) {
      const previousSourcePath = options.sourceFiles?.[previousCanonicalIndex]?.path;
      const previousContext = previousSourcePath
        ? ` (already defined in "${previousSourcePath}")`
        : "";
      throw new Error(
        `Duplicate editorial canonical route${context}: ${record.canonicalPath}${previousContext}`
      );
    }
    canonicalRoutes.set(canonicalKey, index);

    if (record.translationGroupId !== null) {
      const translationGroupLocale = `${record.translationGroupId}:${record.locale}`;
      const previousIndex = translationGroupLocales.get(translationGroupLocale);
      if (previousIndex !== undefined) {
        const previousSourcePath = options.sourceFiles?.[previousIndex]?.path;
        const previousContext = previousSourcePath
          ? ` (already defined in "${previousSourcePath}")`
          : "";
        throw new Error(
          `Duplicate editorial translation group locale${context}: ` +
          `${translationGroupLocale}${previousContext}`
        );
      }
      translationGroupLocales.set(translationGroupLocale, index);
    }
  }

  const redirectSources = new Map<string, number>();
  for (const [index, record] of parsed.entries()) {
    const sourcePath = options.sourceFiles?.[index]?.path;
    const context = sourcePath ? ` in "${sourcePath}"` : "";
    for (const redirectFrom of record.redirectFrom ?? []) {
      const redirectKey = canonicalRouteKey(
        redirectFrom,
        "Editorial redirect source"
      );
      if (canonicalRoutes.has(redirectKey)) {
        throw new Error(
          `Editorial redirect source collides with a canonical route${context}: ${redirectFrom}`
        );
      }
      if (canonicalReservedRoutes.has(redirectKey)) {
        throw new Error(
          `Editorial redirect source collides with a reserved public route${context}: ` +
          `${redirectFrom}`
        );
      }
      const previousIndex = redirectSources.get(redirectKey);
      if (previousIndex !== undefined) {
        const previousSourcePath = options.sourceFiles?.[previousIndex]?.path;
        const previousContext = previousSourcePath
          ? ` (already defined in "${previousSourcePath}")`
          : "";
        throw new Error(
          `Duplicate editorial redirect source${context}: ${redirectFrom}${previousContext}`
        );
      }
      redirectSources.set(redirectKey, index);
    }
  }

  return parsed;
}

export function loadEditorialCatalogWithSources(
  editorialRoot: string = defaultEditorialRoot,
  options: EditorialCatalogLoadOptions = {}
): LoadedEditorialCatalog {
  const files = discoverEditorialFiles(editorialRoot);
  const records = files.map(readEditorialRecord);
  return {
    files,
    records: validateEditorialCatalog(records, {
      ...options,
      sourceFiles: files
    })
  };
}

export function loadEditorialCatalog(
  editorialRoot: string = defaultEditorialRoot,
  options: EditorialCatalogLoadOptions = {}
): EditorialPageRecord[] {
  return loadEditorialCatalogWithSources(editorialRoot, options).records;
}

export const editorialCatalog = loadEditorialCatalog();
