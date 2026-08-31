import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { recipeFieldClassifications } from "../../src/content/recipe-field-usage";
import { recipeRuntimeOnlyInvariants } from "../../src/content/recipe-runtime-invariants";
import { persistedRecipeDocumentSchema } from "../../src/content/schema";
import { ensureDirectory, serializeJson, writeAtomicFile } from "./files";

export const recipeSchemaRelativePath = "content/schemas/recipe.schema.json";

export function createRecipeJsonSchema() {
  const generated = z.toJSONSchema(persistedRecipeDocumentSchema);
  const { $schema, ...structuralSchema } = generated;
  return {
    $schema,
    $id: "https://mycafegourmand.com/schemas/recipe.schema.json",
    title: "My Cafe Gourmand persisted recipe document",
    description:
      "Strict persisted WordPress v1 and authored v2 recipe documents. " +
      "Catalog-wide identity, route, redirect, translation, and reference closure " +
      "are enforced by npm run recipes -- check.",
    $comment:
      "This schema provides structural IDE validation, not complete publication validation. " +
      "The x-runtime-invariants list and catalog-wide checks require npm run recipes -- check.",
    "x-field-usage": recipeFieldClassifications,
    "x-runtime-invariants": recipeRuntimeOnlyInvariants,
    ...structuralSchema
  };
}

export function serializeRecipeJsonSchema() {
  return serializeJson(createRecipeJsonSchema());
}

export function recipeSchemaPath(repositoryRoot: string) {
  return path.join(repositoryRoot, recipeSchemaRelativePath);
}

export function assertRecipeSchemaCurrent(repositoryRoot: string) {
  const schemaPath = recipeSchemaPath(repositoryRoot);
  let current: string;
  try {
    current = readFileSync(schemaPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Recipe JSON Schema is missing or unreadable: ${message}`, {
      cause: error
    });
  }
  const expected = serializeRecipeJsonSchema();
  if (current !== expected) {
    throw new Error(
      `Recipe JSON Schema is stale: "${schemaPath}". ` +
      "Run npm run recipes -- schema --write."
    );
  }
}

export async function writeRecipeJsonSchema(repositoryRoot: string) {
  const schemaPath = recipeSchemaPath(repositoryRoot);
  await ensureDirectory(path.dirname(schemaPath));
  await writeAtomicFile(schemaPath, serializeRecipeJsonSchema(), true);
  return schemaPath;
}
