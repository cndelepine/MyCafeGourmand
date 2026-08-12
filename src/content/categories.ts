import { type Locale, type RecipeRecord } from "./schema";
import { decodeRecipeSlug } from "./url-path";

export type RecipeCategory = {
  readonly identity: string;
  readonly locale: Locale;
  readonly name: string;
  readonly recipes: readonly RecipeRecord[];
  readonly slug: string;
  readonly sourceId: string;
  readonly sourceSlug: string;
  readonly sourceTaxonomyId: string;
};

type EditorialCategoryTaxonomy = RecipeRecord["taxonomies"][number];

type MutableRecipeCategory = Omit<RecipeCategory, "recipes"> & {
  recipes: RecipeRecord[];
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isEditorialCategory(
  taxonomy: EditorialCategoryTaxonomy
) {
  return taxonomy.scope === "editorial" && taxonomy.taxonomy === "category";
}

function categoryIdentity(
  locale: Locale,
  sourceTaxonomyId: string
) {
  return `${locale}:${sourceTaxonomyId}`;
}

function sourceCategory(
  record: RecipeRecord,
  taxonomy: EditorialCategoryTaxonomy
) {
  if (taxonomy.sourceId === null || taxonomy.sourceTaxonomyId === null) {
    throw new Error(
      `Editorial category for recipe "${record.id}" must preserve both source term IDs.`
    );
  }

  return {
    identity: categoryIdentity(record.locale, taxonomy.sourceTaxonomyId),
    locale: record.locale,
    name: taxonomy.name,
    slug: decodeRecipeSlug(
      taxonomy.slug,
      `Editorial category slug for recipe "${record.id}"`
    ),
    sourceId: taxonomy.sourceId,
    sourceSlug: taxonomy.slug,
    sourceTaxonomyId: taxonomy.sourceTaxonomyId
  };
}

export function getEditorialCategoryTaxonomies(record: RecipeRecord) {
  return record.taxonomies.filter(isEditorialCategory);
}

export function getCategoryCatalog(
  records: readonly RecipeRecord[]
): readonly RecipeCategory[] {
  const categoriesByIdentity = new Map<string, MutableRecipeCategory>();
  const categoryByLocalizedSlug = new Map<string, MutableRecipeCategory>();

  for (const record of records) {
    const membershipIds = new Set<string>();
    for (const taxonomy of getEditorialCategoryTaxonomies(record)) {
      const source = sourceCategory(record, taxonomy);
      const existing = categoriesByIdentity.get(source.identity);
      const localizedSlug = `${source.locale}:${source.slug}`;

      if (!membershipIds.add(source.identity)) {
        throw new Error(
          `Duplicate editorial category membership for recipe "${record.id}": ${source.identity}`
        );
      }

      if (existing !== undefined) {
        if (
          existing.name !== source.name
          || existing.slug !== source.slug
          || existing.sourceId !== source.sourceId
          || existing.sourceSlug !== source.sourceSlug
        ) {
          throw new Error(
            `Inconsistent editorial category identity "${source.identity}" for recipe "${record.id}".`
          );
        }
        existing.recipes.push(record);
        continue;
      }

      const existingSlug = categoryByLocalizedSlug.get(localizedSlug);
      if (existingSlug !== undefined) {
        throw new Error(
          `Duplicate localized category slug "${localizedSlug}" maps to ` +
          `both "${existingSlug.identity}" and "${source.identity}".`
        );
      }

      const category: MutableRecipeCategory = {
        ...source,
        recipes: [record]
      };
      categoriesByIdentity.set(source.identity, category);
      categoryByLocalizedSlug.set(localizedSlug, category);
    }
  }

  return [...categoriesByIdentity.values()]
    .sort((left, right) =>
      compareText(left.locale, right.locale)
      || compareText(left.slug, right.slug)
      || compareText(left.sourceTaxonomyId, right.sourceTaxonomyId)
    )
    .map((category) => ({
      ...category,
      recipes: category.recipes
    }));
}

export function findCategoryByRoute(
  locale: Locale,
  slug: string,
  records: readonly RecipeRecord[]
) {
  let decodedSlug: string;
  try {
    decodedSlug = decodeRecipeSlug(slug, "Category route slug");
  } catch {
    return undefined;
  }

  return getCategoryCatalog(records).find(
    (category) => category.locale === locale && category.slug === decodedSlug
  );
}

export function getRecipeCategories(
  record: RecipeRecord,
  categories: readonly RecipeCategory[]
) {
  const categoriesByIdentity = new Map(
    categories.map((category) => [category.identity, category])
  );

  return getEditorialCategoryTaxonomies(record).map((taxonomy) => {
    const source = sourceCategory(record, taxonomy);
    const category = categoriesByIdentity.get(source.identity);
    if (category === undefined) {
      throw new Error(
        `Missing editorial category "${source.identity}" for recipe "${record.id}".`
      );
    }
    return category;
  });
}
