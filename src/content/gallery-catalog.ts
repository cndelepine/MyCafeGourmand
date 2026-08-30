import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import {
  loadRecipeCatalog,
  validateCatalog
} from "./catalog";
import {
  editorialCatalog,
  validateEditorialCatalog
} from "./editorial-catalog";
import {
  collectEditorialBlockReferences,
  publicContentLimits,
  type EditorialPageRecord
} from "./editorial-schema";
import type { RecipeRecord } from "./schema";
import {
  galleryCanonicalPath,
  galleryRecordSchema,
  type GalleryRecord
} from "./gallery-schema";
import { localPathKey, validateSafeLocalPath } from "./url-path";

export const defaultGalleriesRoot = path.resolve(
  process.cwd(),
  "content",
  "galleries"
);

export type GallerySourceFile = {
  path: string;
};

export type LoadedGalleryCatalog = {
  records: GalleryRecord[];
  files: GallerySourceFile[];
};

export type GalleryCatalogValidationOptions = {
  sourceFiles?: readonly GallerySourceFile[];
  editorialRecords?: readonly EditorialPageRecord[];
  reservedPaths?: readonly string[];
};

type GalleryCatalogLoadOptions = Pick<
  GalleryCatalogValidationOptions,
  "editorialRecords" | "reservedPaths"
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
    throw new Error(`Unable to discover gallery files in "${directory}": ${message}`, {
      cause: error
    });
  }
}

function compareNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertRecordCount(count: number, label: string) {
  if (count > publicContentLimits.maxRecords) {
    throw new Error(
      `${label} exceeds the maximum of ${publicContentLimits.maxRecords} records.`
    );
  }
}

export function discoverGalleryFiles(
  galleriesRoot: string = defaultGalleriesRoot
): GallerySourceFile[] {
  const root = path.resolve(galleriesRoot);

  if (!existsSync(root)) {
    return [];
  }
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Gallery content root is not a directory: "${root}"`);
  }

  const entries = getDirectoryEntries(root);
  assertRecordCount(entries.length, "Gallery catalog");
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in gallery content: "${entryPath}"`);
    }
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") {
      throw new Error(`Unsupported gallery content file or directory: "${entryPath}"`);
    }
  }

  return entries
    .map((entry) => entry.name)
    .sort(compareNames)
    .map((fileName) => ({
      path: path.join(root, fileName)
    }));
}

export function parseGalleryRecord(
  input: unknown,
  sourcePath?: string
): GalleryRecord {
  const result = galleryRecordSchema.safeParse(input);

  if (!result.success) {
    const context = sourcePath ? ` in "${sourcePath}"` : "";
    throw new Error(
      `Invalid gallery record${context}: ${formatSchemaIssues(result.error.issues)}`,
      { cause: result.error }
    );
  }

  return result.data;
}

function readGalleryRecord(source: GallerySourceFile) {
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
    throw new Error(`Unable to read gallery file "${source.path}": ${message}`, {
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

  return parseGalleryRecord(input, source.path);
}

function routeKey(value: string, label: string) {
  try {
    validateSafeLocalPath(value, label);
    return localPathKey(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is unsafe: ${value}: ${message}`, { cause: error });
  }
}

function validateReservedPaths(paths: readonly string[]) {
  return new Set(paths.map((value) => routeKey(value, "Reserved public route")));
}

function validateEditorialRouteCollisions(
  editorialRecords: readonly EditorialPageRecord[],
  galleryRouteKey: string
) {
  for (const record of editorialRecords) {
    if (routeKey(record.canonicalPath, "Editorial canonical route") === galleryRouteKey) {
      throw new Error(
        `Editorial canonical route collides with the gallery route: ${record.canonicalPath}`
      );
    }
    for (const redirectFrom of record.redirectFrom ?? []) {
      if (routeKey(redirectFrom, "Editorial redirect source") === galleryRouteKey) {
        throw new Error(
          `Editorial redirect source collides with the gallery route: ${redirectFrom}`
        );
      }
    }
  }
}

export function validateGalleryCatalog(
  catalog?: readonly unknown[],
  options: GalleryCatalogValidationOptions = {}
): GalleryRecord[] {
  const input = catalog ?? loadGalleryCatalogWithSources().records;
  assertRecordCount(input.length, "Gallery catalog");
  const parsed = input.map((record, index) =>
    parseGalleryRecord(record, options.sourceFiles?.[index]?.path)
  );

  if (parsed.length > 1) {
    throw new Error(
      `Gallery catalog must contain at most one language-neutral record; found ${parsed.length}.`
    );
  }

  const route = routeKey(galleryCanonicalPath, "Gallery canonical route");
  const reservedRoutes = validateReservedPaths(options.reservedPaths ?? []);
  if (reservedRoutes.has(route)) {
    throw new Error(`Gallery route collides with a reserved public route: ${galleryCanonicalPath}`);
  }
  if (options.editorialRecords !== undefined) {
    validateEditorialRouteCollisions(options.editorialRecords, route);
  }

  const ids = new Set<string>();
  for (const [index, record] of parsed.entries()) {
    const sourcePath = options.sourceFiles?.[index]?.path;
    const context = sourcePath ? ` in "${sourcePath}"` : "";
    if (ids.has(record.id)) {
      throw new Error(`Duplicate gallery content ID${context}: ${record.id}`);
    }
    ids.add(record.id);
  }

  return parsed;
}

export function loadGalleryCatalogWithSources(
  galleriesRoot: string = defaultGalleriesRoot,
  options: GalleryCatalogLoadOptions = {}
): LoadedGalleryCatalog {
  const files = discoverGalleryFiles(galleriesRoot);
  const records = files.map(readGalleryRecord);
  return {
    files,
    records: validateGalleryCatalog(records, {
      ...options,
      sourceFiles: files
    })
  };
}

export function loadGalleryCatalog(
  galleriesRoot: string = defaultGalleriesRoot,
  options: GalleryCatalogLoadOptions = {}
): GalleryRecord[] {
  return loadGalleryCatalogWithSources(galleriesRoot, options).records;
}

export function validatePublicContentCatalogs(
  editorialRecords: readonly unknown[] = editorialCatalog,
  galleryRecords: readonly unknown[] = loadGalleryCatalog(),
  options: {
    reservedPaths?: readonly string[];
    recipeRecords?: readonly RecipeRecord[];
  } = {}
) {
  const editorial = validateEditorialCatalog(editorialRecords, {
    reservedPaths: options.reservedPaths
  });
  const gallery = validateGalleryCatalog(galleryRecords, {
    editorialRecords: editorial,
    reservedPaths: options.reservedPaths
  });
  validateEditorialReferenceClosure(
    editorial,
    gallery,
    options.recipeRecords === undefined
      ? loadRecipeCatalog()
      : validateCatalog(options.recipeRecords)
  );
  return { editorial, gallery };
}

function validateEditorialReferenceClosure(
  editorialRecords: readonly EditorialPageRecord[],
  galleryRecords: readonly GalleryRecord[],
  recipeRecords: readonly RecipeRecord[]
) {
  const editorialIds = new Set(editorialRecords.map((record) => record.id));
  const galleryIds = new Set(galleryRecords.map((record) => record.id));
  const recipeIds = new Set(recipeRecords.map((record) => record.id));

  for (const record of editorialRecords) {
    const references = collectEditorialBlockReferences(record.content);
    for (const recipeId of references.recipeIds) {
      if (!recipeIds.has(recipeId)) {
        throw new Error(
          `Editorial recipe-card reference does not identify a promoted recipe: ${recipeId}`
        );
      }
    }
    for (const pageId of references.pageIds) {
      if (!editorialIds.has(pageId)) {
        throw new Error(
          `Editorial page-card reference does not identify a promoted editorial page: ${pageId}`
        );
      }
    }
    for (const galleryId of references.galleryIds) {
      if (!galleryIds.has(galleryId)) {
        throw new Error(
          `Editorial gallery reference does not identify a promoted gallery: ${galleryId}`
        );
      }
    }
  }
}

export const galleryCatalog = loadGalleryCatalog();
