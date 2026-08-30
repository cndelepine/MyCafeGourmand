import { z } from "zod";
import {
  localPathKey,
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

export const quantitySchema = z.strictObject({
  raw: nonEmptyStringSchema,
  value: z.number().positive().optional(),
  min: z.number().positive().optional(),
  max: z.number().positive().optional(),
  unit: nonEmptyStringSchema.nullable(),
  scalable: z.boolean()
}).superRefine((quantity, context) => {
  const hasValue = quantity.value !== undefined;
  const hasRange = quantity.min !== undefined || quantity.max !== undefined;

  if (hasValue && hasRange) {
    context.addIssue({
      code: "custom",
      message: "A quantity cannot contain both a value and a range."
    });
  }
  if ((quantity.min === undefined) !== (quantity.max === undefined)) {
    context.addIssue({
      code: "custom",
      message: "A quantity range requires both min and max."
    });
  }
  if (quantity.min !== undefined && quantity.max !== undefined && quantity.min > quantity.max) {
    context.addIssue({
      code: "custom",
      message: "A quantity range cannot have min greater than max."
    });
  }
  if (quantity.scalable && !hasValue && !hasRange) {
    context.addIssue({
      code: "custom",
      message: "Only a parsed quantity can be scalable."
    });
  }
});

export const durationSchema = z.strictObject({
  raw: nonEmptyStringSchema,
  minutes: z.number().int().nonnegative().safe().nullable()
});

export const nutritionAmountSchema = z.strictObject({
  raw: nonEmptyStringSchema,
  value: z.number().nonnegative().optional()
});

export const nutritionSchema = z.strictObject({
  calories: nutritionAmountSchema.nullable(),
  servingSize: nutritionAmountSchema.nullable(),
  servingUnit: nonEmptyStringSchema.nullable()
}).superRefine((nutrition, context) => {
  if (
    nutrition.calories === null
    && nutrition.servingSize === null
    && nutrition.servingUnit === null
  ) {
    context.addIssue({
      code: "custom",
      message: "Nutrition must contain at least one source value."
    });
  }
});

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

export const recipeRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("recipe"),
  id: nonEmptyStringSchema,
  locale: localeSchema,
  translationGroupId: nonEmptyStringSchema.nullable(),
  slug: nonEmptyStringSchema.superRefine((slug, context) => {
    try {
      validateRecipeSlug(slug);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }),
  source: z.strictObject({
    system: z.literal("wordpress"),
    postId: numericStringSchema.nullable(),
    recipeId: numericStringSchema,
    postType: nonEmptyStringSchema.nullable(),
    plugin: z.enum(["wprm", "wpur"]),
    sourceSlug: nonEmptyStringSchema.nullable(),
    createdAt: boundedStringSchema.datetime({ offset: true }).nullable(),
    modifiedAt: boundedStringSchema.datetime({ offset: true }).nullable(),
    editorialPostId: numericStringSchema.nullable(),
    editorialPostType: nonEmptyStringSchema.nullable(),
    editorialSourceSlug: nonEmptyStringSchema.nullable(),
    editorialCreatedAt: boundedStringSchema.datetime({ offset: true }).nullable(),
    editorialModifiedAt: boundedStringSchema.datetime({ offset: true }).nullable(),
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

export type Quantity = z.infer<typeof quantitySchema>;
export type NutritionAmount = z.infer<typeof nutritionAmountSchema>;
export type Nutrition = z.infer<typeof nutritionSchema>;
export type EquipmentItem = z.infer<typeof equipmentItemSchema>;
export type ServingsAdvanced = z.infer<typeof servingsAdvancedSchema>;
export type RecipeRecord = z.infer<typeof recipeRecordSchema>;
