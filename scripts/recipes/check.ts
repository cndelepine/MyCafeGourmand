import path from "node:path";
import {
  loadRecipeCatalogWithSources,
  parsePersistedRecipeDocument
} from "../../src/content/catalog";
import {
  recipeContentLimits
} from "../../src/content/schema";
import { createStaticWebAppConfig } from "../../src/content/staticwebapp";
import {
  validateCatalogBehavior,
  validateContent
} from "../../src/content/validation";
import { loadHandAuthoredStaticWebAppConfig } from "../staticwebapp-config";
import {
  readBoundedJsonFile,
  serializeJson
} from "./files";
import {
  createRecipeReport,
  serializeRecipeReport
} from "./report";
import { assertRecipeSchemaCurrent } from "./schema-output";

export function checkRecipeDocumentFormatting(recipesRoot: string) {
  const loaded = loadRecipeCatalogWithSources(recipesRoot);
  validateCatalogBehavior(loaded.records);

  for (const file of loaded.files) {
    const source = readBoundedJsonFile(
      file.path,
      "Recipe document",
      recipeContentLimits.maxFileBytes,
      recipeContentLimits.maxJsonDepth
    );
    const document = parsePersistedRecipeDocument(source.value, file.path);
    if (source.contents !== serializeJson(document)) {
      throw new Error(
        `Recipe document is not canonically formatted: "${file.path}". ` +
        "Use two-space JSON indentation and a final newline without changing value semantics."
      );
    }
  }
  return loaded;
}

export function checkRecipeAuthoring(repositoryRoot: string = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const recipesRoot = path.join(root, "content", "recipes");
  const loaded = checkRecipeDocumentFormatting(recipesRoot);
  assertRecipeSchemaCurrent(root);
  const firstReport = serializeRecipeReport(createRecipeReport(recipesRoot));
  const secondReport = serializeRecipeReport(createRecipeReport(recipesRoot));
  if (firstReport !== secondReport) {
    throw new Error("Recipe maintenance report generation is not deterministic.");
  }

  const validated = validateContent({
    editorialGalleryMediaManifestPath: path.join(
      root,
      "content",
      "editorial-gallery-media-manifest.json"
    ),
    editorialRoot: path.join(root, "content", "editorial"),
    galleriesRoot: path.join(root, "content", "galleries"),
    mediaManifestPath: path.join(root, "content", "media-manifest.json"),
    publicRoot: path.join(root, "public"),
    recipesRoot
  });
  createStaticWebAppConfig(validated.records, {
    editorialRecords: validated.editorialRecords,
    galleryRecords: validated.galleryRecords,
    handAuthoredConfig: loadHandAuthoredStaticWebAppConfig(root)
  });

  return {
    records: loaded.records.length,
    files: loaded.files.length
  };
}
