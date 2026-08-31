import { z } from "zod";
import {
  localPathKey,
  validateCategorySlug,
  validateRecipeFileSlug,
  validateRecipeSlug,
  validateSafeLocalPath
} from "./url-path";
import {
  isWordPressRecipeMediaNamespacePath,
  parseWordPressRecipeMediaObjectKey,
  recipeMediaPathKey,
  validateRecipeMediaPath
} from "./media";
import { getRecipePath } from "./recipe-path";
import { localeValues } from "./locales";

export { localeValues };
export type { Locale } from "./locales";
export const localeSchema = z.enum(localeValues);

export const recipeContentLimits = Object.freeze({
  maxFileBytes: 1_048_576,
  maxCatalogRecords: 1_024,
  maxLocaleRecords: 512,
  maxJsonDepth: 32,
  maxStringLength: 65_536,
  maxRedirects: 256,
  maxTaxonomies: 512,
  maxEquipment: 256,
  maxIngredientGroups: 128,
  maxIngredientsPerGroup: 512,
  maxInstructionGroups: 128,
  maxStepsPerGroup: 512,
  maxMedia: 512
});

const boundedStringSchema = z.string().max(recipeContentLimits.maxStringLength);
const nonEmptyStringSchema = boundedStringSchema.min(1);
const numericStringSchema = nonEmptyStringSchema.regex(/^\d+$/u);
const timestampSchema = boundedStringSchema.datetime({ offset: true });

const recipeSlugSchema = nonEmptyStringSchema.superRefine((slug, context) => {
  try {
    validateRecipeSlug(slug);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

const recipeFileSlugSchema = nonEmptyStringSchema.superRefine((slug, context) => {
  try {
    validateRecipeFileSlug(slug);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

const categorySlugSchema = nonEmptyStringSchema.superRefine((slug, context) => {
  try {
    validateCategorySlug(slug);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

const exactQuantitySchema = z.strictObject({
  raw: nonEmptyStringSchema,
  value: z.number().positive(),
  min: z.never().optional(),
  max: z.never().optional(),
  unit: nonEmptyStringSchema.nullable(),
  scalable: z.boolean()
});

const rangeQuantitySchema = z.strictObject({
  raw: nonEmptyStringSchema,
  value: z.never().optional(),
  min: z.number().positive(),
  max: z.number().positive(),
  unit: nonEmptyStringSchema.nullable(),
  scalable: z.boolean()
}).superRefine((quantity, context) => {
  if (quantity.min > quantity.max) {
    context.addIssue({
      code: "custom",
      message: "A quantity range cannot have min greater than max."
    });
  }
});

const unparsedQuantitySchema = z.strictObject({
  raw: nonEmptyStringSchema,
  value: z.never().optional(),
  min: z.never().optional(),
  max: z.never().optional(),
  unit: nonEmptyStringSchema.nullable(),
  scalable: z.literal(false)
});

export const quantitySchema = z.union([
  exactQuantitySchema,
  rangeQuantitySchema,
  unparsedQuantitySchema
]);

export const durationSchema = z.strictObject({
  raw: nonEmptyStringSchema,
  minutes: z.number().int().nonnegative().safe().nullable()
});

export const nutritionAmountSchema = z.strictObject({
  raw: nonEmptyStringSchema,
  value: z.number().nonnegative().optional()
});

const nutritionWithCaloriesSchema = z.strictObject({
  calories: nutritionAmountSchema,
  servingSize: nutritionAmountSchema.nullable(),
  servingUnit: nonEmptyStringSchema.nullable()
});

const nutritionWithServingSizeSchema = z.strictObject({
  calories: z.null(),
  servingSize: nutritionAmountSchema,
  servingUnit: nonEmptyStringSchema.nullable()
});

const nutritionWithServingUnitSchema = z.strictObject({
  calories: z.null(),
  servingSize: z.null(),
  servingUnit: nonEmptyStringSchema
});

export const nutritionSchema = z.union([
  nutritionWithCaloriesSchema,
  nutritionWithServingSizeSchema,
  nutritionWithServingUnitSchema
]);

export const equipmentItemSchema = z.strictObject({
  sourceIndex: z.number().int().nonnegative().safe(),
  sourceId: numericStringSchema,
  name: nonEmptyStringSchema,
  amount: nonEmptyStringSchema.nullable(),
  notes: nonEmptyStringSchema.nullable()
});

export const servingsAdvancedSchema = z.strictObject({
  diameter: z.number().nonnegative(),
  height: z.number().nonnegative(),
  length: z.number().nonnegative(),
  shape: nonEmptyStringSchema,
  unit: nonEmptyStringSchema,
  width: z.number().nonnegative()
});

export const mediaAssetSchema = z.strictObject({
  id: nonEmptyStringSchema,
  sourceId: numericStringSchema.nullable(),
  path: nonEmptyStringSchema.superRefine((value, context) => {
    try {
      validateRecipeMediaPath(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }),
  alt: nonEmptyStringSchema.nullable(),
  width: z.number().int().positive().safe().nullable(),
  height: z.number().int().positive().safe().nullable()
}).superRefine((media, context) => {
  let isManagedNamespace: boolean;
  try {
    isManagedNamespace = isWordPressRecipeMediaNamespacePath(media.path);
  } catch {
    // The path schema reports the invalid path.
    return;
  }
  if (isManagedNamespace) {
    let attachmentId: string | undefined;
    try {
      attachmentId = parseWordPressRecipeMediaObjectKey(media.path).attachmentId;
    } catch {
      // The path schema reports the malformed managed object key.
      return;
    }
    if (media.sourceId !== attachmentId) {
      context.addIssue({
        code: "custom",
        message: `Managed recipe media source ID must match attachment ${attachmentId}.`,
        path: ["sourceId"]
      });
    }
    const expectedId = `wordpress-attachment:${attachmentId}`;
    if (media.id !== expectedId) {
      context.addIssue({
        code: "custom",
        message: `Managed recipe media ID must be ${expectedId}.`,
        path: ["id"]
      });
    }
  } else {
    if (media.sourceId !== null) {
      context.addIssue({
        code: "custom",
        message: "Recipe media with a WordPress source ID must use a managed media path.",
        path: ["sourceId"]
      });
    }
    if (media.id.startsWith("wordpress-attachment:")) {
      context.addIssue({
        code: "custom",
        message: "WordPress attachment media IDs must use a managed media path.",
        path: ["id"]
      });
    }
  }
});

export const redirectFromPathSchema = nonEmptyStringSchema.superRefine((value, context) => {
  try {
    validateSafeLocalPath(value, "Recipe redirect source");
    if (value === "/") {
      context.addIssue({
        code: "custom",
        message: "Recipe redirect source cannot be the site root."
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

type RedirectedRecipeRoute = {
  readonly locale: z.infer<typeof localeSchema>;
  readonly redirectFrom: readonly string[];
  readonly slug: string;
};

function addRecipeRedirectIssues(
  record: RedirectedRecipeRoute,
  context: z.RefinementCtx
) {
  let canonicalKey: string | undefined;
  try {
    canonicalKey = localPathKey(getRecipePath(record));
  } catch {
    // The slug schema reports the invalid canonical segment.
  }
  const redirectPaths = new Map<string, number>();

  for (const [index, redirectFrom] of record.redirectFrom.entries()) {
    let redirectKey: string;
    try {
      redirectKey = localPathKey(redirectFrom);
    } catch {
      continue;
    }

    if (canonicalKey !== undefined && redirectKey === canonicalKey) {
      context.addIssue({
        code: "custom",
        message: `Recipe redirect source must not equal the canonical recipe route: ${redirectFrom}`,
        path: ["redirectFrom", index]
      });
    }

    const previousIndex = redirectPaths.get(redirectKey);
    if (previousIndex !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Duplicate recipe redirect source: ${redirectFrom}`,
        path: ["redirectFrom", index]
      });
    } else {
      redirectPaths.set(redirectKey, index);
    }
  }
}

export const wordpressRecipeRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("recipe"),
  id: nonEmptyStringSchema,
  locale: localeSchema,
  translationGroupId: nonEmptyStringSchema.nullable(),
  slug: recipeSlugSchema,
  source: z.strictObject({
    system: z.literal("wordpress"),
    postId: numericStringSchema.nullable(),
    recipeId: numericStringSchema,
    postType: nonEmptyStringSchema.nullable(),
    plugin: z.enum(["wprm", "wpur"]),
    sourceSlug: nonEmptyStringSchema.nullable(),
    createdAt: timestampSchema.nullable(),
    modifiedAt: timestampSchema.nullable(),
    editorialPostId: numericStringSchema.nullable(),
    editorialPostType: nonEmptyStringSchema.nullable(),
    editorialSourceSlug: nonEmptyStringSchema.nullable(),
    editorialCreatedAt: timestampSchema.nullable(),
    editorialModifiedAt: timestampSchema.nullable(),
    wprmType: z.enum(["food", "howto", "other", "unknown", "malformed"]).optional(),
    wprmTypePresent: z.boolean().optional()
  }),
  redirectFrom: z.array(redirectFromPathSchema).max(recipeContentLimits.maxRedirects),
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema.nullable(),
  editorial: z.strictObject({
    content: nonEmptyStringSchema.nullable(),
    excerpt: nonEmptyStringSchema.nullable()
  }),
  taxonomies: z.array(z.strictObject({
    scope: z.enum(["recipe", "editorial"]).nullable(),
    taxonomy: nonEmptyStringSchema,
    sourceId: nonEmptyStringSchema.nullable(),
    sourceTaxonomyId: numericStringSchema.nullable(),
    name: nonEmptyStringSchema,
    slug: nonEmptyStringSchema
  })).max(recipeContentLimits.maxTaxonomies),
  recipe: z.strictObject({
    notes: nonEmptyStringSchema.nullable(),
    servings: quantitySchema.nullable(),
    servingsAdvancedEnabled: z.boolean().nullable().optional(),
    nutrition: nutritionSchema.nullable().optional(),
    servingsAdvanced: servingsAdvancedSchema.nullable().optional(),
    equipment: z.array(equipmentItemSchema)
      .max(recipeContentLimits.maxEquipment)
      .nullable()
      .optional(),
    times: z.strictObject({
      prep: durationSchema.nullable(),
      cook: durationSchema.nullable(),
      rest: durationSchema.nullable(),
      total: durationSchema.nullable(),
      custom: z.strictObject({
        label: nonEmptyStringSchema.nullable(),
        duration: durationSchema
      }).nullable()
    }),
    heroMediaId: nonEmptyStringSchema.nullable(),
    ingredientGroups: z.array(z.strictObject({
      name: nonEmptyStringSchema.nullable(),
      sourceIndex: z.number().int().nonnegative().safe(),
      items: z.array(z.strictObject({
        sourceIndex: z.number().int().nonnegative().safe(),
        raw: nonEmptyStringSchema,
        quantity: quantitySchema.nullable(),
        name: nonEmptyStringSchema,
        pluralName: nonEmptyStringSchema.optional(),
        notes: nonEmptyStringSchema.nullable()
      })).min(1).max(recipeContentLimits.maxIngredientsPerGroup)
    })).min(1).max(recipeContentLimits.maxIngredientGroups),
    instructionGroups: z.array(z.strictObject({
      name: nonEmptyStringSchema.nullable(),
      sourceIndex: z.number().int().nonnegative().safe(),
      steps: z.array(z.strictObject({
        sourceIndex: z.number().int().nonnegative().safe(),
        text: nonEmptyStringSchema,
        mediaId: nonEmptyStringSchema.nullable()
      })).min(1).max(recipeContentLimits.maxStepsPerGroup)
    })).min(1).max(recipeContentLimits.maxInstructionGroups)
  }),
  media: z.array(mediaAssetSchema).max(recipeContentLimits.maxMedia),
  seo: z.strictObject({
    title: nonEmptyStringSchema.nullable(),
    description: nonEmptyStringSchema.nullable()
  }).nullable()
}).superRefine((record, context) => {
  addRecipeRedirectIssues(record, context);

  const mediaIds = new Set<string>();
  const mediaPaths = new Set<string>();
  const mediaSourceIds = new Set<string>();
  for (const [index, media] of record.media.entries()) {
    if (mediaIds.has(media.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate media ID: ${media.id}`,
        path: ["media", index, "id"]
      });
    }
    mediaIds.add(media.id);
    let effectiveMediaPath: string;
    try {
      effectiveMediaPath = recipeMediaPathKey(media.path);
    } catch {
      // The media path schema reports the invalid path.
      continue;
    }
    if (mediaPaths.has(effectiveMediaPath)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate effective media path: ${media.path}`,
        path: ["media", index, "path"]
      });
    }
    mediaPaths.add(effectiveMediaPath);
    if (media.sourceId !== null) {
      if (mediaSourceIds.has(media.sourceId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate media source ID: ${media.sourceId}`,
          path: ["media", index, "sourceId"]
        });
      }
      mediaSourceIds.add(media.sourceId);
    }
  }

  const references = new Set([
    record.recipe.heroMediaId,
    ...record.recipe.instructionGroups.flatMap((group) =>
      group.steps.map((step) => step.mediaId)
    )
  ].filter((id): id is string => id !== null));

  for (const reference of references) {
    if (!mediaIds.has(reference)) {
      context.addIssue({
        code: "custom",
        message: `Unknown media reference: ${reference}`,
        path: ["media"]
      });
    }
  }

  for (const [index, media] of record.media.entries()) {
    if (!references.has(media.id)) {
      context.addIssue({
        code: "custom",
        message: `Unreferenced recipe media: ${media.id}`,
        path: ["media", index, "id"]
      });
    }
  }
});

export const recipeRecordSchema = wordpressRecipeRecordV1Schema;

const authoredCategorySchema = z.strictObject({
  name: nonEmptyStringSchema,
  slug: categorySlugSchema
});

const authoredEquipmentItemSchema = z.strictObject({
  name: nonEmptyStringSchema,
  amount: nonEmptyStringSchema.nullable(),
  notes: nonEmptyStringSchema.nullable()
});

const authoredIngredientGroupSchema = z.strictObject({
  name: nonEmptyStringSchema.nullable(),
  items: z.array(z.strictObject({
    raw: nonEmptyStringSchema,
    quantity: quantitySchema.nullable(),
    name: nonEmptyStringSchema,
    pluralName: nonEmptyStringSchema.optional(),
    notes: nonEmptyStringSchema.nullable()
  })).min(1).max(recipeContentLimits.maxIngredientsPerGroup)
});

const authoredInstructionGroupSchema = z.strictObject({
  name: nonEmptyStringSchema.nullable(),
  steps: z.array(z.strictObject({
    text: nonEmptyStringSchema
  })).min(1).max(recipeContentLimits.maxStepsPerGroup)
});

const authoredRecipeBodySchema = z.strictObject({
  notes: nonEmptyStringSchema.nullable(),
  servings: quantitySchema.nullable(),
  equipment: z.array(authoredEquipmentItemSchema)
    .max(recipeContentLimits.maxEquipment)
    .optional(),
  times: z.strictObject({
    prep: durationSchema.nullable(),
    cook: durationSchema.nullable(),
    rest: durationSchema.nullable(),
    total: durationSchema.nullable(),
    custom: z.strictObject({
      label: nonEmptyStringSchema.nullable(),
      duration: durationSchema
    }).nullable()
  }),
  ingredientGroups: z.array(authoredIngredientGroupSchema)
    .min(1)
    .max(recipeContentLimits.maxIngredientGroups),
  instructionGroups: z.array(authoredInstructionGroupSchema)
    .min(1)
    .max(recipeContentLimits.maxInstructionGroups)
});

const authoredSeoSchema = z.strictObject({
  title: nonEmptyStringSchema.nullable(),
  description: nonEmptyStringSchema.nullable()
}).nullable();

function addAuthoredTimestampIssues(
  value: { readonly modifiedAt: string | null; readonly publishedAt: string | null },
  context: z.RefinementCtx
) {
  if (
    value.publishedAt !== null
    && value.modifiedAt !== null
    && Date.parse(value.modifiedAt) < Date.parse(value.publishedAt)
  ) {
    context.addIssue({
      code: "custom",
      message: "Authored recipe modifiedAt cannot be earlier than publishedAt.",
      path: ["modifiedAt"]
    });
  }
}

export const authoredRecipeInputSchema = z.strictObject({
  locale: localeSchema,
  slug: recipeFileSlugSchema,
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema.nullable(),
  publishedAt: timestampSchema.nullable(),
  modifiedAt: timestampSchema.nullable(),
  categories: z.array(authoredCategorySchema).max(recipeContentLimits.maxTaxonomies),
  recipe: authoredRecipeBodySchema,
  seo: authoredSeoSchema
}).superRefine(addAuthoredTimestampIssues);

const authoredRecordIdSchema = z.uuid();

export const authoredRecipeDocumentV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal("recipe"),
  id: nonEmptyStringSchema,
  locale: localeSchema,
  translationGroupId: nonEmptyStringSchema.nullable(),
  slug: recipeFileSlugSchema,
  source: z.strictObject({
    system: z.literal("authored"),
    recordId: authoredRecordIdSchema,
    createdAt: timestampSchema
  }),
  redirectFrom: z.array(redirectFromPathSchema).max(recipeContentLimits.maxRedirects),
  title: nonEmptyStringSchema,
  description: nonEmptyStringSchema.nullable(),
  publishedAt: timestampSchema.nullable(),
  modifiedAt: timestampSchema.nullable(),
  categories: z.array(authoredCategorySchema).max(recipeContentLimits.maxTaxonomies),
  recipe: authoredRecipeBodySchema,
  seo: authoredSeoSchema
}).superRefine((record, context) => {
  addRecipeRedirectIssues(record, context);
  addAuthoredTimestampIssues(record, context);

  const expectedId = `authored:recipe:${record.source.recordId}`;
  if (record.id !== expectedId) {
    context.addIssue({
      code: "custom",
      message: `Authored recipe ID must be ${expectedId}.`,
      path: ["id"]
    });
  }
});

export const persistedRecipeDocumentSchema = z.discriminatedUnion("schemaVersion", [
  wordpressRecipeRecordV1Schema,
  authoredRecipeDocumentV2Schema
]);

export type WordPressRecipeRecordV1 = z.infer<
  typeof wordpressRecipeRecordV1Schema
>;
export type AuthoredRecipeInput = z.infer<typeof authoredRecipeInputSchema>;
export type AuthoredRecipeDocumentV2 = z.infer<
  typeof authoredRecipeDocumentV2Schema
>;
export type PersistedRecipeDocument = z.infer<
  typeof persistedRecipeDocumentSchema
>;

function normalizeAuthoredRecipe(
  document: AuthoredRecipeDocumentV2
) {
  return {
    ...document,
    editorial: {
      content: null,
      excerpt: null
    },
    taxonomies: document.categories.map((category) => ({
      scope: "editorial" as const,
      taxonomy: "category",
      sourceId: null,
      sourceTaxonomyId: null,
      name: category.name,
      slug: category.slug
    })),
    recipe: {
      ...document.recipe,
      servingsAdvancedEnabled: undefined,
      nutrition: undefined,
      servingsAdvanced: undefined,
      equipment: document.recipe.equipment?.map((item, sourceIndex) => ({
        ...item,
        sourceIndex,
        sourceId: null
      })),
      heroMediaId: null,
      ingredientGroups: document.recipe.ingredientGroups.map(
        (group, sourceIndex) => ({
          ...group,
          sourceIndex,
          items: group.items.map((item, itemIndex) => ({
            ...item,
            sourceIndex: itemIndex
          }))
        })
      ),
      instructionGroups: document.recipe.instructionGroups.map(
        (group, sourceIndex) => ({
          ...group,
          sourceIndex,
          steps: group.steps.map((step, stepIndex) => ({
            ...step,
            sourceIndex: stepIndex,
            mediaId: null
          }))
        })
      )
    },
    media: []
  };
}

export function normalizeRecipeDocument(
  document: PersistedRecipeDocument
) {
  return document.schemaVersion === 1
    ? document
    : normalizeAuthoredRecipe(document);
}

export type Quantity = z.infer<typeof quantitySchema>;
export type NutritionAmount = z.infer<typeof nutritionAmountSchema>;
export type Nutrition = z.infer<typeof nutritionSchema>;
export type EquipmentItem = z.infer<typeof equipmentItemSchema>;
export type ServingsAdvanced = z.infer<typeof servingsAdvancedSchema>;
export type RecipeRecord = ReturnType<typeof normalizeRecipeDocument>;
