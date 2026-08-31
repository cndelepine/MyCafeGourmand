export const recipeFieldUsageValues = [
  "published",
  "structured-data",
  "provenance-only"
] as const;

export type RecipeFieldUsage = typeof recipeFieldUsageValues[number];

export type RecipeFieldClassification = {
  readonly path: string;
  readonly versions: readonly (1 | 2)[];
  readonly uses: readonly RecipeFieldUsage[];
};

export const recipeFieldClassifications: readonly RecipeFieldClassification[] =
  Object.freeze([
    { path: "schemaVersion", versions: [1, 2], uses: ["provenance-only"] },
    { path: "kind", versions: [1, 2], uses: ["provenance-only"] },
    { path: "id", versions: [1, 2], uses: ["published"] },
    { path: "locale", versions: [1, 2], uses: ["published", "structured-data"] },
    { path: "translationGroupId", versions: [1, 2], uses: ["published"] },
    { path: "slug", versions: [1, 2], uses: ["published", "structured-data"] },
    {
      path: "source.createdAt/source.modifiedAt",
      versions: [1],
      uses: ["structured-data", "provenance-only"]
    },
    {
      path: "source.* except v1 publication timestamps",
      versions: [1, 2],
      uses: ["provenance-only"]
    },
    { path: "redirectFrom[]", versions: [1, 2], uses: ["published"] },
    { path: "title", versions: [1, 2], uses: ["published", "structured-data"] },
    { path: "description", versions: [1, 2], uses: ["published", "structured-data"] },
    { path: "editorial.*", versions: [1], uses: ["provenance-only"] },
    { path: "taxonomies[].name", versions: [1], uses: ["published", "structured-data"] },
    { path: "taxonomies[].slug", versions: [1], uses: ["published"] },
    {
      path: "taxonomies[].scope/sourceId/sourceTaxonomyId",
      versions: [1],
      uses: ["provenance-only"]
    },
    { path: "categories[].name", versions: [2], uses: ["published", "structured-data"] },
    { path: "categories[].slug", versions: [2], uses: ["published"] },
    { path: "publishedAt/modifiedAt", versions: [2], uses: ["structured-data"] },
    { path: "recipe.notes", versions: [1, 2], uses: ["published"] },
    {
      path: "recipe.servings/times",
      versions: [1, 2],
      uses: ["published", "structured-data"]
    },
    {
      path: "recipe.nutrition",
      versions: [1],
      uses: ["structured-data"]
    },
    { path: "recipe.equipment[]", versions: [1, 2], uses: ["published"] },
    {
      path: "recipe.ingredientGroups[].items[]",
      versions: [1, 2],
      uses: ["published", "structured-data"]
    },
    {
      path: "recipe.instructionGroups[].steps[]",
      versions: [1, 2],
      uses: ["published", "structured-data"]
    },
    {
      path: "recipe.*.sourceIndex/sourceId",
      versions: [1],
      uses: ["provenance-only"]
    },
    { path: "recipe.*.mediaId/heroMediaId", versions: [1], uses: ["published", "structured-data"] },
    { path: "media[].path/alt/width/height", versions: [1], uses: ["published", "structured-data"] },
    { path: "media[].id/sourceId", versions: [1], uses: ["provenance-only"] },
    { path: "seo.*", versions: [1, 2], uses: ["published"] }
  ]);
