import { z } from "zod";
import {
  localPathKey,
  validateRecipeSlug,
  validateSafeLocalPath
} from "./url-path";

export const localeValues = ["en", "fr", "ru"] as const;
export const localeSchema = z.enum(localeValues);

export const quantitySchema = z.strictObject({
  raw: z.string().min(1),
  value: z.number().positive().optional(),
  min: z.number().positive().optional(),
  max: z.number().positive().optional(),
  unit: z.string().min(1).nullable(),
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
  raw: z.string().min(1),
  minutes: z.number().int().nonnegative().nullable()
});

export const nutritionAmountSchema = z.strictObject({
  raw: z.string().min(1),
  value: z.number().nonnegative().optional()
});

export const nutritionSchema = z.strictObject({
  calories: nutritionAmountSchema.nullable(),
  servingSize: nutritionAmountSchema.nullable(),
  servingUnit: z.string().min(1).nullable()
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
  sourceIndex: z.number().int().nonnegative(),
  sourceId: z.string().regex(/^\d+$/),
  name: z.string().min(1),
  amount: z.string().min(1).nullable(),
  notes: z.string().min(1).nullable()
});

export const servingsAdvancedSchema = z.strictObject({
  diameter: z.number().nonnegative(),
  height: z.number().nonnegative(),
  length: z.number().nonnegative(),
  shape: z.string().min(1),
  unit: z.string().min(1),
  width: z.number().nonnegative()
});

export const mediaAssetSchema = z.strictObject({
  id: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  path: z.string().startsWith("/"),
  alt: z.string().min(1).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable()
});

export const redirectFromPathSchema = z.string().min(1).superRefine((value, context) => {
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
  id: z.string().min(1),
  locale: localeSchema,
  translationGroupId: z.string().min(1).nullable(),
  slug: z.string().min(1).superRefine((slug, context) => {
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
    postId: z.string().regex(/^\d+$/).nullable(),
    recipeId: z.string().regex(/^\d+$/),
    postType: z.string().min(1).nullable(),
    plugin: z.enum(["wprm", "wpur"]),
    sourceSlug: z.string().min(1).nullable(),
    createdAt: z.string().datetime({ offset: true }).nullable(),
    modifiedAt: z.string().datetime({ offset: true }).nullable(),
    editorialPostId: z.string().regex(/^\d+$/).nullable(),
    editorialPostType: z.string().min(1).nullable(),
    editorialSourceSlug: z.string().min(1).nullable(),
    editorialCreatedAt: z.string().datetime({ offset: true }).nullable(),
    editorialModifiedAt: z.string().datetime({ offset: true }).nullable(),
    wprmType: z.enum(["food", "howto", "other", "unknown", "malformed"]).optional(),
    wprmTypePresent: z.boolean().optional()
  }),
  redirectFrom: z.array(redirectFromPathSchema),
  title: z.string().min(1),
  description: z.string().min(1).nullable(),
  editorial: z.strictObject({
    content: z.string().min(1).nullable(),
    excerpt: z.string().min(1).nullable()
  }),
  taxonomies: z.array(z.strictObject({
    scope: z.enum(["recipe", "editorial"]).nullable(),
    taxonomy: z.string().min(1),
    sourceId: z.string().min(1).nullable(),
    sourceTaxonomyId: z.string().regex(/^\d+$/).nullable(),
    name: z.string().min(1),
    slug: z.string().min(1)
  })),
  recipe: z.strictObject({
    notes: z.string().min(1).nullable(),
    servings: quantitySchema.nullable(),
    servingsAdvancedEnabled: z.boolean().nullable().optional(),
    nutrition: nutritionSchema.nullable().optional(),
    servingsAdvanced: servingsAdvancedSchema.nullable().optional(),
    equipment: z.array(equipmentItemSchema).nullable().optional(),
    times: z.strictObject({
      prep: durationSchema.nullable(),
      cook: durationSchema.nullable(),
      rest: durationSchema.nullable(),
      total: durationSchema.nullable(),
      custom: z.strictObject({
        label: z.string().min(1).nullable(),
        duration: durationSchema
      }).nullable()
    }),
    heroMediaId: z.string().min(1).nullable(),
    ingredientGroups: z.array(z.strictObject({
      name: z.string().min(1).nullable(),
      sourceIndex: z.number().int().nonnegative(),
      items: z.array(z.strictObject({
        sourceIndex: z.number().int().nonnegative(),
        raw: z.string().min(1),
        quantity: quantitySchema.nullable(),
        name: z.string().min(1),
        pluralName: z.string().min(1).optional(),
        notes: z.string().min(1).nullable()
      })).min(1)
    })).min(1),
    instructionGroups: z.array(z.strictObject({
      name: z.string().min(1).nullable(),
      sourceIndex: z.number().int().nonnegative(),
      steps: z.array(z.strictObject({
        sourceIndex: z.number().int().nonnegative(),
        text: z.string().min(1),
        mediaId: z.string().min(1).nullable()
      })).min(1)
    })).min(1)
  }),
  media: z.array(mediaAssetSchema),
  seo: z.strictObject({
    title: z.string().min(1).nullable(),
    description: z.string().min(1).nullable()
  }).nullable()
}).superRefine((record, context) => {
  const canonicalPath = record.locale === "en"
    ? `/recipes/${encodeURIComponent(record.slug)}`
    : `/${record.locale}/recipes/${encodeURIComponent(record.slug)}`;
  let canonicalKey: string | undefined;
  try {
    canonicalKey = localPathKey(canonicalPath);
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
  for (const [index, media] of record.media.entries()) {
    if (mediaIds.has(media.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate media ID: ${media.id}`,
        path: ["media", index, "id"]
      });
    }
    mediaIds.add(media.id);
  }

  const references = [
    record.recipe.heroMediaId,
    ...record.recipe.instructionGroups.flatMap((group) =>
      group.steps.map((step) => step.mediaId)
    )
  ].filter((id): id is string => id !== null);

  for (const reference of references) {
    if (!mediaIds.has(reference)) {
      context.addIssue({
        code: "custom",
        message: `Unknown media reference: ${reference}`,
        path: ["media"]
      });
    }
  }
});

export type Locale = z.infer<typeof localeSchema>;
export type Quantity = z.infer<typeof quantitySchema>;
export type NutritionAmount = z.infer<typeof nutritionAmountSchema>;
export type Nutrition = z.infer<typeof nutritionSchema>;
export type EquipmentItem = z.infer<typeof equipmentItemSchema>;
export type ServingsAdvanced = z.infer<typeof servingsAdvancedSchema>;
export type RecipeRecord = z.infer<typeof recipeRecordSchema>;
