import type { RecipeRecord } from "./schema";

export function getRecipePublishedAt(record: RecipeRecord) {
  return record.schemaVersion === 1
    ? record.source.createdAt
    : record.publishedAt;
}

export function getRecipeModifiedAt(record: RecipeRecord) {
  return record.schemaVersion === 1
    ? record.source.modifiedAt
    : record.modifiedAt;
}
