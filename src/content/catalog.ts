import { recipeRecordSchema, type RecipeRecord } from "./schema";
import { meatballsSoup } from "./recipes/meatballs-soup";

const records: RecipeRecord[] = [meatballsSoup];

export function validateCatalog(catalog: readonly RecipeRecord[] = records) {
  const parsed = catalog.map((record) => recipeRecordSchema.parse(record));
  const ids = new Set<string>();
  const localizedSlugs = new Set<string>();

  for (const record of parsed) {
    if (ids.has(record.id)) {
      throw new Error(`Duplicate content ID: ${record.id}`);
    }
    ids.add(record.id);

    const localizedSlug = `${record.locale}:${record.slug}`;
    if (localizedSlugs.has(localizedSlug)) {
      throw new Error(`Duplicate localized slug: ${localizedSlug}`);
    }
    localizedSlugs.add(localizedSlug);
  }

  return parsed;
}

export const recipeCatalog = validateCatalog();
