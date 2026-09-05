import {
  authoredRecipeDocumentV2Schema,
  authoredRecipeInputSchema,
  type AuthoredRecipeDocumentV2,
  type AuthoredRecipeInput
} from "./schema";

export function createAuthoredRecipeDocument(
  input: AuthoredRecipeInput,
  recordId: string,
  createdAt: string
): AuthoredRecipeDocumentV2 {
  const authored = authoredRecipeInputSchema.parse(input);
  return authoredRecipeDocumentV2Schema.parse({
    schemaVersion: 2,
    kind: "recipe",
    id: `authored:recipe:${recordId}`,
    locale: authored.locale,
    translationGroupId: null,
    slug: authored.slug,
    source: {
      system: "authored",
      recordId,
      createdAt
    },
    redirectFrom: [],
    title: authored.title,
    description: authored.description,
    publishedAt: authored.publishedAt,
    modifiedAt: authored.modifiedAt,
    categories: authored.categories,
    recipe: authored.recipe,
    seo: authored.seo
  });
}
