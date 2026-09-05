import type { Locale, RecipeRecord } from "@/content/schema";
import {
  getRecipeModifiedAt,
  getRecipePublishedAt
} from "@/content/recipe-dates";
import { resolveRecipeMediaUrl } from "./recipe-media";
import { formatRecipeEquipment } from "./recipe-equipment";
import { absoluteUrl, canonicalUrl } from "./site";
import { getRecipePath } from "./recipe-routes";

export type RecipeStructuredData = {
  "@context": "https://schema.org";
  "@type": "Recipe";
  name: string;
  description?: string;
  image?: string[];
  recipeIngredient: string[];
  recipeInstructions: Array<{
    "@type": "HowToStep";
    text: string;
    image?: string;
  }>;
  recipeYield?: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  recipeCategory?: string[];
  tool?: string[];
  nutrition?: {
    "@type": "NutritionInformation";
    calories?: string;
    servingSize?: string;
  };
  inLanguage: Locale;
  url: string;
  datePublished?: string;
  dateModified?: string;
};

function toIsoDuration(minutes: number | null) {
  return minutes === null ? undefined : `PT${minutes}M`;
}

export function getRecipeStructuredData(
  record: RecipeRecord
): RecipeStructuredData {
  const media = new Map(record.media.map((asset) => [asset.id, asset]));
  const hero = record.recipe.heroMediaId
    ? media.get(record.recipe.heroMediaId)
    : undefined;
  const steps = record.recipe.instructionGroups.flatMap((group) => group.steps);
  const recipeInstructions = steps.map((step) => {
    const stepMedia = step.mediaId ? media.get(step.mediaId) : undefined;
    return {
      "@type": "HowToStep" as const,
      text: step.text,
      ...(stepMedia ? { image: absoluteUrl(resolveRecipeMediaUrl(stepMedia.path)) } : {})
    };
  });
  const categories = record.taxonomies
    .filter((taxonomy) => taxonomy.taxonomy === "category")
    .map((taxonomy) => taxonomy.name);
  const equipment = (record.recipe.equipment ?? []).map(formatRecipeEquipment);
  const nutrition = record.recipe.nutrition;
  const servingSize = nutrition?.servingSize
    ? [nutrition.servingSize.raw, nutrition.servingUnit]
      .filter((value): value is string => value !== null)
      .join(" ")
    : undefined;
  const calorieValue = nutrition?.calories?.value;
  const publishedAt = getRecipePublishedAt(record);
  const modifiedAt = getRecipeModifiedAt(record);
  const calories = typeof calorieValue === "number"
    && Number.isFinite(calorieValue)
    && calorieValue >= 0
    ? `${String(calorieValue)} calories`
    : undefined;
  const structuredNutrition = nutrition
    && (calories !== undefined || servingSize !== undefined)
    ? {
      "@type": "NutritionInformation" as const,
      ...(calories !== undefined ? { calories } : {}),
      ...(servingSize !== undefined ? { servingSize } : {})
    }
    : undefined;

  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: record.title,
    ...(record.description ? { description: record.description } : {}),
    ...(hero ? { image: [absoluteUrl(resolveRecipeMediaUrl(hero.path))] } : {}),
    recipeIngredient: record.recipe.ingredientGroups.flatMap((group) =>
      group.items.map((item) => item.raw)
    ),
    recipeInstructions,
    ...(record.recipe.servings ? { recipeYield: record.recipe.servings.raw } : {}),
    ...(record.recipe.times.prep?.minutes !== null &&
    record.recipe.times.prep?.minutes !== undefined
      ? { prepTime: toIsoDuration(record.recipe.times.prep.minutes) }
      : {}),
    ...(record.recipe.times.cook?.minutes !== null &&
    record.recipe.times.cook?.minutes !== undefined
      ? { cookTime: toIsoDuration(record.recipe.times.cook.minutes) }
      : {}),
    ...(record.recipe.times.total?.minutes !== null &&
    record.recipe.times.total?.minutes !== undefined
      ? { totalTime: toIsoDuration(record.recipe.times.total.minutes) }
      : {}),
    ...(categories.length > 0 ? { recipeCategory: categories } : {}),
    ...(equipment.length > 0 ? { tool: equipment } : {}),
    ...(structuredNutrition ? { nutrition: structuredNutrition } : {}),
    inLanguage: record.locale,
    url: canonicalUrl(getRecipePath(record)),
    ...(publishedAt
      ? { datePublished: publishedAt }
      : {}),
    ...(modifiedAt
      ? { dateModified: modifiedAt }
      : {})
  };
}

export function serializeRecipeStructuredData(data: RecipeStructuredData) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
