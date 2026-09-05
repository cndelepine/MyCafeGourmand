import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats
} from "node:fs";
import path from "node:path";
import {
  pathMatchesFileDescriptor,
  sameFileSystemIdentity,
  type FileSystemIdentity
} from "./file-system-identity";
import { parseJsonAtBoundary } from "./json-boundary";
import { getCanonicalRecipePath } from "./recipe-path";
import {
  recipeContentLimits,
  recipeRecordSchema,
  localeValues,
  type Locale,
  type RecipeRecord
} from "./schema";
import { localPathKey, validateSafeLocalPath } from "./url-path";

export const defaultRecipesRoot = path.resolve(process.cwd(), "content/recipes");

export type RecipeSourceFile = {
  locale: Locale;
  path: string;
};

type RecipeFileSystemIdentity = FileSystemIdentity & {
  path: string;
  realPath: string;
  descriptorIdentity: FileSystemIdentity | null;
};

type DiscoveredRecipeSourceFile = RecipeSourceFile & {
  identity: RecipeFileSystemIdentity;
};

type DiscoveredRecipeTree = {
  rootPath: string;
  root: RecipeFileSystemIdentity | null;
  localeDirectories: RecipeFileSystemIdentity[];
  files: DiscoveredRecipeSourceFile[];
};

export type RecipeContentTreeGuard = {
  assertUnchanged(): void;
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

function sameIdentity(
  left: RecipeFileSystemIdentity,
  right: RecipeFileSystemIdentity
) {
  return left.path === right.path
    && left.realPath === right.realPath
    && sameFileSystemIdentity(left, right)
    && (
      left.descriptorIdentity === null
        ? right.descriptorIdentity === null
        : right.descriptorIdentity !== null
          && sameFileSystemIdentity(left.descriptorIdentity, right.descriptorIdentity)
    );
}

function identityFromStats(
  entryPath: string,
  realPath: string,
  stats: BigIntStats
): RecipeFileSystemIdentity {
  return {
    path: entryPath,
    realPath,
    descriptorIdentity: null,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs
  };
}

function captureIdentity(
  entryPath: string,
  expectedType: "directory" | "file",
  typeError: string
) {
  const before = lstatSync(entryPath, { bigint: true });
  if (
    before.isSymbolicLink()
    || (expectedType === "directory" ? !before.isDirectory() : !before.isFile())
  ) {
    throw new Error(typeError);
  }
  const realPath = realpathSync.native(entryPath);
  let descriptorIdentity: FileSystemIdentity | null = null;
  if (process.platform === "win32") {
    // Path stats can omit the Windows volume serial. Keep a full, independent
    // descriptor snapshot rather than dropping device checks from the guard.
    const descriptor = openSync(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (
        (expectedType === "directory" ? !opened.isDirectory() : !opened.isFile())
        || !pathMatchesFileDescriptor(before, opened)
      ) {
        throw new Error(`Recipe content path changed while being inspected: "${entryPath}"`);
      }
      descriptorIdentity = identityFromStats(entryPath, realPath, opened);
    } finally {
      closeSync(descriptor);
    }
  }
  const after = lstatSync(entryPath, { bigint: true });
  const resolved = lstatSync(realPath, { bigint: true });
  const beforeIdentity = identityFromStats(entryPath, realPath, before);
  const afterIdentity = identityFromStats(entryPath, realPath, after);
  const resolvedIdentity = identityFromStats(entryPath, realPath, resolved);
  if (
    after.isSymbolicLink()
    || (expectedType === "directory" ? !after.isDirectory() : !after.isFile())
    || (expectedType === "directory" ? !resolved.isDirectory() : !resolved.isFile())
    || !sameIdentity(beforeIdentity, afterIdentity)
    || !sameIdentity(afterIdentity, resolvedIdentity)
  ) {
    throw new Error(`Recipe content path changed while being inspected: "${entryPath}"`);
  }
  return { ...afterIdentity, descriptorIdentity };
}

function assertRecordCount(count: number, label: string) {
  if (count > recipeContentLimits.maxCatalogRecords) {
    throw new Error(
      `${label} exceeds the maximum of ${recipeContentLimits.maxCatalogRecords} records.`
    );
  }
}

function rejectSymlink(entryPath: string) {
  throw new Error(`Symbolic links are not allowed in recipe content: "${entryPath}"`);
}

function assertJsonFile(
  entry: { isSymbolicLink(): boolean; isFile(): boolean; name: string },
  directory: string
) {
  const entryPath = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) {
    rejectSymlink(entryPath);
  }
  if (!entry.isFile() || path.extname(entry.name) !== ".json") {
    throw new Error(
      `Unsupported recipe content file: "${entryPath}". ` +
      "Only lowercase <slug>.json regular files are permitted in recipe locale folders."
    );
  }
}

function discoverRecipeTree(
  recipesRoot: string = defaultRecipesRoot
): DiscoveredRecipeTree {
  const root = path.resolve(recipesRoot);

  if (!existsSync(root)) {
    return {
      rootPath: root,
      root: null,
      localeDirectories: [],
      files: []
    };
  }
  const rootIdentity = captureIdentity(
    root,
    "directory",
    `Recipe content root is not a directory: "${root}"`
  );

  const localeIdentityByName = new Map<Locale, RecipeFileSystemIdentity>();
  for (const entry of getDirectoryEntries(root)) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      rejectSymlink(entryPath);
    }
    if (!entry.isDirectory()) {
      throw new Error(
        `Unsupported recipe content file: "${entryPath}". ` +
        "Only en, fr, and ru locale directories are permitted."
      );
    }
    if (!localeValues.some((locale) => locale === entry.name)) {
      throw new Error(`Unsupported locale folder "${entry.name}" in "${root}"`);
    }
    const locale = entry.name as Locale;
    localeIdentityByName.set(locale, captureIdentity(
      entryPath,
      "directory",
      `Locale content path is not a directory: "${entryPath}"`
    ));
  }

  const localeDirectories = localeValues.flatMap((locale) => {
    const identity = localeIdentityByName.get(locale);
    return identity === undefined ? [] : [identity];
  });
  const files = localeValues.flatMap((locale) => {
    const localeIdentity = localeIdentityByName.get(locale);
    if (localeIdentity === undefined) {
      return [];
    }
    const localeDirectory = localeIdentity.path;

    const entries = getDirectoryEntries(localeDirectory);
    if (entries.length > recipeContentLimits.maxLocaleRecords) {
      throw new Error(
        `Recipe locale "${locale}" exceeds the maximum of ` +
        `${recipeContentLimits.maxLocaleRecords} records.`
      );
    }
    for (const entry of entries) {
      const entryPath = path.join(localeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        rejectSymlink(entryPath);
      }
      if (entry.isDirectory()) {
        throw new Error(`Unsupported recipe content directory: "${entryPath}"`);
      }
      assertJsonFile(entry, localeDirectory);
    }

    return entries
      .map((entry) => entry.name)
      .sort(compareNames)
      .map((fileName) => ({
        locale,
        path: path.join(localeDirectory, fileName),
        identity: captureIdentity(
          path.join(localeDirectory, fileName),
          "file",
          `Recipe content path is not a regular file: ` +
          `"${path.join(localeDirectory, fileName)}"`
        )
      }));
  });
  assertRecordCount(files.length, "Recipe catalog");
  return {
    rootPath: root,
    root: rootIdentity,
    localeDirectories,
    files
  };
}

function publicSourceFiles(tree: DiscoveredRecipeTree): RecipeSourceFile[] {
  return tree.files.map(({ locale, path: sourcePath }) => ({
    locale,
    path: sourcePath
  }));
}

function sameIdentityList(
  left: readonly RecipeFileSystemIdentity[],
  right: readonly RecipeFileSystemIdentity[]
) {
  return left.length === right.length
    && left.every((identity, index) => {
      const other = right[index];
      return other !== undefined && sameIdentity(identity, other);
    });
}

function assertRecipeTreeUnchanged(snapshot: DiscoveredRecipeTree) {
  let current: DiscoveredRecipeTree;
  try {
    current = discoverRecipeTree(snapshot.rootPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Recipe content tree changed during catalog load: ${message}`,
      { cause: error }
    );
  }
  const rootsMatch = snapshot.root === null
    ? current.root === null
    : current.root !== null && sameIdentity(snapshot.root, current.root);
  if (
    !rootsMatch
    || !sameIdentityList(snapshot.localeDirectories, current.localeDirectories)
    || !sameIdentityList(
      snapshot.files.map((file) => file.identity),
      current.files.map((file) => file.identity)
    )
  ) {
    throw new Error(
      `Recipe content tree changed during catalog load: "${snapshot.rootPath}"`
    );
  }
}

/**
 * Discover JSON records in locale order and filename order. Missing locale
 * folders are intentional: an untranslated locale has no records yet.
 */
export function discoverRecipeFiles(
  recipesRoot: string = defaultRecipesRoot
): RecipeSourceFile[] {
  return publicSourceFiles(discoverRecipeTree(recipesRoot));
}

export function createRecipeContentTreeGuard(
  recipesRoot: string = defaultRecipesRoot
): RecipeContentTreeGuard {
  const snapshot = discoverRecipeTree(recipesRoot);
  return Object.freeze({
    assertUnchanged: () => assertRecipeTreeUnchanged(snapshot)
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

function readRecipeRecord(source: DiscoveredRecipeSourceFile) {
  let contents: string;

  try {
    const descriptor = openSync(
      source.path,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const stats = fstatSync(descriptor, { bigint: true });
      const openedIdentity = identityFromStats(
        source.path,
        source.identity.realPath,
        stats
      );
      if (
        !stats.isFile()
        || !pathMatchesFileDescriptor(source.identity, openedIdentity)
        || (
          source.identity.descriptorIdentity !== null
          && !sameFileSystemIdentity(source.identity.descriptorIdentity, openedIdentity)
        )
        || !sameIdentity(source.identity, captureIdentity(
          source.path,
          "file",
          "source path is no longer a regular file"
        ))
      ) {
        throw new Error("source identity changed before it was read");
      }
      if (stats.size > BigInt(recipeContentLimits.maxFileBytes)) {
        throw new Error(
          `file exceeds the maximum size of ${recipeContentLimits.maxFileBytes} bytes`
        );
      }
      const bytes = readFileSync(descriptor);
      if (bytes.byteLength > recipeContentLimits.maxFileBytes) {
        throw new Error(
          `file exceeds the maximum size of ${recipeContentLimits.maxFileBytes} bytes`
        );
      }
      contents = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true
      }).decode(bytes);
      const afterRead = fstatSync(descriptor, { bigint: true });
      if (!sameIdentity(
        openedIdentity,
        identityFromStats(source.path, source.identity.realPath, afterRead)
      )) {
        throw new Error("source identity changed while it was read");
      }
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read recipe file "${source.path}": ${message}`, {
      cause: error
    });
  }

  let input: unknown;
  try {
    input = parseJsonAtBoundary(contents, {
      maxDepth: recipeContentLimits.maxJsonDepth
    });
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
  const fileName = path.basename(source.path);
  if (fileName !== fileName.normalize("NFC")) {
    throw new Error(
      `Recipe filename must use NFC-normalized Unicode: "${source.path}". ` +
      `Rename it to "${fileName.normalize("NFC")}".`
    );
  }
  const expectedFileName = `${record.slug}.json`;
  if (fileName !== expectedFileName) {
    throw new Error(
      `Filename-slug mismatch in "${source.path}": expected "${expectedFileName}" ` +
      `for recipe slug "${record.slug}".`
    );
  }

  return record;
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

function sourceWordPressPath(record: RecipeRecord) {
  if (
    record.source.editorialPostId === null
    || record.source.editorialSourceSlug === null
  ) {
    return null;
  }
  const prefix = record.locale === "en" ? "" : `/${record.locale}`;
  return `${prefix}/${record.source.editorialSourceSlug}/`;
}

export function validateCatalog(
  catalog?: readonly unknown[],
  options: CatalogValidationOptions = {}
): RecipeRecord[] {
  const input = catalog ?? loadRecipeCatalogWithSources().records;
  assertRecordCount(input.length, "Recipe catalog");
  if (
    options.sourceFiles !== undefined
    && options.sourceFiles.length !== input.length
  ) {
    throw new Error(
      `Recipe source-file count ${options.sourceFiles.length} does not match ` +
      `catalog count ${input.length}.`
    );
  }
  const parsed = input.map((record, index) =>
    parseRecipeRecord(record, options.sourceFiles?.[index]?.path)
  );
  const ids = new Map<string, number>();
  const localizedSlugs = new Map<string, number>();
  const translationGroupLocales = new Map<string, number>();
  const canonicalRoutes = new Map<string, number>();
  const wordpressSourceRoutes = new Map<string, number[]>();

  for (const [index, record] of parsed.entries()) {
    const sourcePath = options.sourceFiles?.[index]?.path;
    const context = sourcePath ? ` in "${sourcePath}"` : "";

    if (ids.has(record.id)) {
      throw new Error(`Duplicate content ID${context}: ${record.id}`);
    }
    ids.set(record.id, index);
    const expectedId = `wordpress:${record.source.plugin}:${record.source.recipeId}`;
    if (record.id !== expectedId) {
      throw new Error(
        `Recipe content ID does not match source identity${context}: ` +
        `expected ${expectedId}, received ${record.id}`
      );
    }

    const localizedSlug = `${record.locale}:${record.slug}`;
    if (localizedSlugs.has(localizedSlug)) {
      throw new Error(`Duplicate localized slug${context}: ${localizedSlug}`);
    }
    localizedSlugs.set(localizedSlug, index);
    const canonicalRoute = getCanonicalRecipePath(record);
    const canonicalKey = routeKey(canonicalRoute, "Recipe canonical route");
    const previousCanonicalIndex = canonicalRoutes.get(canonicalKey);
    if (previousCanonicalIndex !== undefined) {
      const previousSourcePath = options.sourceFiles?.[previousCanonicalIndex]?.path;
      const previousContext = previousSourcePath
        ? ` (already defined in "${previousSourcePath}")`
        : "";
      throw new Error(
        `Duplicate recipe canonical route${context}: ${canonicalRoute}${previousContext}`
      );
    }
    canonicalRoutes.set(canonicalKey, index);

    const wordpressPath = sourceWordPressPath(record);
    if (wordpressPath !== null) {
      const wordpressKey = routeKey(
        wordpressPath,
        "WordPress recipe source route"
      );
      const sourceIndexes = wordpressSourceRoutes.get(wordpressKey) ?? [];
      sourceIndexes.push(index);
      wordpressSourceRoutes.set(wordpressKey, sourceIndexes);
    }

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

  const redirectSources = new Map<string, number>();
  for (const [index, record] of parsed.entries()) {
    const sourcePath = options.sourceFiles?.[index]?.path;
    const context = sourcePath ? ` in "${sourcePath}"` : "";
    for (const redirectFrom of record.redirectFrom) {
      const redirectKey = routeKey(redirectFrom, "Recipe redirect source");
      if (canonicalRoutes.has(redirectKey)) {
        throw new Error(
          `Recipe redirect source collides with a canonical route${context}: ${redirectFrom}`
        );
      }
      const previousIndex = redirectSources.get(redirectKey);
      if (previousIndex !== undefined) {
        const previousSourcePath = options.sourceFiles?.[previousIndex]?.path;
        const previousContext = previousSourcePath
          ? ` (already defined in "${previousSourcePath}")`
          : "";
        throw new Error(
          `Duplicate recipe redirect source${context}: ${redirectFrom}${previousContext}`
        );
      }
      redirectSources.set(redirectKey, index);
    }
  }

  for (const [wordpressKey, sourceIndexes] of wordpressSourceRoutes) {
    if (sourceIndexes.length !== 1) {
      continue;
    }
    const index = sourceIndexes[0]!;
    const redirectOwner = redirectSources.get(wordpressKey);
    if (redirectOwner !== index) {
      const record = parsed[index]!;
      const sourcePath = options.sourceFiles?.[index]?.path;
      const context = sourcePath ? ` in "${sourcePath}"` : "";
      throw new Error(
        `Recipe does not preserve its WordPress source URL${context}: ` +
        `${sourceWordPressPath(record)}`
      );
    }
  }

  return parsed;
}

export function loadRecipeCatalogWithSources(
  recipesRoot: string = defaultRecipesRoot
): LoadedRecipeCatalog {
  const snapshot = discoverRecipeTree(recipesRoot);
  let records: RecipeRecord[];
  try {
    records = snapshot.files.map(readRecipeRecord);
  } catch (loadError) {
    try {
      assertRecipeTreeUnchanged(snapshot);
    } catch (treeError) {
      if (loadError instanceof Error) {
        const causes = loadError.cause === undefined
          ? [treeError]
          : [loadError.cause, treeError];
        loadError.cause = new AggregateError(
          causes,
          "Recipe loading failed while the content tree also changed."
        );
      }
    }
    throw loadError;
  }
  assertRecipeTreeUnchanged(snapshot);
  const files = publicSourceFiles(snapshot);
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
