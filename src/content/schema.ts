import { z } from "zod";

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

export const mediaAssetSchema = z.strictObject({
  id: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  path: z.string().startsWith("/"),
  alt: z.string().min(1).nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable()
});

export const legacyUrlKindSchema = z.enum([
  "canonical",
  "root-recipe",
  "legacy-recipe",
  "language",
  "print",
  "taxonomy",
  "feed",
  "attachment",
  "shortlink"
]);

export const legacyUrlSchema = z.strictObject({
  path: z.string().startsWith("/"),
  kind: legacyUrlKindSchema
});

export const recipeRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("recipe"),
  id: z.string().min(1),
  locale: localeSchema,
  translationGroupId: z.string().min(1).nullable(),
  slug: z.string().min(1).refine(
    (slug) => !slug.includes("/") && !/\s/.test(slug),
    "A slug must be one URL segment without whitespace."
  ),
  source: z.strictObject({
    system: z.literal("wordpress"),
    postId: z.string().regex(/^\d+$/).nullable(),
    recipeId: z.string().regex(/^\d+$/),
    postType: z.string().min(1).nullable(),
    plugin: z.enum(["wprm", "wpur"]),
    sourceSlug: z.string().min(1).nullable(),
    createdAt: z.string().datetime({ offset: true }).nullable(),
    modifiedAt: z.string().datetime({ offset: true }).nullable()
  }),
  legacyUrls: z.array(legacyUrlSchema),
  title: z.string().min(1),
  description: z.string().min(1).nullable(),
  editorial: z.strictObject({
    content: z.string().min(1).nullable(),
    excerpt: z.string().min(1).nullable()
  }),
  taxonomies: z.array(z.strictObject({
    taxonomy: z.string().min(1),
    sourceId: z.string().min(1).nullable(),
    name: z.string().min(1),
    slug: z.string().min(1)
  })),
  recipe: z.strictObject({
    servings: quantitySchema.nullable(),
    times: z.strictObject({
      prep: durationSchema.nullable(),
      cook: durationSchema.nullable(),
      rest: durationSchema.nullable(),
      total: durationSchema.nullable()
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
export type RecipeRecord = z.infer<typeof recipeRecordSchema>;
