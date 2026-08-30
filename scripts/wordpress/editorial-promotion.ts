import path from "node:path";
import {
  decodeRecipeSlug,
  decodeLocalPath,
  localPathKey,
  validateSafeLocalPath
} from "../../src/content/url-path";
import {
  editorialPageRecordSchema,
  publicContentLimits,
  type EmptyCardGridReason,
  type EditorialPageRecord,
  type Locale,
  type PublicMediaObject,
  type RichTextBlock
} from "../../src/content/editorial-schema";
import {
  galleryCanonicalPath,
  galleryRecordSchema,
  type GalleryRecord
} from "../../src/content/gallery-schema";
import { validatePublicContentCatalogs } from "../../src/content/gallery-catalog";
import type { RecipeRecord } from "../../src/content/schema";
import { getRecipePath } from "../../src/lib/recipe-routes";
import { getReservedPublicPaths } from "../../src/lib/public-routes";
import {
  normalizeBwgArchivePath,
  normalizedLocale,
  secondaryLocale
} from "./source-evidence-scan";
import { normalizeWprmAttachmentFile } from "./wprm-import-map";
import {
  type EditorialCandidateOutcome,
  type EditorialIssueCode,
  type EditorialSourceSnapshot,
  type RawBwgGallery,
  type RawBwgImage,
  type RawEditorialPostState,
  type RawTermTaxonomy,
  type RawWpTilesGridTemplate
} from "./editorial-import-contracts";
import {
  EditorialHtmlMappingError,
  decodeWordPressPlainText,
  mapWordPressHtmlToSafeAst,
  type WordPressImage,
  type WordPressShortcode
} from "./editorial-promotion-html";

const allowedTileAttributes = new Set([
  "breakpoint",
  "category",
  "exclude_current_post",
  "grid_selector_color",
  "grids",
  "ignore_sticky_posts",
  "offset",
  "order",
  "orderby",
  "padding",
  "pagination",
  "post_parent",
  "post_status",
  "post_type",
  "posts_per_page",
  "small_screen_grid",
  "tag",
  "tax_operator"
]);
const tileCosmeticAttributes = new Set([
  "breakpoint",
  "grid_selector_color",
  "grids",
  "padding",
  "small_screen_grid"
]);
const acceptedIssuePatterns = new Set([
  "",
  "ambiguous-attachment-path,unsupported-wp-tiles",
  "unsupported-block,unsupported-wp-tiles",
  "unsupported-contact-form-7",
  "unsupported-wp-tiles"
]);
const ownerExcludedEditorialSourceIds = new Set(["25283"]);

type SourceRouteTarget =
  | {
    readonly kind: "editorial";
    readonly path: string;
    readonly sourceId: string;
  }
  | {
    readonly kind: "gallery" | "recipe";
    readonly path: string;
  };

type CategoryTaxonomyMatch = {
  readonly taxonomy: RawTermTaxonomy;
};

type CategoryTaxonomyResolution =
  | {
    readonly kind: "resolved";
    readonly taxonomyIds: readonly string[];
  }
  | {
    readonly kind: "source-category-missing";
  };

type TileQuery = {
  readonly category: CategoryTaxonomyResolution;
  readonly excludeCurrentPost: boolean;
  readonly limit: number | null;
  readonly offset: number;
  readonly order: "asc" | "desc";
  readonly orderBy: "date" | "menu_order";
  readonly pagination: "ajax" | null;
  readonly postParent: "current" | string | null;
  readonly postType: "page" | "post";
};

type ResolvedTiles =
  | {
    readonly kind: "empty";
    readonly reason: EmptyCardGridReason;
  }
  | {
    readonly kind: "page";
    readonly pageTargetSourceIds: readonly string[];
    readonly recipeIds: readonly [];
  }
  | {
    readonly kind: "recipe";
    readonly pageTargetSourceIds: readonly [];
    readonly recipeIds: readonly string[];
  };

type MappedEditorialPage = {
  readonly mediaBindings: readonly EditorialPlannedMediaBinding[];
  readonly pageGridTargetSourceIds: ReadonlySet<string>;
  readonly pageLinkTargetSourceIds: ReadonlySet<string>;
  readonly record: EditorialPageRecord;
  readonly sourceId: string;
};

export type EditorialPlannedMediaBinding = {
  readonly archiveIndex: number;
  readonly archiveSha256: string;
  readonly archivePath: string;
  readonly entryIndexContractSha256: string;
  readonly publicPath: string;
  readonly role: "featured" | "inline" | "original" | "thumbnail";
  readonly sourceId: string;
  readonly sourceKind: "wordpress-attachment" | "wordpress-bwg-image";
  readonly width: number | null;
  readonly height: number | null;
};

export type EditorialPromotionSummary = {
  readonly candidates: {
    readonly approvedEmptyCardGrids: number;
    readonly approvedEmptyCardGridReasons: readonly EditorialPromotionReasonCount[];
    readonly directPolicyEligible: number;
    readonly mappingBlocked: number;
    readonly mappingBlockedReasons: readonly EditorialPromotionReasonCount[];
    readonly policyBlocked: number;
    readonly policyBlockedReasons: readonly EditorialPromotionReasonCount[];
    readonly selected: number;
    readonly translationBlocked: number;
    readonly translationBlockedReasons: readonly EditorialPromotionReasonCount[];
    readonly hierarchyBlocked: number;
    readonly hierarchyBlockedReasons: readonly EditorialPromotionReasonCount[];
    readonly referenceBlocked: number;
    readonly referenceBlockedReasons: readonly EditorialPromotionReasonCount[];
  };
  readonly records: {
    readonly byLocale: Readonly<Record<Locale, number>>;
    readonly galleries: number;
    readonly redirects: number;
  };
  readonly media: {
    readonly bindings: number;
    readonly editorialBindings: number;
    readonly galleryBindings: number;
  };
};

export type EditorialPromotionReasonCount = {
  readonly code: string;
  readonly count: number;
};

export type EditorialPromotionPlan = {
  readonly gallery: GalleryRecord | null;
  readonly mediaBindings: readonly EditorialPlannedMediaBinding[];
  readonly publicationExcludedRecordIds: readonly string[];
  readonly records: readonly EditorialPageRecord[];
  readonly summary: EditorialPromotionSummary;
};

export class EditorialPromotionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The editorial promotion mapping failed.");
    this.name = "EditorialPromotionError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new EditorialPromotionError(code);
}

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber
    ? -1
    : leftNumber > rightNumber
      ? 1
      : left.localeCompare(right);
}

function sortedIssuePattern(codes: readonly EditorialIssueCode[]) {
  return [...codes].sort((left, right) => left.localeCompare(right)).join(",");
}

function sortedReasonCounts(reasons: ReadonlyMap<string, number>) {
  return [...reasons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

function countReason(reasons: Map<string, number>, code: string) {
  reasons.set(code, (reasons.get(code) ?? 0) + 1);
}

function exactKeys(value: ReadonlyMap<string, string>, keys: readonly string[]) {
  return value.size === keys.length && keys.every((key) => value.has(key));
}

function requiredAttribute(attributes: ReadonlyMap<string, string>, name: string) {
  const value = attributes.get(name);
  if (value === undefined) {
    fail("missing-wp-tiles-attribute");
  }
  return value;
}

function wpTilesTruthyAttribute(value: string) {
  // WP Tiles casts shortcode strings with PHP's `(bool)`, where both reviewed
  // non-empty literals are truthy. Restrict the input lexemes to those
  // source-observed values instead of accepting arbitrary PHP truthiness.
  if (value === "true" || value === "false") {
    return true;
  }
  fail("invalid-wp-tiles-boolean");
}

function positiveOrZeroInteger(value: string, code: string) {
  if (!/^\d+$/u.test(value)) {
    fail(code);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail(code);
  }
  return parsed;
}

function sourcePosts(snapshot: EditorialSourceSnapshot) {
  if (snapshot.graph.posts === undefined) {
    fail("missing-source-post-graph");
  }
  return snapshot.graph.posts;
}

function safePositiveNumber(value: string, code: string) {
  if (!/^\d+$/u.test(value)) {
    fail(code);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(code);
  }
  return parsed;
}

function localizedPostIds(snapshot: EditorialSourceSnapshot) {
  const posts = sourcePosts(snapshot);
  const values = new Map<string, Locale | null>();
  const conflicts = new Set<string>();
  for (const [taxonomyId, taxonomy] of snapshot.graph.taxonomies) {
    if (taxonomy.taxonomy !== "language") {
      continue;
    }
    const locale = normalizedLocale(snapshot.graph.terms.get(taxonomy.termId)?.slug);
    if (locale === null) {
      continue;
    }
    for (const postId of snapshot.graph.relationships.get(taxonomyId) ?? []) {
      if (!posts.has(postId)) {
        continue;
      }
      const previous = values.get(postId);
      if (previous !== undefined && previous !== locale) {
        values.set(postId, null);
        conflicts.add(postId);
      } else if (!conflicts.has(postId)) {
        values.set(postId, locale);
      }
    }
  }
  return values;
}

function taxonomyMemberships(snapshot: EditorialSourceSnapshot) {
  const memberships = new Map<string, Set<string>>();
  for (const [taxonomyId, members] of snapshot.graph.relationships) {
    for (const sourceId of members) {
      const values = memberships.get(sourceId) ?? new Set<string>();
      values.add(taxonomyId);
      memberships.set(sourceId, values);
    }
  }
  return memberships;
}

function categoryTaxonomies(snapshot: EditorialSourceSnapshot) {
  return [...snapshot.graph.taxonomies.values()]
    .filter((taxonomy) => taxonomy.taxonomy === "category")
    .sort((left, right) => numericIdSort(left.id, right.id));
}

function wpTilesGridTitleKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function publishedWpTilesGridTemplates(snapshot: EditorialSourceSnapshot) {
  return [...snapshot.graph.gridTemplates.values()]
    .filter((template) => template.status === "publish")
    .sort((left, right) => {
      if (
        left.menuOrderMalformed
        || right.menuOrderMalformed
        || left.menuOrder === null
        || right.menuOrder === null
      ) {
        fail("invalid-wp-tiles-grid-order");
      }
      if (left.menuOrder !== right.menuOrder) {
        return right.menuOrder - left.menuOrder;
      }
      return numericIdSort(right.id, left.id);
    });
}

function selectedWpTilesGridTemplates(
  selector: string | null,
  snapshot: EditorialSourceSnapshot
) {
  const all = publishedWpTilesGridTemplates(snapshot);
  if (all.length === 0) {
    fail("missing-wp-tiles-grid-template");
  }
  const selected = selector ?? snapshot.options.wpTilesDefaultGrid;
  if (selected === null || selected === "all") {
    return all;
  }
  const requested = selected.includes(",")
    ? selected.split(",").map((value) => value.trim())
    : [selected];
  if (requested.some((value) => value.length === 0)) {
    fail("invalid-wp-tiles-grid-selector");
  }
  const first = requested[0];
  if (first === undefined) {
    fail("invalid-wp-tiles-grid-selector");
  }
  if (/^\d+$/u.test(first)) {
    if (requested.some((value) => !/^\d+$/u.test(value))) {
      fail("invalid-wp-tiles-grid-selector");
    }
    const byId = new Map(all.map((template) => [template.id, template]));
    const templates = requested.flatMap((id) => {
      const template = byId.get(id);
      return template === undefined ? [] : [template];
    });
    return templates.length === 0 ? all : templates;
  }
  const templates: RawWpTilesGridTemplate[] = [];
  for (const title of requested) {
    const matches = all.filter((template) =>
      template.title !== null
      && wpTilesGridTitleKey(template.title) === wpTilesGridTitleKey(title)
    );
    if (matches.length > 1) {
      fail("ambiguous-wp-tiles-grid-template");
    }
    if (matches.length === 1) {
      templates.push(matches[0]!);
    }
  }
  return templates.length === 0 ? all : templates;
}

export function wpTilesGridCapacity(template: RawWpTilesGridTemplate) {
  if (template.content === null) {
    fail("missing-wp-tiles-grid-template-content");
  }
  // Mirror WP Tiles' byte-level row traversal: dots always consume a tile,
  // while a repeated non-dot cell is new only when disconnected left and above.
  const trimGridRow = (row: string) =>
    row.replace(/^[\u0000\u0009-\u000d\u0020]+|[\u0000\u0009-\u000d\u0020]+$/gu, "");
  let lastRow: Buffer | null = null;
  const regions: number[] = [];
  const seen = new Set<number>();
  for (const sourceRow of template.content.replaceAll("|", "\n").split("\n")) {
    const row = Buffer.from(
      Buffer.from(trimGridRow(sourceRow), "utf8").filter((cell) => cell !== 0x20)
    );
    for (let index = 0; index < row.length; index += 1) {
      const cell = row[index]!;
      if (cell !== 0x2e && seen.has(cell)) {
        const adjacent = index !== 0 && row[index - 1] === cell;
        const beneath = lastRow !== null && lastRow[index] === cell;
        if (adjacent || beneath) {
          continue;
        }
      }
      regions.push(cell);
      seen.add(cell);
      if (regions.length > publicContentLimits.maxCardGridItems) {
        fail("wp-tiles-grid-capacity-limit");
      }
    }
    lastRow = row;
  }
  return regions.length === 0 ? 10 : regions.length;
}

function wpTilesAutoLimit(
  selector: string | undefined,
  snapshot: EditorialSourceSnapshot
) {
  const templates = selectedWpTilesGridTemplates(selector ?? null, snapshot);
  const template = templates[0];
  if (template === undefined) {
    fail("missing-wp-tiles-grid-template");
  }
  return wpTilesGridCapacity(template);
}

function wordpressCategoryLookupKey(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function localizedCategoryTerms(snapshot: EditorialSourceSnapshot) {
  const values = new Map<string, Locale | null>();
  for (const [taxonomyId, taxonomy] of snapshot.graph.taxonomies) {
    if (taxonomy.taxonomy !== "term_language") {
      continue;
    }
    const locale = secondaryLocale(snapshot.graph.terms.get(taxonomy.termId)?.slug);
    if (locale === null) {
      continue;
    }
    for (const termId of snapshot.graph.relationships.get(taxonomyId) ?? []) {
      const previous = values.get(termId);
      if (previous !== undefined && previous !== locale) {
        values.set(termId, null);
      } else {
        values.set(termId, locale);
      }
    }
  }
  return values;
}

function translatedCategoryTermIds(
  snapshot: EditorialSourceSnapshot,
  locale: Locale,
  termLocales: ReadonlyMap<string, Locale | null>
) {
  const categories = categoryTaxonomies(snapshot);
  const categoryTermIds = new Set(categories.map((taxonomy) => taxonomy.termId));
  const values = new Map<string, string | null>();
  const conflicts = new Set<string>();
  const markConflict = (termIds: readonly string[]) => {
    for (const termId of termIds) {
      conflicts.add(termId);
      values.set(termId, null);
    }
  };
  for (const [taxonomyId, taxonomy] of snapshot.graph.taxonomies) {
    if (taxonomy.taxonomy !== "term_translations") {
      continue;
    }
    const members = [...(snapshot.graph.relationships.get(taxonomyId) ?? [])]
      .filter((termId) => categoryTermIds.has(termId));
    const localeMembers = members.filter((termId) => {
      const termLocale = termLocales.get(termId);
      return termLocale === locale;
    });
    if (
      members.some((termId) => termLocales.get(termId) === null)
      || localeMembers.length > 1
    ) {
      markConflict(members);
      continue;
    }
    if (localeMembers.length !== 1) {
      continue;
    }
    const translated = localeMembers[0]!;
    for (const termId of members) {
      if (conflicts.has(termId)) {
        continue;
      }
      const previous = values.get(termId);
      if (previous !== undefined && previous !== translated) {
        markConflict([termId]);
      } else {
        values.set(termId, translated);
      }
    }
  }
  return values;
}

function categoryDescendantTaxonomyIds(
  root: string,
  snapshot: EditorialSourceSnapshot
) {
  const categories = categoryTaxonomies(snapshot);
  const roots = new Map(categories.map((taxonomy) => [taxonomy.id, taxonomy]));
  const rootTaxonomy = roots.get(root);
  if (rootTaxonomy === undefined) {
    fail("missing-wp-tiles-category");
  }
  const selected = new Set([rootTaxonomy.id]);
  const pending = [rootTaxonomy.termId];
  while (pending.length > 0) {
    const parentTermId = pending.shift();
    if (parentTermId === undefined) {
      continue;
    }
    for (const candidate of categories) {
      if (
        candidate.parentTermIdMalformed
        || candidate.parentTermId !== parentTermId
        || selected.has(candidate.id)
      ) {
        continue;
      }
      selected.add(candidate.id);
      pending.push(candidate.termId);
    }
  }
  return [...selected].sort(numericIdSort);
}

function resolveCategoryTaxonomies(
  category: string,
  locale: Locale,
  snapshot: EditorialSourceSnapshot
): CategoryTaxonomyResolution {
  if (category.length === 0) {
    return { kind: "resolved", taxonomyIds: [] };
  }
  const terms = snapshot.graph.terms;
  const categories = categoryTaxonomies(snapshot);
  const termLocales = localizedCategoryTerms(snapshot);
  const translatedTerms = translatedCategoryTermIds(snapshot, locale, termLocales);
  const resolved: string[] = [];
  const directRoots = new Set<string>();
  let exactSourceMatchCount = 0;
  for (const value of category.split(",")) {
    const token = value.trim();
    if (
      token.length === 0
      || token.includes("+")
      || /[\u0000-\u001f\u007f]/u.test(token)
    ) {
      fail("invalid-wp-tiles-category");
    }
    const lookupToken = wordpressCategoryLookupKey(token);
    const sourceMatches: CategoryTaxonomyMatch[] = categories.flatMap((taxonomy) => {
      const term = terms.get(taxonomy.termId);
      if (
        term?.slug === null
        || term?.slug === undefined
        || wordpressCategoryLookupKey(term.slug) !== lookupToken
      ) {
        return [];
      }
      return [{ taxonomy }];
    });
    exactSourceMatchCount += sourceMatches.length;
    if (sourceMatches.length === 0) {
      continue;
    }
    const currentLocaleMatches = sourceMatches.filter((sourceMatch) =>
      termLocales.get(sourceMatch.taxonomy.termId) === locale
    );
    if (currentLocaleMatches.length > 1) {
      fail("ambiguous-wp-tiles-category");
    }
    let roots: readonly RawTermTaxonomy[];
    if (currentLocaleMatches.length === 1) {
      const sourceMatch = currentLocaleMatches[0]!;
      roots = [sourceMatch.taxonomy];
    } else {
      const translatedRoots = new Map<string, RawTermTaxonomy>();
      const addRoot = (taxonomy: RawTermTaxonomy) => {
        translatedRoots.set(taxonomy.id, taxonomy);
      };
      for (const sourceMatch of sourceMatches) {
        const sourceLocale = termLocales.get(sourceMatch.taxonomy.termId);
        if (sourceLocale === null) {
          fail("conflicting-wp-tiles-category-translation");
        }
        if (sourceLocale === undefined) {
          addRoot(sourceMatch.taxonomy);
          continue;
        }
        const translatedTermId = translatedTerms.get(sourceMatch.taxonomy.termId);
        if (translatedTermId === null) {
          fail("conflicting-wp-tiles-category-translation");
        }
        if (translatedTermId === undefined) {
          fail("unresolved-wp-tiles-category");
        }
        const matches = categories.filter((taxonomy) =>
          taxonomy.termId === translatedTermId
          && termLocales.get(taxonomy.termId) === locale
        );
        if (matches.length > 1) {
          fail("ambiguous-wp-tiles-category");
        }
        const match = matches[0];
        if (match === undefined) {
          fail("unresolved-wp-tiles-category");
        }
        addRoot(match);
      }
      if (translatedRoots.size > 1) {
        fail("ambiguous-wp-tiles-category");
      }
      const translatedRoot = [...translatedRoots.values()][0];
      if (translatedRoot === undefined) {
        fail("unresolved-wp-tiles-category");
      }
      roots = [translatedRoot];
    }
    for (const match of roots) {
      const taxonomyId = match.id;
      if (directRoots.has(taxonomyId)) {
        fail("duplicate-wp-tiles-category");
      }
      directRoots.add(taxonomyId);
      for (const descendantId of categoryDescendantTaxonomyIds(taxonomyId, snapshot)) {
        if (!resolved.includes(descendantId)) {
          resolved.push(descendantId);
        }
      }
    }
  }
  if (resolved.length === 0) {
    if (exactSourceMatchCount === 0) {
      return { kind: "source-category-missing" };
    }
    fail("unresolved-wp-tiles-category");
  }
  return { kind: "resolved", taxonomyIds: resolved.sort(numericIdSort) };
}

function parseTilesQuery(
  shortcode: WordPressShortcode,
  locale: Locale,
  snapshot: EditorialSourceSnapshot
): TileQuery {
  for (const [name, value] of shortcode.attributes) {
    if (
      !allowedTileAttributes.has(name)
      || value.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      fail("unsupported-wp-tiles-attribute");
    }
  }
  for (const name of tileCosmeticAttributes) {
    const value = shortcode.attributes.get(name);
    if (value !== undefined && value.length === 0) {
      fail("invalid-wp-tiles-cosmetic");
    }
  }

  const postTypeValue = requiredAttribute(shortcode.attributes, "post_type");
  const postType = postTypeValue === "post" || postTypeValue === "page"
    ? postTypeValue
    : fail("unsupported-wp-tiles-post-type");
  const orderValue = requiredAttribute(shortcode.attributes, "order").toLowerCase();
  const order = orderValue === "asc" || orderValue === "desc"
    ? orderValue
    : fail("unsupported-wp-tiles-order");
  const orderByValue = requiredAttribute(shortcode.attributes, "orderby").toLowerCase();
  const orderBy = orderByValue === "date" || orderByValue === "menu_order"
    ? orderByValue
    : fail("unsupported-wp-tiles-orderby");
  const taxOperatorValue = requiredAttribute(shortcode.attributes, "tax_operator")
    .toLowerCase();
  if (taxOperatorValue !== "in" && taxOperatorValue !== "and") {
    fail("unsupported-wp-tiles-tax-operator");
  }
  if (requiredAttribute(shortcode.attributes, "post_status") !== "publish") {
    fail("unsupported-wp-tiles-status");
  }
  if (requiredAttribute(shortcode.attributes, "tag") !== "") {
    fail("unsupported-wp-tiles-tag");
  }
  wpTilesTruthyAttribute(
    requiredAttribute(shortcode.attributes, "ignore_sticky_posts")
  );

  const postsPerPage = requiredAttribute(shortcode.attributes, "posts_per_page");
  // WP Tiles resolves "auto" from the first selected grid before its initial query.
  const limit = postsPerPage === "auto"
    ? wpTilesAutoLimit(shortcode.attributes.get("grids"), snapshot)
    : postsPerPage === "-1"
      ? null
      : positiveOrZeroInteger(postsPerPage, "invalid-wp-tiles-posts-per-page");
  const offset = positiveOrZeroInteger(
    requiredAttribute(shortcode.attributes, "offset"),
    "invalid-wp-tiles-offset"
  );
  const paginationValue = shortcode.attributes.get("pagination");
  const pagination = paginationValue === undefined
    ? snapshot.options.wpTilesPagination
      ?? fail("missing-wp-tiles-pagination-option")
    : paginationValue === "ajax"
      ? "ajax"
      : fail("unsupported-wp-tiles-pagination");
  const category = resolveCategoryTaxonomies(
    requiredAttribute(shortcode.attributes, "category"),
    locale,
    snapshot
  );
  const postParent = shortcode.attributes.get("post_parent") ?? null;

  if (postType === "post") {
    if (
      order !== "desc"
      || orderBy !== "date"
      || (category.kind === "resolved" && category.taxonomyIds.length === 0)
      || postParent !== null
    ) {
      fail("unsupported-wp-tiles-post-query");
    }
  } else if (
    order !== "asc"
    || orderBy !== "menu_order"
    || category.kind !== "resolved"
    || category.taxonomyIds.length !== 0
    || postParent === null
    || (postParent !== "current" && !/^\d+$/u.test(postParent))
  ) {
    fail("unsupported-wp-tiles-page-query");
  }
  return {
    category,
    excludeCurrentPost: wpTilesTruthyAttribute(
      requiredAttribute(shortcode.attributes, "exclude_current_post")
    ),
    limit,
    offset,
    order,
    orderBy,
    pagination,
    postParent,
    postType
  };
}

function pageRecordId(sourceId: string) {
  return `wordpress:page:${sourceId}`;
}

function galleryRecordId(sourceId: string) {
  return `wordpress:bwg-gallery:${sourceId}`;
}

function canonicalRecipePath(record: RecipeRecord) {
  const pathValue = getRecipePath(record);
  return pathValue.endsWith("/") ? pathValue : `${pathValue}/`;
}

function sourceCategoryIds(
  sourceId: string,
  memberships: ReadonlyMap<string, ReadonlySet<string>>,
  snapshot: EditorialSourceSnapshot
) {
  return [...(memberships.get(sourceId) ?? new Set<string>())]
    .filter((taxonomyId) => snapshot.graph.taxonomies.get(taxonomyId)?.taxonomy === "category")
    .sort(numericIdSort);
}

function hasCategoryMatch(
  sourceCategoryTaxonomyIds: readonly string[],
  categoryTaxonomyIds: readonly string[]
) {
  if (categoryTaxonomyIds.length === 0) {
    return true;
  }
  const values = new Set(sourceCategoryTaxonomyIds);
  return categoryTaxonomyIds.some((taxonomyId) => values.has(taxonomyId));
}

function validDate(value: string | null) {
  if (
    value === null
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
  ) {
    return false;
  }
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.valueOf())) {
    return false;
  }
  const normalized = [
    parsed.getUTCFullYear().toString().padStart(4, "0"),
    String(parsed.getUTCMonth() + 1).padStart(2, "0"),
    String(parsed.getUTCDate()).padStart(2, "0")
  ].join("-")
    + ` ${String(parsed.getUTCHours()).padStart(2, "0")}:`
    + `${String(parsed.getUTCMinutes()).padStart(2, "0")}:`
    + String(parsed.getUTCSeconds()).padStart(2, "0");
  return normalized === value;
}

function sortTileTargets(
  targets: readonly RawEditorialPostState[],
  query: TileQuery
) {
  const direction = query.order === "asc" ? 1 : -1;
  return [...targets].sort((left, right) => {
    const leftValue = query.orderBy === "date"
      ? left.createdGmt
      : left.menuOrder === null ? null : String(left.menuOrder).padStart(20, "0");
    const rightValue = query.orderBy === "date"
      ? right.createdGmt
      : right.menuOrder === null ? null : String(right.menuOrder).padStart(20, "0");
    if (leftValue === null || rightValue === null) {
      fail("incomplete-wp-tiles-order");
    }
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -direction : direction;
    }
    return numericIdSort(left.id, right.id) * direction;
  });
}

function recipeByEditorialPostId(records: readonly RecipeRecord[]) {
  const values = new Map<string, RecipeRecord[]>();
  for (const record of records) {
    const editorialPostId = record.source.editorialPostId;
    if (
      editorialPostId === null
      || record.source.editorialPostType !== "post"
    ) {
      continue;
    }
    const matches = values.get(editorialPostId) ?? [];
    matches.push(record);
    values.set(editorialPostId, matches);
  }
  return values;
}

function assertRecipeTaxonomyClosure(
  record: RecipeRecord,
  sourceCategoryTaxonomyIds: readonly string[]
) {
  const recipeCategoryTaxonomyIds = record.taxonomies
    .filter((taxonomy) =>
      taxonomy.scope === "editorial"
      && taxonomy.taxonomy === "category"
      && taxonomy.sourceTaxonomyId !== null
    )
    .map((taxonomy) => taxonomy.sourceTaxonomyId!)
    .sort(numericIdSort);
  if (
    recipeCategoryTaxonomyIds.length !== sourceCategoryTaxonomyIds.length
    || recipeCategoryTaxonomyIds.some(
      (taxonomyId, index) => taxonomyId !== sourceCategoryTaxonomyIds[index]
    )
  ) {
    fail("recipe-editorial-taxonomy-mismatch");
  }
}

function resolveTiles(
  shortcode: WordPressShortcode,
  input: {
    readonly currentPageId: string;
    readonly locale: Locale;
    readonly recipeRecords: readonly RecipeRecord[];
    readonly snapshot: EditorialSourceSnapshot;
    }
): ResolvedTiles {
    const query = parseTilesQuery(shortcode, input.locale, input.snapshot);
    const category = query.category;
    if (category.kind === "source-category-missing") {
      return { kind: "empty", reason: "source-category-missing" };
    }
    const posts = sourcePosts(input.snapshot);
    const locales = localizedPostIds(input.snapshot);
  const memberships = taxonomyMemberships(input.snapshot);
  const targetParent = query.postParent === "current"
    ? input.currentPageId
    : query.postParent;
  if (query.postType === "page" && targetParent !== null) {
    const parent = posts.get(targetParent);
    if (
      parent === undefined
      || parent.type !== "page"
      || parent.status !== "publish"
      || parent.hasPassword
      || parent.parentIdMalformed
      || locales.get(parent.id) !== input.locale
    ) {
      fail("unresolved-wp-tiles-page-parent");
    }
  }
  const matches = [...posts.values()].filter((post) => {
    if (
      post.type !== query.postType
      || post.status !== "publish"
      || post.hasPassword
      || post.parentIdMalformed
      || locales.get(post.id) !== input.locale
      || (query.excludeCurrentPost && post.id === input.currentPageId)
    ) {
      return false;
    }
    if (query.postType === "post") {
      return hasCategoryMatch(
        sourceCategoryIds(post.id, memberships, input.snapshot),
        category.taxonomyIds
      );
    }
    return post.parentId === targetParent && post.menuOrderMalformed === false;
  });
  for (const target of matches) {
    if (
      (query.orderBy === "date" && !validDate(target.createdGmt))
      || (
        query.orderBy === "menu_order"
        && (target.menuOrderMalformed || target.menuOrder === null)
      )
    ) {
      fail("incomplete-wp-tiles-order");
    }
  }
  const ordered = sortTileTargets(matches, query);
  const selected = ordered.slice(
    query.offset,
    query.limit === null || query.pagination === "ajax"
      ? undefined
      : query.offset + query.limit
  );
  if (selected.length === 0) {
    fail("empty-wp-tiles-selection");
  }
  if (selected.length > publicContentLimits.maxCardGridItems) {
    fail("wp-tiles-selection-limit");
  }

  if (query.postType === "page") {
    for (const target of selected) {
      if (!input.snapshot.graph.pages.has(target.id)) {
        fail("unresolved-wp-tiles-page-target");
      }
    }
    return {
      kind: "page" as const,
      pageTargetSourceIds: selected.map((target) => target.id),
      recipeIds: []
    };
  }

  const byEditorialPostId = recipeByEditorialPostId(input.recipeRecords);
  const recipeIds: string[] = [];
  for (const target of selected) {
    const candidates = (byEditorialPostId.get(target.id) ?? []).filter((record) =>
      record.locale === input.locale
      && record.source.editorialPostId === target.id
      && record.source.editorialPostType === "post"
    );
    if (candidates.length === 0) {
      fail("unresolved-wp-tiles-recipe-target");
    }
    if (candidates.length !== 1) {
      fail("ambiguous-wp-tiles-recipe-target");
    }
    const record = candidates[0]!;
    assertRecipeTaxonomyClosure(
      record,
      sourceCategoryIds(target.id, memberships, input.snapshot)
    );
    recipeIds.push(record.id);
  }
  return {
    kind: "recipe" as const,
    pageTargetSourceIds: [],
    recipeIds
  };
}

function sourceRouteTargets(
  snapshot: EditorialSourceSnapshot,
  recipeRecords: readonly RecipeRecord[],
  galleryId: string | null
) {
  const routes = new Map<string, SourceRouteTarget>();
  const add = (sourcePath: string, target: SourceRouteTarget) => {
    try {
      validateSafeLocalPath(sourcePath, "editorial source route");
      const key = localPathKey(sourcePath);
      const existing = routes.get(key);
      if (
        existing !== undefined
        && (
          existing.kind !== target.kind
          || existing.path !== target.path
          || (
            existing.kind === "editorial"
            && target.kind === "editorial"
            && existing.sourceId !== target.sourceId
          )
        )
      ) {
        fail("ambiguous-editorial-source-route");
      }
      routes.set(key, target);
    } catch (error) {
      if (error instanceof EditorialPromotionError) {
        throw error;
      }
      fail("unsafe-editorial-source-route");
    }
  };
  for (const [sourceId, page] of snapshot.graph.pages) {
    const sourcePath = sourcePathForPage(sourceId, snapshot);
    if (sourcePath === null) {
      continue;
    }
    add(sourcePath, {
      kind: "editorial",
      path: sourcePath,
      sourceId
    });
    if (page.guid !== null) {
      const redirect = sourceGuidPath(page.guid, snapshot.options.homeOrigin);
      if (redirect !== null) {
        add(redirect, {
          kind: "editorial",
          path: sourcePath,
          sourceId
        });
      }
    }
  }
  for (const record of recipeRecords) {
    const target = { kind: "recipe" as const, path: canonicalRecipePath(record) };
    add(canonicalRecipePath(record), target);
    for (const redirectFrom of record.redirectFrom) {
      add(redirectFrom, target);
    }
  }
  if (galleryId !== null) {
    add(galleryCanonicalPath, { kind: "gallery", path: galleryCanonicalPath });
  }
  return routes;
}

function sourcePathForPage(sourceId: string, snapshot: EditorialSourceSnapshot) {
  const page = snapshot.graph.pages.get(sourceId);
  if (page === undefined || page.slug === null) {
    return null;
  }
  const locales = localizedPostIds(snapshot);
  const locale = locales.get(sourceId);
  if (locale === undefined || locale === null) {
    return null;
  }
  const posts = sourcePosts(snapshot);
  const stack: string[] = [];
  let currentId: string | null = sourceId;
  while (currentId !== null) {
    if (stack.includes(currentId)) {
      return null;
    }
    const currentPage = snapshot.graph.pages.get(currentId);
    const currentPost = posts.get(currentId);
    if (
      currentPage === undefined
      || currentPost === undefined
      || currentPage.slug === null
      || currentPost.type !== "page"
      || currentPost.status !== "publish"
      || currentPost.hasPassword
      || currentPost.parentIdMalformed
      || locales.get(currentId) !== locale
    ) {
      return null;
    }
    let slug: string;
    try {
      slug = decodeRecipeSlug(currentPage.slug, "editorial page slug");
    } catch {
      return null;
    }
    stack.unshift(slug);
    currentId = currentPost.parentId;
  }
  const pathValue = `/${[...(locale === "en" ? [] : [locale]), ...stack].join("/")}/`;
  try {
    validateSafeLocalPath(pathValue, "editorial source path");
    return pathValue;
  } catch {
    return null;
  }
}

function sourceGuidPath(guid: string, homeOrigin: string) {
  try {
    const source = new URL(guid);
    const home = new URL(homeOrigin);
    if (
      !["http:", "https:"].includes(source.protocol)
      || source.hostname !== home.hostname
      || source.port !== home.port
      || source.username.length > 0
      || source.password.length > 0
      || source.search.length > 0
      || source.hash.length > 0
    ) {
      return null;
    }
    validateSafeLocalPath(source.pathname, "editorial source GUID");
    return decodeLocalPath(source.pathname);
  } catch {
    return null;
  }
}

function resolveSourceHref(
  href: string,
  currentPath: string,
  homeOrigin: string
): { readonly kind: "external"; readonly href: string }
  | { readonly kind: "internal"; readonly key: string } {
  const value = href.trim();
  if (
    value.length === 0
    || /[\u0000-\u001f\u007f\\]/u.test(value)
    || value.startsWith("//")
    || value.startsWith("#")
  ) {
    fail("unsafe-editorial-link");
  }
  let parsed: URL;
  try {
    parsed = new URL(value, new URL(currentPath, homeOrigin));
  } catch {
    fail("unsafe-editorial-link");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    fail("unsafe-editorial-link");
  }
  if (parsed.protocol === "mailto:") {
    return { kind: "external", href: value };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("unsafe-editorial-link");
  }
  const home = new URL(homeOrigin);
  if (parsed.hostname !== home.hostname || parsed.port !== home.port) {
    return { kind: "external", href: value };
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    fail("unsafe-editorial-link");
  }
  try {
    const absolutePath = value.match(
      /^https?:\/\/[^/?#]+(?<path>\/[^?#]*)?(?:[?#].*)?$/iu
    )?.groups?.path;
    const rawPath = /^https?:\/\//iu.test(value)
      ? (absolutePath ?? "/")
      : value.startsWith("/") ? value : `/${value}`;
    validateSafeLocalPath(rawPath, "editorial source link");
    validateSafeLocalPath(parsed.pathname, "editorial source link");
    return { kind: "internal", key: localPathKey(parsed.pathname) };
  } catch {
    fail("unsafe-editorial-link");
  }
}

function attachmentPathIndex(snapshot: EditorialSourceSnapshot) {
  const owners = new Map<string, Set<string>>();
  const home = new URL(snapshot.options.homeOrigin);
  const add = (value: string, sourceId: string) => {
    const values = owners.get(value) ?? new Set<string>();
    values.add(sourceId);
    owners.set(value, values);
  };
  for (const [sourceId, attachment] of snapshot.graph.attachments) {
    const file = normalizeWprmAttachmentFile(
      snapshot.graph.attachmentMeta.get(sourceId)?.attachedFile ?? null
    );
    if (file !== null) {
      try {
        add(localPathKey(`/wp-content/uploads/${file}`), sourceId);
      } catch {
        // The individual media mapper rejects the unsafe attachment path.
      }
    }
    if (attachment.guid !== null) {
      try {
        const guid = new URL(attachment.guid);
        if (
          (guid.protocol === "http:" || guid.protocol === "https:")
          && guid.hostname === home.hostname
          && guid.port === home.port
          && guid.username.length === 0
          && guid.password.length === 0
        ) {
          validateSafeLocalPath(guid.pathname, "editorial attachment URL");
          add(localPathKey(guid.pathname), sourceId);
        }
      } catch {
        // The attachment source row remains unsuitable for URL lookup.
      }
    }
  }
  return owners;
}

function isPublicImageMimeType(value: string | null): value is PublicMediaObject["mimeType"] {
  return value === "image/avif"
    || value === "image/gif"
    || value === "image/jpeg"
    || value === "image/png"
    || value === "image/webp";
}

function extensionMimeType(
  archivePath: string,
  mimeType: string | null
): { readonly extension: string; readonly mimeType: PublicMediaObject["mimeType"] } {
  const extension = path.posix.extname(archivePath).toLowerCase();
  if (!isPublicImageMimeType(mimeType)) {
    fail("unsupported-editorial-media-mime");
  }
  const expected = mimeType === "image/jpeg"
    ? new Set([".jpeg", ".jpg"])
    : mimeType === "image/png"
      ? new Set([".png"])
      : mimeType === "image/gif"
        ? new Set([".gif"])
        : mimeType === "image/webp"
          ? new Set([".webp"])
          : new Set([".avif"]);
  if (!expected.has(extension)) {
    fail("editorial-media-extension-mismatch");
  }
  return {
    extension,
    mimeType
  };
}

function attachmentMedia(
  attachmentId: string,
  snapshot: EditorialSourceSnapshot,
  bindings: Map<string, EditorialPlannedMediaBinding>
) {
  const attachment = snapshot.graph.attachments.get(attachmentId);
  const metadata = snapshot.graph.attachmentMeta.get(attachmentId);
  if (attachment === undefined || metadata === undefined) {
    fail("missing-editorial-media");
  }
  const archivePath = normalizeWprmAttachmentFile(metadata.attachedFile);
  if (archivePath === null) {
    fail("unsafe-editorial-media-path");
  }
  const archiveIndexes = snapshot.uploads.uploadPathArchives.get(archivePath);
  if (
    snapshot.uploads.uploadPathCounts.get(archivePath) !== 1
    || archiveIndexes === undefined
    || archiveIndexes.size !== 1
  ) {
    fail("unresolved-editorial-media");
  }
  const archiveIndex = [...archiveIndexes][0];
  if (archiveIndex === undefined) {
    fail("unresolved-editorial-media");
  }
  const archive = snapshot.uploads.summaries[archiveIndex];
  if (archive === undefined || archive.index !== archiveIndex) {
    fail("unresolved-editorial-media");
  }
  const { extension, mimeType } = extensionMimeType(archivePath, attachment.mimeType);
  if (metadata.width === null || metadata.height === null) {
    fail("invalid-editorial-media-dimensions");
  }
  const mediaId = `wordpress:attachment:${attachmentId}`;
  const publicPath = `/editorial/media/wordpress/${attachmentId}${extension}`;
  const bindingKey = `${attachmentId}:${publicPath}`;
  bindings.set(bindingKey, {
    archiveIndex,
    archiveSha256: archive.archiveSha256,
    archivePath,
    entryIndexContractSha256: archive.entryIndexContractSha256,
    publicPath,
    role: "inline",
    sourceId: attachmentId,
    sourceKind: "wordpress-attachment",
    width: metadata.width,
    height: metadata.height
  });
  return {
    media: {
      id: mediaId,
      path: publicPath,
      source: {
        system: "wordpress" as const,
        attachmentId: safePositiveNumber(attachmentId, "invalid-editorial-media-id")
      },
      mimeType,
      width: null,
      height: null
    } satisfies PublicMediaObject,
    mediaId
  };
}

function updateBindingRole(
  bindings: Map<string, EditorialPlannedMediaBinding>,
  attachmentId: string,
  publicPath: string,
  role: "featured" | "inline"
) {
  const bindingKey = `${attachmentId}:${publicPath}`;
  const binding = bindings.get(bindingKey);
  if (binding === undefined) {
    fail("missing-editorial-media-binding");
  }
  if (role === "featured") {
    bindings.set(bindingKey, { ...binding, role });
  }
}

function sourceTimestamp(value: string | null, code: string) {
  if (value === null) {
    return null;
  }
  if (!validDate(value)) {
    fail(code);
  }
  return `${value.replace(" ", "T")}Z`;
}

function exactFeaturedAmbiguity(
  outcome: EditorialCandidateOutcome,
  snapshot: EditorialSourceSnapshot
) {
  const candidate = outcome.record;
  const featuredReferences = snapshot.graph.featuredMediaReferences.get(outcome.sourceId) ?? [];
  if (
    featuredReferences.length !== 1
    || featuredReferences[0] === null
    || snapshot.graph.featuredMediaDuplicates.has(outcome.sourceId)
    || snapshot.graph.featuredMediaMalformed.has(outcome.sourceId)
    || candidate.media.length !== 1
  ) {
    return false;
  }
  const media = candidate.media[0]!;
  return media.sourceId === featuredReferences[0]
    && media.archiveMatch === "matched"
    && media.roles.length === 1
    && media.roles[0] === "featured";
}

function policyAllows(
  outcome: EditorialCandidateOutcome,
  snapshot: EditorialSourceSnapshot
) {
  return policyBlockReason(outcome, snapshot) === null;
}

function policyBlockReason(
  outcome: EditorialCandidateOutcome,
  snapshot: EditorialSourceSnapshot
) {
  if (ownerExcludedEditorialSourceIds.has(outcome.sourceId)) {
    return "owner-excluded-obsolete-privacy-policy";
  }
  if (
    outcome.record.publicationDisposition === "posts-archive"
    || outcome.publication !== "published"
  ) {
    return "publication-excluded";
  }
  const pattern = sortedIssuePattern(outcome.issueCodes);
  if (!acceptedIssuePatterns.has(pattern)) {
    return `source-issues:${pattern.length === 0 ? "none" : pattern}`;
  }
  if (
    pattern === "ambiguous-attachment-path,unsupported-wp-tiles"
    && !exactFeaturedAmbiguity(outcome, snapshot)
  ) {
    return "unproven-featured-ambiguity";
  }
  return null;
}

export function isEditorialPromotionPolicyEligible(
  outcome: EditorialCandidateOutcome,
  snapshot: EditorialSourceSnapshot
) {
  return policyAllows(outcome, snapshot);
}

function assertMappedPolicyProof(
  outcome: EditorialCandidateOutcome,
  record: EditorialPageRecord
) {
  const pattern = sortedIssuePattern(outcome.issueCodes);
  const blocks = record.content ?? [];
  const hasTiles = blocks.some((block) =>
    block.type === "recipeCardGrid"
    || block.type === "editorialPageCardGrid"
    || block.type === "emptyCardGrid"
  );
  const hasGallery = blocks.some((block) => block.type === "galleryCallout");
  const hasContact = blocks.some((block) => block.type === "contactForm");
  const expectsTiles = pattern.includes("unsupported-wp-tiles");
  const expectsGallery = pattern.includes("unsupported-block");
  const expectsContact = pattern === "unsupported-contact-form-7";
  if (
    hasTiles !== expectsTiles
    || hasGallery !== expectsGallery
    || hasContact !== expectsContact
  ) {
    fail("editorial-block-issue-mismatch");
  }
  if (
    (pattern === "unsupported-wp-tiles"
      || pattern === "ambiguous-attachment-path,unsupported-wp-tiles")
    && !hasTiles
  ) {
    fail("unproven-wp-tiles-mapping");
  }
  if (
    pattern === "unsupported-block,unsupported-wp-tiles"
    && (!hasTiles || !hasGallery)
  ) {
    fail("unproven-gallery-block-mapping");
  }
  if (pattern === "unsupported-contact-form-7" && !hasContact) {
    fail("unproven-contact-form-mapping");
  }
  if (pattern === "" && (hasTiles || hasGallery || hasContact)) {
    fail("unproven-editorial-block-mapping");
  }
}

function mapPage(
  outcome: EditorialCandidateOutcome,
  snapshot: EditorialSourceSnapshot,
  recipeRecords: readonly RecipeRecord[],
  routes: ReadonlyMap<string, SourceRouteTarget>,
  galleryId: string | null
): MappedEditorialPage {
  const page = snapshot.graph.pages.get(outcome.sourceId);
  if (page === undefined || outcome.locale === null) {
    fail("missing-editorial-page-source");
  }
  const canonicalPath = sourcePathForPage(outcome.sourceId, snapshot);
  if (canonicalPath === null || outcome.record.sourcePath !== canonicalPath) {
    fail("editorial-source-path-mismatch");
  }
  const sourcePost = sourcePosts(snapshot).get(outcome.sourceId);
  if (
    sourcePost === undefined
    || sourcePost.type !== "page"
    || sourcePost.status !== "publish"
    || sourcePost.hasPassword
    || sourcePost.parentIdMalformed
  ) {
    fail("invalid-editorial-page-source");
  }

  const bindings = new Map<string, EditorialPlannedMediaBinding>();
  const media = new Map<string, PublicMediaObject>();
  const attachmentOwners = attachmentPathIndex(snapshot);
  const pageGridTargetSourceIds = new Set<string>();
  const pageLinkTargetSourceIds = new Set<string>();
  let featuredMediaId: string | null = null;
  let featuredMediaAlt: string | null = null;

  const addAttachmentMedia = (attachmentId: string) => {
    const existing = media.get(`wordpress:attachment:${attachmentId}`);
    if (existing !== undefined) {
      return { media: existing, mediaId: existing.id };
    }
    const resolved = attachmentMedia(attachmentId, snapshot, bindings);
    media.set(resolved.media.id, resolved.media);
    return resolved;
  };

  const featured = outcome.record.media.filter((entry) => entry.roles.includes("featured"));
  if (featured.length > 1) {
    fail("ambiguous-featured-editorial-media");
  }
  if (featured.length === 1) {
    const entry = featured[0]!;
    if (entry.archiveMatch !== "matched") {
      fail("unresolved-featured-editorial-media");
    }
    const resolved = addAttachmentMedia(entry.sourceId);
    featuredMediaId = resolved.mediaId;
    featuredMediaAlt = entry.alt;
    updateBindingRole(bindings, entry.sourceId, resolved.media.path, "featured");
  }

  const mapImage = (image: WordPressImage) => {
    const resolved = resolveSourceHref(image.source, canonicalPath, snapshot.options.homeOrigin);
    if (resolved.kind !== "internal") {
      fail("external-editorial-image");
    }
    const owners = attachmentOwners.get(resolved.key) ?? new Set<string>();
    if (owners.size === 0) {
      fail("unresolved-inline-media");
    }
    if (owners.size !== 1) {
      fail("ambiguous-inline-media");
    }
    const attachmentId = [...owners][0];
    if (attachmentId === undefined) {
      fail("unresolved-inline-media");
    }
    const sourceClassIds = image.classNames
      .flatMap((className) => className.match(/^wp-image-(\d+)$/u)?.[1] ?? []);
    if (
      sourceClassIds.length > 1
      || (sourceClassIds.length === 1 && sourceClassIds[0] !== attachmentId)
    ) {
      fail("inline-media-source-mismatch");
    }
    const mapped = addAttachmentMedia(attachmentId);
    return { alt: image.alt, mediaId: mapped.mediaId };
  };

  const mapLink = (href: string) => {
    const resolved = resolveSourceHref(href, canonicalPath, snapshot.options.homeOrigin);
    if (resolved.kind === "external") {
      return resolved.href;
    }
    if (resolved.key === "/") {
      return "/";
    }
    const target = routes.get(resolved.key);
    if (target === undefined) {
      fail("unresolved-internal-link");
    }
    if (target.kind === "editorial") {
      pageLinkTargetSourceIds.add(target.sourceId);
    }
    return target.path;
  };

  const mapShortcode = (shortcode: WordPressShortcode): RichTextBlock | null => {
    if (shortcode.name === "contact-form-7") {
      if (!exactKeys(shortcode.attributes, ["id", "title"])) {
        fail("unsupported-contact-form-attribute");
      }
      if (
        !/^[1-9]\d*$/u.test(requiredAttribute(shortcode.attributes, "id"))
        || requiredAttribute(shortcode.attributes, "title").trim().length === 0
      ) {
        fail("malformed-contact-form-shortcode");
      }
      return { type: "contactForm" };
    }
    if (shortcode.name !== "wp-tiles") {
      fail("unsupported-shortcode");
    }
    const targets = resolveTiles(shortcode, {
      currentPageId: outcome.sourceId,
      locale: outcome.locale!,
      recipeRecords,
      snapshot
    });
    if (targets.kind === "empty") {
      return { type: "emptyCardGrid", reason: targets.reason };
    }
    if (targets.kind === "recipe") {
      return { type: "recipeCardGrid", recipeIds: [...targets.recipeIds] };
    }
    for (const sourceId of targets.pageTargetSourceIds) {
      pageGridTargetSourceIds.add(sourceId);
    }
    return {
      type: "editorialPageCardGrid",
      pageIds: targets.pageTargetSourceIds.map(pageRecordId)
    };
  };

  const content = mapWordPressHtmlToSafeAst(page.content, {
    mapImage,
    mapLink,
    mapShortcode,
    mapTwBwgBlock: () => {
      if (galleryId === null) {
        fail("unresolved-gallery-block");
      }
      return { type: "galleryCallout", galleryId };
    }
  });
  const title = decodeWordPressPlainText(page.title);
  if (title === null) {
    fail("missing-editorial-title");
  }
  const sourcePath = canonicalPath;
  const sourceRedirect = page.guid === null
    ? null
    : sourceGuidPath(page.guid, snapshot.options.homeOrigin);
  const redirectFrom = sourceRedirect === null
    || localPathKey(sourceRedirect) === localPathKey(sourcePath)
    ? []
    : [sourceRedirect];
  const record = editorialPageRecordSchema.parse({
    schemaVersion: 1,
    kind: "editorial-page",
    id: pageRecordId(outcome.sourceId),
    locale: outcome.locale,
    canonicalPath,
    translationGroupId: outcome.record.translationGroupId === null
      ? null
      : `wordpress:post-translations:${outcome.record.translationGroupId}`,
    source: {
      system: "wordpress",
      postId: safePositiveNumber(outcome.sourceId, "invalid-editorial-page-id"),
      sourcePath,
      sourceSlug: page.slug,
      createdAt: sourceTimestamp(page.createdGmt, "invalid-editorial-created-at"),
      modifiedAt: sourceTimestamp(page.modifiedGmt, "invalid-editorial-modified-at")
    },
    title,
    excerpt: decodeWordPressPlainText(page.excerpt),
    publishedAt: sourceTimestamp(page.createdGmt, "invalid-editorial-published-at"),
    modifiedAt: sourceTimestamp(page.modifiedGmt, "invalid-editorial-modified-at"),
    content,
    featuredMediaId,
    featuredMediaAlt,
    media: media.size === 0 ? null : [...media.values()].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    redirectFrom
  });
  assertMappedPolicyProof(outcome, record);
  return {
    mediaBindings: [...bindings.values()].sort((left, right) =>
      left.publicPath.localeCompare(right.publicPath)
    ),
    pageGridTargetSourceIds,
    pageLinkTargetSourceIds,
    record,
    sourceId: outcome.sourceId
  };
}

function galleryImagePublished(image: RawBwgImage) {
  const value = image.source.published ?? image.source.publish ?? image.source.status;
  if (value === undefined || value === null) {
    fail("unknown-gallery-image-publication");
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "publish", "published"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "draft", "private", "trash"].includes(normalized)) {
    return false;
  }
  fail("unknown-gallery-image-publication");
}

function galleryPublished(gallery: RawBwgGallery) {
  const value = gallery.source.published ?? gallery.source.publish ?? gallery.source.status;
  if (value === undefined || value === null) {
    fail("unknown-gallery-publication");
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "publish", "published"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "draft", "private", "trash"].includes(normalized)) {
    return false;
  }
  fail("unknown-gallery-publication");
}

function galleryDimensions(value: string | null) {
  const match = value?.match(/^\s*(?<width>[1-9]\d*)\s*x\s*(?<height>[1-9]\d*)(?:\s*px)?\s*$/iu);
  const width = match?.groups?.width === undefined ? Number.NaN : Number(match.groups.width);
  const height = match?.groups?.height === undefined ? Number.NaN : Number(match.groups.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    fail("invalid-gallery-media-dimensions");
  }
  return { width, height };
}

function galleryAsset(
  sourceId: string,
  role: "original" | "thumbnail",
  sourcePath: string,
  dimensions: { readonly width: number; readonly height: number } | null,
  snapshot: EditorialSourceSnapshot,
  bindings: Map<string, EditorialPlannedMediaBinding>
) {
  const normalized = normalizeBwgArchivePath(sourcePath);
  if (normalized.archivePath === null || normalized.kind === "unsafe") {
    fail("unsafe-gallery-media-path");
  }
  const archivePath = normalized.archivePath;
  const archiveIndexes = snapshot.uploads.uploadPathArchives.get(archivePath);
  if (
    snapshot.uploads.uploadPathCounts.get(archivePath) !== 1
    || archiveIndexes === undefined
    || archiveIndexes.size !== 1
  ) {
    fail("unresolved-gallery-media");
  }
  const archiveIndex = [...archiveIndexes][0];
  if (archiveIndex === undefined) {
    fail("unresolved-gallery-media");
  }
  const archive = snapshot.uploads.summaries[archiveIndex];
  if (archive === undefined || archive.index !== archiveIndex) {
    fail("unresolved-gallery-media");
  }
  const extension = path.posix.extname(archivePath).toLowerCase();
  const mimeType: PublicMediaObject["mimeType"] = extension === ".jpg" || extension === ".jpeg"
    ? "image/jpeg"
    : extension === ".png"
      ? "image/png"
      : extension === ".gif"
        ? "image/gif"
        : extension === ".webp"
          ? "image/webp"
          : extension === ".avif"
            ? "image/avif"
            : fail("unsupported-gallery-media-extension");
  const publicPath = `/gallery/media/wordpress-bwg/${sourceId}-${role}${extension}`;
  const mediaId = `wordpress:bwg-image:${sourceId}:${role}`;
  bindings.set(`${sourceId}:${role}:${publicPath}`, {
    archiveIndex,
    archiveSha256: archive.archiveSha256,
    archivePath,
    entryIndexContractSha256: archive.entryIndexContractSha256,
    publicPath,
    role,
    sourceId,
    sourceKind: "wordpress-bwg-image",
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null
  });
  return {
    id: mediaId,
    path: publicPath,
    source: {
      system: "wordpress-bwg" as const,
      imageId: safePositiveNumber(sourceId, "invalid-gallery-image-id")
    },
    mimeType,
    width: null,
    height: null
  } satisfies PublicMediaObject;
}

function mapGallery(snapshot: EditorialSourceSnapshot, gallerySourceId: string) {
  const gallery = snapshot.graph.galleries.get(gallerySourceId);
  if (gallery === undefined) {
    fail("missing-gallery-source");
  }
  if (!galleryPublished(gallery)) {
    fail("nonpublish-gallery");
  }
  const bindings = new Map<string, EditorialPlannedMediaBinding>();
  const images = snapshot.graph.galleryImages
    .filter((image) =>
      image.galleryIdState === "present"
      && image.galleryId === gallerySourceId
      && galleryImagePublished(image)
    )
    .sort((left, right) => {
      if (
        left.orderMalformed
        || right.orderMalformed
        || left.order === null
        || right.order === null
      ) {
        fail("invalid-gallery-image-order");
      }
      return left.order !== right.order
        ? left.order - right.order
        : numericIdSort(left.id, right.id);
    });
  if (images.length === 0) {
    fail("empty-gallery");
  }
  const media: PublicMediaObject[] = [];
  const entries = images.map((image) => {
    if (image.imageUrl === null) {
      fail("missing-gallery-original");
    }
    const original = galleryAsset(
      image.id,
      "original",
      image.imageUrl,
      galleryDimensions(image.resolution),
      snapshot,
      bindings
    );
    media.push(original);
    const thumbnail = image.thumbUrl === null
      ? null
      : galleryAsset(image.id, "thumbnail", image.thumbUrl, null, snapshot, bindings);
    if (thumbnail !== null) {
      media.push(thumbnail);
    }
    return {
      sourceImageId: safePositiveNumber(image.id, "invalid-gallery-image-id"),
      originalMediaId: original.id,
      thumbnailMediaId: thumbnail?.id ?? null,
      caption: decodeWordPressPlainText(image.description),
      alt: decodeWordPressPlainText(image.alt)
    };
  });
  const record = galleryRecordSchema.parse({
    schemaVersion: 1,
    kind: "gallery",
    id: galleryRecordId(gallerySourceId),
    locale: null,
    canonicalPath: galleryCanonicalPath,
    source: {
      system: "wordpress-bwg",
      galleryId: safePositiveNumber(gallerySourceId, "invalid-gallery-id")
    },
    title: decodeWordPressPlainText(gallery.source.name ?? null),
    description: decodeWordPressPlainText(gallery.source.description ?? null),
    featuredMediaId: null,
    media: media.sort((left, right) => left.id.localeCompare(right.id)),
    images: entries
  });
  return {
    bindings: [...bindings.values()].sort((left, right) =>
      left.publicPath.localeCompare(right.publicPath)
    ),
    record
  };
}

function statusOnlyPublicationExclusion(outcome: EditorialCandidateOutcome) {
  return outcome.publication === "publication-excluded"
    && outcome.issueCodes.every((code) =>
      code === "nonpublish-page"
      || code === "page-for-posts-archive"
      || code === "protected-page"
    );
}

function sourceParentId(sourceId: string, snapshot: EditorialSourceSnapshot) {
  const post = sourcePosts(snapshot).get(sourceId);
  if (post === undefined || post.type !== "page" || post.parentIdMalformed) {
    fail("invalid-editorial-page-parent");
  }
  return post.parentId;
}

function emptyLocaleCounts(): Record<Locale, number> {
  return { en: 0, fr: 0, ru: 0 };
}

export function planEditorialPromotion(input: {
  readonly outcomes: readonly EditorialCandidateOutcome[];
  readonly recipeRecords: readonly RecipeRecord[];
  readonly snapshot: EditorialSourceSnapshot;
}): EditorialPromotionPlan {
  const sourceGalleryIds = [...input.snapshot.graph.galleries.keys()].sort(numericIdSort);
  const galleryId = sourceGalleryIds.length === 1 && input.snapshot.graph.galleryImages.every((image) =>
    image.galleryIdState === "present"
    && image.galleryId !== null
    && image.galleryId === sourceGalleryIds[0]
  )
    ? galleryRecordId(sourceGalleryIds[0]!)
    : null;
  const routes = sourceRouteTargets(input.snapshot, input.recipeRecords, galleryId);
  const policyBlockedReasons = new Map<string, number>();
  const policyBlockedSourceIds = new Set<string>();
  const policyEligible = input.outcomes.filter((outcome) => {
    const reason = policyBlockReason(outcome, input.snapshot);
    if (reason === null) {
      return true;
    }
    policyBlockedSourceIds.add(outcome.sourceId);
    countReason(policyBlockedReasons, reason);
    return false;
  });
  const policyBlocked = policyBlockedSourceIds.size;
  let mappingBlocked = 0;
  const mappingBlockedReasons = new Map<string, number>();
  const mappingBlockedSourceIds = new Set<string>();
  let approvedEmptyCardGrids = 0;
  const approvedEmptyCardGridReasons = new Map<string, number>();
  const mapped = new Map<string, MappedEditorialPage>();

  for (const outcome of [...policyEligible].sort((left, right) =>
    numericIdSort(left.sourceId, right.sourceId)
  )) {
    try {
      const mappedPage = mapPage(
        outcome,
        input.snapshot,
        input.recipeRecords,
        routes,
        galleryId
      );
      mapped.set(outcome.sourceId, mappedPage);
      for (const block of mappedPage.record.content ?? []) {
        if (block.type === "emptyCardGrid") {
          approvedEmptyCardGrids += 1;
          countReason(approvedEmptyCardGridReasons, block.reason);
        }
      }
    } catch (error) {
      if (error instanceof EditorialHtmlMappingError || error instanceof EditorialPromotionError) {
        mappingBlocked += 1;
        mappingBlockedSourceIds.add(outcome.sourceId);
        countReason(mappingBlockedReasons, error.code);
        continue;
      }
      throw error;
    }
  }
  const outcomesBySourceId = new Map(input.outcomes.map((outcome) => [
    outcome.sourceId,
    outcome
  ]));
  const selected = new Set(mapped.keys());
  let hierarchyBlocked = 0;
  let referenceBlocked = 0;
  let translationBlocked = 0;
  const hierarchyBlockedReasons = new Map<string, number>();
  const referenceBlockedReasons = new Map<string, number>();
  const translationBlockedReasons = new Map<string, number>();
  const closureBlockKinds = new Map<string, "hierarchy" | "reference" | "translation">();
  const selectionBlockReason = (sourceId: string) => {
    if (policyBlockedSourceIds.has(sourceId)) {
      return "policy";
    }
    if (mappingBlockedSourceIds.has(sourceId)) {
      return "mapping";
    }
    const closureKind = closureBlockKinds.get(sourceId);
    if (closureKind !== undefined) {
      return closureKind;
    }
    return "missing";
  };
  let changed = true;

  while (changed) {
    changed = false;
    for (const sourceId of [...selected].sort(numericIdSort)) {
      const mappedPage = mapped.get(sourceId);
      if (mappedPage === undefined) {
        fail("mapped-editorial-page-missing");
      }
      const parentId = sourceParentId(sourceId, input.snapshot);
      const missingParent = parentId !== null && !selected.has(parentId);
      const missingReference = [...mappedPage.pageGridTargetSourceIds]
        .concat([...mappedPage.pageLinkTargetSourceIds])
        .some((targetSourceId) => !selected.has(targetSourceId));
      if (missingParent || missingReference) {
        selected.delete(sourceId);
        if (missingParent) {
          hierarchyBlocked += 1;
          closureBlockKinds.set(sourceId, "hierarchy");
          countReason(
            hierarchyBlockedReasons,
            `parent-${selectionBlockReason(parentId!)}-blocked`
          );
        } else {
          referenceBlocked += 1;
          closureBlockKinds.set(sourceId, "reference");
          const missingTarget = [...mappedPage.pageGridTargetSourceIds]
            .concat([...mappedPage.pageLinkTargetSourceIds])
            .find((targetSourceId) => !selected.has(targetSourceId));
          if (missingTarget === undefined) {
            fail("missing-editorial-reference-target");
          }
          countReason(
            referenceBlockedReasons,
            `target-${selectionBlockReason(missingTarget)}-blocked`
          );
        }
        changed = true;
        continue;
      }
      const outcome = outcomesBySourceId.get(sourceId);
      if (outcome === undefined) {
        fail("editorial-outcome-missing");
      }
      if (outcome.record.translationGroupId === null) {
        continue;
      }
      const groupMembers = input.outcomes.filter((candidate) =>
        candidate.record.translationGroupId === outcome.record.translationGroupId
      );
      const hasBlockingPeer = groupMembers.some((peer) =>
        !statusOnlyPublicationExclusion(peer) && !selected.has(peer.sourceId)
      );
      if (hasBlockingPeer) {
        selected.delete(sourceId);
        translationBlocked += 1;
        closureBlockKinds.set(sourceId, "translation");
        const peerReasons = groupMembers
          .filter((peer) =>
            peer.sourceId !== sourceId
            && !statusOnlyPublicationExclusion(peer)
            && !selected.has(peer.sourceId)
          )
          .map((peer) => selectionBlockReason(peer.sourceId))
          .sort((left, right) => left.localeCompare(right));
        const peerReason = peerReasons[0];
        if (peerReason === undefined) {
          fail("missing-translation-block-reason");
        }
        countReason(translationBlockedReasons, `peer-${peerReason}-blocked`);
        changed = true;
      }
    }
  }

  const selectedPages = [...selected]
    .sort(numericIdSort)
    .map((sourceId) => mapped.get(sourceId))
    .filter((value): value is MappedEditorialPage => value !== undefined);
  const galleryReferences = selectedPages.flatMap((page) =>
    (page.record.content ?? []).flatMap((block) =>
      block.type === "galleryCallout" ? [block.galleryId] : []
    )
  );
  if (galleryReferences.length > 1) {
    fail("ambiguous-gallery-publication");
  }
  let gallery: GalleryRecord | null = null;
  let galleryBindings: readonly EditorialPlannedMediaBinding[] = [];
  if (galleryReferences.length === 1) {
    const referencedGalleryId = galleryReferences[0]!;
    if (galleryId === null || referencedGalleryId !== galleryId || sourceGalleryIds.length !== 1) {
      fail("unresolved-gallery-publication");
    }
    const mappedGallery = mapGallery(input.snapshot, sourceGalleryIds[0]!);
    gallery = mappedGallery.record;
    galleryBindings = mappedGallery.bindings;
  }

  const editorialBindings = new Map<string, EditorialPlannedMediaBinding>();
  for (const page of selectedPages) {
    for (const binding of page.mediaBindings) {
      const key = `${binding.sourceKind}:${binding.sourceId}:${binding.publicPath}`;
      const existing = editorialBindings.get(key);
      if (
        existing !== undefined
        && (
          existing.archiveIndex !== binding.archiveIndex
          || existing.archivePath !== binding.archivePath
          || existing.archiveSha256 !== binding.archiveSha256
          || existing.entryIndexContractSha256 !== binding.entryIndexContractSha256
          || existing.width !== binding.width
          || existing.height !== binding.height
        )
      ) {
        fail("editorial-media-binding-mismatch");
      }
      if (existing === undefined || binding.role === "featured") {
        editorialBindings.set(key, binding);
      }
    }
  }

  const byLocale = emptyLocaleCounts();
  for (const page of selectedPages) {
    byLocale[page.record.locale] += 1;
  }
  const bindings = [
    ...[...editorialBindings.values()].sort((left, right) =>
      left.publicPath.localeCompare(right.publicPath)
    ),
    ...galleryBindings
  ];
  try {
    validatePublicContentCatalogs(
      selectedPages.map((page) => page.record),
      gallery === null ? [] : [gallery],
      {
        recipeRecords: input.recipeRecords,
        reservedPaths: getReservedPublicPaths(input.recipeRecords)
      }
    );
  } catch {
    fail("invalid-promoted-public-content-closure");
  }
  return {
    gallery,
    mediaBindings: bindings,
    publicationExcludedRecordIds: input.outcomes
      .filter((outcome) =>
        outcome.record.publicationDisposition === "posts-archive"
        || ownerExcludedEditorialSourceIds.has(outcome.sourceId)
      )
      .map((outcome) => pageRecordId(outcome.sourceId))
      .sort((left, right) => left.localeCompare(right)),
    records: selectedPages.map((page) => page.record),
    summary: {
      candidates: {
        approvedEmptyCardGrids,
        approvedEmptyCardGridReasons: sortedReasonCounts(approvedEmptyCardGridReasons),
        directPolicyEligible: policyEligible.length,
        mappingBlocked,
        mappingBlockedReasons: sortedReasonCounts(mappingBlockedReasons),
        policyBlocked,
        policyBlockedReasons: sortedReasonCounts(policyBlockedReasons),
        selected: selectedPages.length,
        translationBlocked,
        translationBlockedReasons: sortedReasonCounts(translationBlockedReasons),
        hierarchyBlocked,
        hierarchyBlockedReasons: sortedReasonCounts(hierarchyBlockedReasons),
        referenceBlocked,
        referenceBlockedReasons: sortedReasonCounts(referenceBlockedReasons)
      },
      records: {
        byLocale,
        galleries: gallery === null ? 0 : 1,
        redirects: selectedPages.reduce(
          (total, page) => total + (page.record.redirectFrom ?? []).length,
          0
        )
      },
      media: {
        bindings: bindings.length,
        editorialBindings: editorialBindings.size,
        galleryBindings: galleryBindings.length
      }
    }
  };
}
