import { type Locale, type RecipeRecord } from "./schema";
import { compareCodeUnits } from "./sort";
import {
  decodeRecipeSlug,
  portablePathComponentKey,
  validateCategorySlug
} from "./url-path";

export type RecipeCategory = {
  readonly identity: string;
  readonly locale: Locale;
  readonly name: string;
  readonly recipes: readonly RecipeRecord[];
  readonly slug: string;
  readonly sourceId: string | null;
  readonly sourceSlug: string;
  readonly sourceTaxonomyId: string | null;
};

type EditorialCategoryTaxonomy = RecipeRecord["taxonomies"][number];

type MutableRecipeCategory = {
  -readonly [Key in keyof Omit<RecipeCategory, "recipes">]:
    Omit<RecipeCategory, "recipes">[Key];
} & {
  recipes: RecipeRecord[];
};

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
  const slug = decodeRecipeSlug(
    taxonomy.slug,
    `Editorial category slug for recipe "${record.id}"`
  );
  validateCategorySlug(
    slug,
    `Editorial category slug for recipe "${record.id}"`
  );
  if (record.schemaVersion === 2) {
    if (taxonomy.sourceId !== null || taxonomy.sourceTaxonomyId !== null) {
      throw new Error(
        `Authored category for recipe "${record.id}" cannot contain WordPress source IDs.`
      );
    }
    return {
      identity: `authored:${record.locale}:${slug}`,
      locale: record.locale,
      name: taxonomy.name,
      slug,
      sourceId: null,
      sourceSlug: taxonomy.slug,
      sourceTaxonomyId: null
    };
  }

  if (taxonomy.sourceId === null || taxonomy.sourceTaxonomyId === null) {
    throw new Error(
      `Editorial category for recipe "${record.id}" must preserve both source term IDs.`
    );
  }

  return {
    identity: categoryIdentity(record.locale, taxonomy.sourceTaxonomyId),
    locale: record.locale,
    name: taxonomy.name,
    slug,
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
  const categoryByLocalizedSlug = new Map<string, MutableRecipeCategory>();
  const localizedSlugByPortableKey = new Map<string, string>();
  const localizedSlugByWordPressIdentity = new Map<string, string>();

  for (const record of records) {
    const membershipIds = new Set<string>();
    for (const taxonomy of getEditorialCategoryTaxonomies(record)) {
      const source = sourceCategory(record, taxonomy);
      const localizedSlug = `${source.locale}:${source.slug}`;
      const portableKey = `${source.locale}:${portablePathComponentKey(
        source.slug,
        `Editorial category slug for recipe "${record.id}"`
      )}`;
      const existing = categoryByLocalizedSlug.get(localizedSlug);
      const existingPortableSlug = localizedSlugByPortableKey.get(portableKey);
      if (
        existingPortableSlug !== undefined
        && existingPortableSlug !== localizedSlug
      ) {
        throw new Error(
          `Cross-platform category path collision for recipe "${record.id}": ` +
          `${source.locale}/${source.slug}`
        );
      }
      localizedSlugByPortableKey.set(portableKey, localizedSlug);

      if (source.sourceTaxonomyId !== null) {
        const existingLocalizedSlug = localizedSlugByWordPressIdentity.get(
          source.identity
        );
        if (
          existingLocalizedSlug !== undefined
          && existingLocalizedSlug !== localizedSlug
        ) {
          throw new Error(
            `Inconsistent editorial category identity "${source.identity}" for ` +
            `recipe "${record.id}".`
          );
        }
        localizedSlugByWordPressIdentity.set(source.identity, localizedSlug);
      }

      if (!membershipIds.add(localizedSlug)) {
        throw new Error(
          `Duplicate editorial category membership for recipe "${record.id}": ${localizedSlug}`
        );
      }

      if (existing !== undefined) {
        if (
          source.sourceTaxonomyId !== null
          && existing.sourceTaxonomyId !== null
          && (
            existing.sourceTaxonomyId !== source.sourceTaxonomyId
            || existing.sourceId !== source.sourceId
            || existing.sourceSlug !== source.sourceSlug
          )
        ) {
          throw new Error(
            `Duplicate localized category slug "${localizedSlug}" maps to ` +
            `both "${existing.identity}" and "${source.identity}".`
          );
        }
        if (existing.name !== source.name) {
          throw new Error(
            `Inconsistent localized category "${localizedSlug}" for recipe "${record.id}".`
          );
        }
        if (
          source.sourceTaxonomyId !== null
          && existing.sourceTaxonomyId === null
        ) {
          existing.identity = source.identity;
          existing.sourceId = source.sourceId;
          existing.sourceSlug = source.sourceSlug;
          existing.sourceTaxonomyId = source.sourceTaxonomyId;
        }
        existing.recipes.push(record);
        continue;
      }

      const category: MutableRecipeCategory = {
        ...source,
        recipes: [record]
      };
      categoryByLocalizedSlug.set(localizedSlug, category);
    }
  }

  return [...categoryByLocalizedSlug.values()]
    .sort((left, right) =>
      compareCodeUnits(left.locale, right.locale)
      || compareCodeUnits(left.slug, right.slug)
      || compareCodeUnits(left.sourceTaxonomyId ?? "", right.sourceTaxonomyId ?? "")
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
  const categoriesByLocalizedSlug = new Map(
    categories.map((category) => [
      `${category.locale}:${category.slug}`,
      category
    ])
  );

  return getEditorialCategoryTaxonomies(record).map((taxonomy) => {
    const source = sourceCategory(record, taxonomy);
    const localizedSlug = `${source.locale}:${source.slug}`;
    const category = categoriesByLocalizedSlug.get(localizedSlug);
    if (category === undefined) {
      throw new Error(
        `Missing editorial category "${localizedSlug}" for recipe "${record.id}".`
      );
    }
    return category;
  });
}
