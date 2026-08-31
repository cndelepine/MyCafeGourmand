import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { createAuthoredRecipeDocument } from "../../src/content/authored-recipe";
import {
  loadRecipeCatalogWithSources,
  validateNormalizedRecipeCatalog
} from "../../src/content/catalog";
import {
  loadEditorialCatalog
} from "../../src/content/editorial-catalog";
import {
  loadGalleryCatalog,
  validatePublicContentCatalogs
} from "../../src/content/gallery-catalog";
import {
  normalizeRecipeDocument,
  authoredRecipeInputSchema,
  recipeContentLimits
} from "../../src/content/schema";
import { createStaticWebAppConfig } from "../../src/content/staticwebapp";
import {
  validateCatalogBehavior,
  validateNormalizedRecipeDisplayText,
  validatePublicContentBehavior
} from "../../src/content/validation";
import { getReservedPublicPaths } from "../../src/lib/public-routes";
import { loadHandAuthoredStaticWebAppConfig } from "../staticwebapp-config";
import {
  readBoundedJsonFile,
  serializeJson,
  withExclusiveFileLock,
  writeAtomicFile
} from "./files";

export type NewRecipeOptions = {
  readonly createdAt?: string;
  readonly input: string;
  readonly recordId?: string;
  readonly write?: boolean;
};

export type NewRecipeDependencies = {
  readonly beforeInstall?: () => Promise<void> | void;
  readonly createRecordId?: () => string;
  readonly now?: () => Date;
  readonly recipesRoot?: string;
  readonly repositoryRoot?: string;
};

function validateProspectiveCatalog(
  repositoryRoot: string,
  recipesRoot: string,
  records: ReturnType<typeof validateNormalizedRecipeCatalog>
) {
  validateNormalizedRecipeDisplayText(records);
  validateCatalogBehavior(records);
  const editorial = loadEditorialCatalog(
    path.join(repositoryRoot, "content", "editorial")
  );
  const galleries = loadGalleryCatalog(
    path.join(repositoryRoot, "content", "galleries")
  );
  const publicCatalogs = validatePublicContentCatalogs(
    editorial,
    galleries,
    {
      recipeRecords: records,
      reservedPaths: getReservedPublicPaths(records)
    }
  );
  validatePublicContentBehavior(
    records,
    publicCatalogs.editorial,
    publicCatalogs.gallery
  );
  createStaticWebAppConfig(records, {
    editorialRecords: publicCatalogs.editorial,
    galleryRecords: publicCatalogs.gallery,
    handAuthoredConfig: loadHandAuthoredStaticWebAppConfig(repositoryRoot)
  });

  const rootStats = lstatSync(recipesRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Recipe root must be a regular non-symlink directory: "${recipesRoot}".`);
  }
}

export async function createNewRecipe(
  options: NewRecipeOptions,
  dependencies: NewRecipeDependencies = {}
) {
  const repositoryRoot = path.resolve(
    dependencies.repositoryRoot ?? process.cwd()
  );
  const recipesRoot = path.resolve(
    dependencies.recipesRoot ?? path.join(repositoryRoot, "content", "recipes")
  );
  const inputPath = path.resolve(repositoryRoot, options.input);
  const input = readBoundedJsonFile(
    inputPath,
    "Authored recipe input",
    recipeContentLimits.maxFileBytes,
    recipeContentLimits.maxJsonDepth
  );
  const authored = authoredRecipeInputSchema.parse(input.value);
  const recordId = options.recordId
    ?? dependencies.createRecordId?.()
    ?? randomUUID();
  const createdAt = options.createdAt
    ?? (dependencies.now?.() ?? new Date()).toISOString();
  const document = createAuthoredRecipeDocument(authored, recordId, createdAt);
  const serialized = serializeJson(document);
  if (Buffer.byteLength(serialized, "utf8") > recipeContentLimits.maxFileBytes) {
    throw new Error(
      `Authored recipe exceeds the maximum size of ${recipeContentLimits.maxFileBytes} bytes.`
    );
  }

  const validateAndCreate = async () => {
    const loaded = loadRecipeCatalogWithSources(recipesRoot);
    const proposed = validateNormalizedRecipeCatalog([
      ...loaded.records,
      normalizeRecipeDocument(document)
    ]);
    validateProspectiveCatalog(repositoryRoot, recipesRoot, proposed);

    const localeDirectory = path.join(recipesRoot, document.locale);
    const localeStats = lstatSync(localeDirectory);
    if (localeStats.isSymbolicLink() || !localeStats.isDirectory()) {
      throw new Error(
        `Recipe locale directory must be a regular non-symlink directory: "${localeDirectory}".`
      );
    }
    const realRecipesRoot = realpathSync(recipesRoot);
    const realLocaleDirectory = realpathSync(localeDirectory);
    if (
      realLocaleDirectory !== path.join(realRecipesRoot, document.locale)
    ) {
      throw new Error(`Recipe locale directory escapes the recipe root: "${localeDirectory}".`);
    }
    const destination = path.join(realLocaleDirectory, `${document.slug}.json`);
    const relativeDestination = path.relative(repositoryRoot, destination)
      .split(path.sep)
      .join("/");

    if (options.write === true) {
      await writeAtomicFile(destination, serialized, false, {
        beforeInstall: dependencies.beforeInstall,
        stagingDirectory: repositoryRoot
      });
    }

    return {
      mode: options.write === true ? "write" as const : "dry-run" as const,
      destination: relativeDestination,
      document
    };
  };

  return options.write === true
    ? withExclusiveFileLock(
      path.join(repositoryRoot, ".recipe-authoring.lock"),
      validateAndCreate
    )
    : validateAndCreate();
}
