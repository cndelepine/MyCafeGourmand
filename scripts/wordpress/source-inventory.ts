import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  assertWritableOutput,
  writeInventoryOutput
} from "../url-inventory/output";
import {
  defaultSqlDumpLimits,
  scanSqlDump,
  type SqlDumpLimits,
  type SqlInsert,
  type SqlValue
} from "./sql-stream";
import {
  defaultUploadArchiveLimits,
  inventoryUploadArchives,
  type UploadArchiveInventory,
  type UploadArchiveLimits
} from "./uploads-inventory";

type IdSet = Set<string>;
type SupportedLocale = "en" | "fr" | "ru";

interface PostRecord {
  readonly id: string;
  readonly postType: string;
}

interface PostTableData {
  readonly table: string;
  readonly columns: Set<string>;
  readonly records: Map<string, PostRecord>;
  readonly byType: Map<string, number>;
  readonly pageIds: IdSet;
  readonly attachmentIds: IdSet;
}

interface PostMetaData {
  readonly table: string;
  readonly columns: Set<string>;
  rows: number;
  readonly attachedFiles: Map<string, string>;
  readonly thumbnailMediaIds: IdSet;
  readonly recipeMediaIds: IdSet;
  readonly wprmSignalPostIds: IdSet;
  readonly wprmRecipeIds: IdSet;
  readonly ultimateSignalPostIds: IdSet;
  readonly oldSlugPostIds: IdSet;
  readonly localeByPost: Map<string, SupportedLocale>;
}

interface TermRecord {
  readonly id: string;
  readonly primaryLocale: SupportedLocale | null;
  readonly secondaryLocale: SupportedLocale | null;
}

interface TermTaxonomyRecord {
  readonly id: string;
  readonly termId: string;
  readonly taxonomy: string;
}

interface TermRelationship {
  readonly objectId: string;
  readonly termTaxonomyId: string;
}

interface RedirectData {
  rows: number;
  readonly ids: IdSet;
  readonly actionTypes: Map<string, number>;
  readonly statuses: Map<string, number>;
}

interface GalleryData {
  readonly bwgGalleryIds: IdSet;
  readonly bwgImageIds: IdSet;
  readonly bwgAlbumIds: IdSet;
  readonly bwgShortcodeIds: IdSet;
  readonly bwgImageGalleryRelations: Array<{
    imageId: string;
    galleryId: string;
  }>;
  readonly bwgAlbumGalleryRelations: Array<{
    albumId: string;
    galleryId: string;
  }>;
  finalTilesGalleryRows: number;
  finalTilesImageRows: number;
  readonly shortcodeReferenceIds: IdSet;
  readonly singularShortcodeReferenceIds: IdSet;
  readonly listShortcodeReferenceIds: IdSet;
  shortcodeReferences: number;
  singularShortcodeReferences: number;
  listShortcodeReferences: number;
  malformedShortcodeReferences: number;
}

interface RecipeTableData {
  wprmRows: number;
  readonly wprmIds: IdSet;
  ultimateRows: number;
  readonly ultimateIds: IdSet;
  wprmRatingRows: number;
  readonly wprmRatingRecipeIds: IdSet;
  readonly wprmRatingPostIds: IdSet;
}

interface IssueCounter {
  readonly values: Map<string, number>;
  add(code: string, count?: number): void;
}

export interface SourceInventoryLimits {
  readonly sql: Partial<SqlDumpLimits>;
  readonly uploads: Partial<UploadArchiveLimits>;
  readonly maxTermRelationships: number;
  readonly maxIdsPerCategory: number;
}

export const defaultSourceInventoryLimits: SourceInventoryLimits = {
  sql: defaultSqlDumpLimits,
  uploads: defaultUploadArchiveLimits,
  maxTermRelationships: 1_000_000,
  maxIdsPerCategory: 250_000
};

export interface WordPressSourceInventoryOptions {
  readonly database: string;
  readonly uploadArchives?: readonly string[];
  readonly uploads?: readonly string[];
  readonly limits?: Partial<SourceInventoryLimits>;
}

export interface SourceInventoryIssue {
  readonly code: string;
  readonly count: number;
}

export interface SourceTableCounts {
  readonly insertStatements: number;
  readonly rows: number;
}

export interface SourceInventoryOutput {
  readonly schemaVersion: 2;
  readonly kind: "wordpress-source-inventory";
  readonly source: {
    readonly databaseFormat: "sql" | "gzip";
    readonly compressedBytes: number;
    readonly decompressedBytes: number;
    readonly sqlStatements: number;
    readonly databaseTables: number;
    readonly sqlRows: number;
    readonly uploadArchives: number;
    readonly relevantSqlTables: Readonly<{
      posts: SourceTableCounts;
      postmeta: SourceTableCounts;
      comments: SourceTableCounts;
      terms: SourceTableCounts;
      termTaxonomy: SourceTableCounts;
      termRelationships: SourceTableCounts;
      redirectionItems: SourceTableCounts;
      bwgGallery: SourceTableCounts;
      bwgImage: SourceTableCounts;
      wprmRatings: SourceTableCounts;
    }>;
  };
  readonly posts: {
    readonly total: number;
    readonly pages: {
      readonly count: number;
      readonly ids: readonly string[];
    };
    readonly byType: readonly {
      postType: string;
      count: number;
    }[];
  };
  readonly recipes: {
    readonly wprm: {
      readonly postRecords: number;
      readonly postIds: readonly string[];
      readonly dedicatedRows: number;
      readonly dedicatedIds: readonly string[];
      readonly metadataSignalPosts: readonly string[];
      readonly ratingRows: number;
      readonly ratingRecipeIds: readonly string[];
      readonly ratingPostIds: readonly string[];
    };
    readonly ultimateRecipe: {
      readonly candidatePostRecords: number;
      readonly candidatePostIds: readonly string[];
      readonly candidatePostTypes: readonly {
        postType: string;
        count: number;
      }[];
      readonly metadataSignalPosts: readonly string[];
      readonly dedicatedRows: number;
      readonly dedicatedIds: readonly string[];
      readonly ambiguousPostTypeEvidence: boolean;
    };
  };
  readonly locales: {
    readonly posts: {
      readonly languageTermIds: Readonly<{
        en: readonly string[];
        fr: readonly string[];
        ru: readonly string[];
      }>;
      readonly counts: Readonly<{
        en: number;
        fr: number;
        ru: number;
      }>;
      readonly links: readonly {
        postId: string;
        locale: SupportedLocale;
      }[];
      readonly translationGroups: readonly {
        groupId: string;
        postIds: readonly string[];
      }[];
      readonly emptyTranslationGroups: number;
      readonly translationEdges: number;
    };
    readonly terms: {
      readonly termLanguageTermIds: Readonly<{
        en: readonly string[];
        fr: readonly string[];
        ru: readonly string[];
      }>;
      readonly counts: Readonly<{
        en: number;
        fr: number;
        ru: number;
      }>;
      readonly links: readonly {
        termId: string;
        locale: SupportedLocale;
      }[];
      readonly translationGroups: readonly {
        groupId: string;
        termIds: readonly string[];
      }[];
      readonly emptyTranslationGroups: number;
      readonly translationEdges: number;
    };
    readonly unsupportedLanguageTerms: number;
  };
  readonly taxonomies: {
    readonly terms: number;
    readonly termTaxonomies: number;
    readonly relationships: number;
    readonly byTaxonomy: readonly {
      taxonomy: string;
      terms: number;
      termTaxonomies: number;
      relationships: number;
      termTaxonomyIds: readonly string[];
    }[];
  };
  readonly redirects: {
    readonly redirectionItems: number;
    readonly redirectionItemIds: readonly string[];
    readonly redirectionGroups: number;
    readonly oldSlugMetadata: number;
    readonly oldSlugPostIds: readonly string[];
    readonly totalRecords: number;
  };
  readonly galleries: {
    readonly bwg: {
      readonly galleries: number;
      readonly galleryIds: readonly string[];
      readonly images: number;
      readonly imageIds: readonly string[];
      readonly albums: number;
      readonly albumIds: readonly string[];
      readonly shortcodes: number;
      readonly shortcodeIds: readonly string[];
      readonly imageGalleryRelationships: readonly {
        imageId: string;
        galleryId: string;
      }[];
      readonly albumGalleryRelationships: readonly {
        albumId: string;
        galleryId: string;
      }[];
    };
    readonly finalTiles: {
      readonly galleryRows: number;
      readonly imageRows: number;
    };
    readonly shortcodeReferences: {
      readonly count: number;
      readonly ids: readonly string[];
      readonly singularIds: readonly string[];
      readonly listIds: readonly string[];
      readonly singularReferences: number;
      readonly listReferences: number;
      readonly malformedReferences: number;
    };
  };
  readonly media: {
    readonly attachments: {
      readonly count: number;
      readonly ids: readonly string[];
    };
    readonly attachedFileMetadata: number;
    readonly referencedAttachmentIds: readonly string[];
    readonly archive: {
      readonly archiveCount: number;
      readonly entries: number;
      readonly files: number;
      readonly uploadFiles: number;
      readonly generatedDerivativeFiles: number;
      readonly uniqueUploadFiles: number;
      readonly matchedAttachedFiles: number;
      readonly missingAttachedFileIds: readonly string[];
      readonly unreferencedUploadFiles: number;
      readonly duplicateUploadPaths: number;
      readonly invalidEntries: number;
      readonly archives: UploadArchiveInventory["summaries"];
    };
  };
  readonly privacy: {
    readonly ignoredSensitiveTables: readonly string[];
    readonly rawValuesEmitted: false;
  };
  readonly issues: readonly SourceInventoryIssue[];
}

function createIssueCounter(): IssueCounter {
  const values = new Map<string, number>();
  return {
    values,
    add(code, count = 1) {
      if (count <= 0) {
        return;
      }
      values.set(code, (values.get(code) ?? 0) + count);
    }
  };
}

function mergeLimits(input: Partial<SourceInventoryLimits> | undefined) {
  const result: SourceInventoryLimits = {
    sql: { ...defaultSqlDumpLimits, ...(input?.sql ?? {}) },
    uploads: { ...defaultUploadArchiveLimits, ...(input?.uploads ?? {}) },
    maxTermRelationships: input?.maxTermRelationships ?? defaultSourceInventoryLimits.maxTermRelationships,
    maxIdsPerCategory: input?.maxIdsPerCategory ?? defaultSourceInventoryLimits.maxIdsPerCategory
  };
  for (const [key, value] of [
    ["maxTermRelationships", result.maxTermRelationships],
    ["maxIdsPerCategory", result.maxIdsPerCategory]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive safe integer.`);
    }
  }
  return result;
}

function value(row: SqlInsert["row"], column: string) {
  return row[column];
}

function requiredValue(row: SqlInsert["row"], column: string, context: string) {
  const result = value(row, column);
  if (result === undefined || result === null || result === "") {
    throw new Error(`Malformed ${context}: missing ${column}.`);
  }
  return result;
}

function requiredId(row: SqlInsert["row"], column: string, context: string) {
  const result = requiredValue(row, column, context);
  if (!/^\d+$/u.test(result) || result === "0") {
    throw new Error(`Malformed ${context}: ${column} must be a positive numeric ID.`);
  }
  return result;
}

function numericId(valueToCheck: SqlValue | undefined) {
  return valueToCheck && /^\d+$/u.test(valueToCheck) && valueToCheck !== "0"
    ? valueToCheck
    : null;
}

function safeIdentifier(raw: string, issues: IssueCounter) {
  const normalized = raw.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_:-]{0,63}$/u.test(normalized)) {
    return normalized;
  }
  issues.add("unsafe-identifier");
  return "(other)";
}

function addCount(values: Map<string, number>, key: string) {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function sortedIds(values: ReadonlySet<string>) {
  return [...values].sort(compareIds);
}

function compareIds(left: string, right: string) {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left.localeCompare(right);
}

function normalizeMediaPath(raw: string) {
  const normalized = raw.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized
    || normalized.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("Malformed attachment metadata: unsafe media path.");
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Malformed attachment metadata: unsafe media path.");
  }
  const uploadIndex = segments.reduce(
    (last, segment, index) => segment.toLowerCase() === "uploads" ? index : last,
    -1
  );
  return (uploadIndex === -1 ? segments : segments.slice(uploadIndex + 1)).join("/");
}

function localeFor(raw: string | null | undefined): SupportedLocale | null {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase().replace("_", "-");
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en" as const;
  }
  if (normalized === "fr" || normalized.startsWith("fr-")) {
    return "fr" as const;
  }
  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru" as const;
  }
  return null;
}

function secondaryLocaleFor(raw: string | null | undefined): SupportedLocale | null {
  const normalized = raw?.trim().toLowerCase();
  return normalized?.startsWith("pll_")
    ? localeFor(normalized.slice("pll_".length))
    : null;
}

function taxonomyIdentifier(raw: string, issues: IssueCounter) {
  return safeIdentifier(raw, issues);
}

function tableHasColumns(columns: ReadonlySet<string>, required: readonly string[]) {
  return required.every((column) => columns.has(column));
}

function tableEndsWith(table: string, suffix: string) {
  return table.toLowerCase().endsWith(suffix.toLowerCase());
}

function isWprmPostType(postType: string) {
  return postType.toLowerCase() === "wprm_recipe";
}

function isUltimateRecipePostType(postType: string) {
  return new Set([
    "recipe",
    "wpurp_recipe",
    "ultimate_recipe",
    "urp_recipe",
    "easyrecipe"
  ]).has(postType.toLowerCase());
}

function isWprmRecipeTable(table: string) {
  const normalized = table.toLowerCase();
  return normalized.endsWith("wprm_recipes") || normalized.endsWith("wprm_recipe");
}

function isUltimateRecipeTable(table: string) {
  const normalized = table.toLowerCase();
  return (
    normalized.includes("wpurp")
    || normalized.includes("ultimate_recipe")
    || normalized.endsWith("urp_recipe")
  );
}

function inspectGalleryShortcodes(
  content: string,
  gallery: GalleryData,
  issues: IssueCounter
) {
  const shortcodePattern =
    /\[(?:best[_-]?wordpress[_-]?gallery|bwg|ngg(?:allery)?|gallery)\b([^\]]*)\]/giu;
  const attribute = (attributes: string, name: "id" | "ids") => {
    const pattern = new RegExp(
      `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s\\]]+))`,
      "iu"
    );
    const match = attributes.match(pattern);
    return match?.[1] ?? match?.[2] ?? match?.[3];
  };
  const addReference = (
    rawId: string,
    target: IdSet,
    kind: "singular" | "list"
  ) => {
    const id = rawId.trim();
    if (!/^\d+$/u.test(id) || id === "0") {
      gallery.malformedShortcodeReferences += 1;
      issues.add("malformed-gallery-reference");
      return;
    }
    gallery.shortcodeReferences += 1;
    if (kind === "singular") {
      gallery.singularShortcodeReferences += 1;
    } else {
      gallery.listShortcodeReferences += 1;
    }
    target.add(id);
    gallery.shortcodeReferenceIds.add(id);
  };

  for (const match of content.matchAll(shortcodePattern)) {
    const attributes = match[1] ?? "";
    const singularId = attribute(attributes, "id");
    if (singularId !== undefined) {
      addReference(singularId, gallery.singularShortcodeReferenceIds, "singular");
    }
    const list = attribute(attributes, "ids");
    if (list !== undefined) {
      for (const member of list.split(",")) {
        addReference(member, gallery.listShortcodeReferenceIds, "list");
      }
    }
  }
}

function createPostTable(table: string, columns: readonly string[]): PostTableData {
  return {
    table,
    columns: new Set(columns),
    records: new Map(),
    byType: new Map(),
    pageIds: new Set(),
    attachmentIds: new Set()
  };
}

function createPostMetaTable(table: string, columns: readonly string[]): PostMetaData {
  return {
    table,
    columns: new Set(columns),
    rows: 0,
    attachedFiles: new Map(),
    thumbnailMediaIds: new Set(),
    recipeMediaIds: new Set(),
    wprmSignalPostIds: new Set(),
    wprmRecipeIds: new Set(),
    ultimateSignalPostIds: new Set(),
    oldSlugPostIds: new Set(),
    localeByPost: new Map()
  };
}

function createGalleryData(): GalleryData {
  return {
    bwgGalleryIds: new Set(),
    bwgImageIds: new Set(),
    bwgAlbumIds: new Set(),
    bwgShortcodeIds: new Set(),
    bwgImageGalleryRelations: [],
    bwgAlbumGalleryRelations: [],
    finalTilesGalleryRows: 0,
    finalTilesImageRows: 0,
    shortcodeReferenceIds: new Set(),
    singularShortcodeReferenceIds: new Set(),
    listShortcodeReferenceIds: new Set(),
    shortcodeReferences: 0,
    singularShortcodeReferences: 0,
    listShortcodeReferences: 0,
    malformedShortcodeReferences: 0
  };
}

function createRecipeTableData(): RecipeTableData {
  return {
    wprmRows: 0,
    wprmIds: new Set(),
    ultimateRows: 0,
    ultimateIds: new Set(),
    wprmRatingRows: 0,
    wprmRatingRecipeIds: new Set(),
    wprmRatingPostIds: new Set()
  };
}

function ensureIdCapacity(
  values: { readonly size: number },
  limits: SourceInventoryLimits,
  issues: IssueCounter
) {
  if (values.size > limits.maxIdsPerCategory) {
    issues.add("id-category-limit");
    throw new Error("The source inventory exceeded the configured ID safety limit.");
  }
}

function processPostInsert(
  tableData: PostTableData,
  insert: SqlInsert,
  gallery: GalleryData,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const id = requiredId(insert.row, "ID", "WordPress post");
  const rawType = requiredValue(insert.row, "post_type", "WordPress post");
  const postType = safeIdentifier(rawType, issues);
  if (tableData.records.has(id)) {
    throw new Error(`Malformed WordPress posts table: duplicate post ID ${id}.`);
  }
  tableData.records.set(id, { id, postType });
  addCount(tableData.byType, postType);
  if (postType === "page") {
    tableData.pageIds.add(id);
    ensureIdCapacity(tableData.pageIds, limits, issues);
  }
  if (postType === "attachment") {
    tableData.attachmentIds.add(id);
    ensureIdCapacity(tableData.attachmentIds, limits, issues);
  }
  const content = value(insert.row, "post_content");
  if (content) {
    inspectGalleryShortcodes(content, gallery, issues);
    ensureIdCapacity(gallery.shortcodeReferenceIds, limits, issues);
  }
}

function processPostMetaInsert(
  tableData: PostMetaData,
  insert: SqlInsert,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const postId = requiredId(insert.row, "post_id", "WordPress post metadata");
  const key = requiredValue(insert.row, "meta_key", "WordPress post metadata");
  const metaValue = value(insert.row, "meta_value");
  tableData.rows += 1;
  const normalizedKey = key.toLowerCase();

  if (normalizedKey === "_wp_attached_file") {
    if (metaValue === null || metaValue === undefined || metaValue === "") {
      throw new Error("Malformed attachment metadata: missing _wp_attached_file value.");
    }
    if (tableData.attachedFiles.has(postId)) {
      throw new Error("Malformed attachment metadata: duplicate _wp_attached_file value.");
    }
    tableData.attachedFiles.set(postId, normalizeMediaPath(metaValue));
    ensureIdCapacity(tableData.attachedFiles, limits, issues);
  }
  if (normalizedKey === "_thumbnail_id") {
    const mediaId = numericId(metaValue);
    if (mediaId) {
      tableData.thumbnailMediaIds.add(mediaId);
      ensureIdCapacity(tableData.thumbnailMediaIds, limits, issues);
    }
  }
  if (normalizedKey === "_wp_old_slug") {
    tableData.oldSlugPostIds.add(postId);
    ensureIdCapacity(tableData.oldSlugPostIds, limits, issues);
  }
  if (normalizedKey.includes("wprm")) {
    tableData.wprmSignalPostIds.add(postId);
    ensureIdCapacity(tableData.wprmSignalPostIds, limits, issues);
    if (normalizedKey === "_wprm_recipe_id" || normalizedKey === "wprm_recipe_id") {
      const recipeId = numericId(metaValue);
      if (recipeId) {
        tableData.wprmRecipeIds.add(recipeId);
        ensureIdCapacity(tableData.wprmRecipeIds, limits, issues);
      }
    }
  }
  if (
    normalizedKey.includes("wpurp")
    || normalizedKey.includes("ultimate_recipe")
    || normalizedKey.startsWith("urp_")
  ) {
    tableData.ultimateSignalPostIds.add(postId);
    ensureIdCapacity(tableData.ultimateSignalPostIds, limits, issues);
  }
  if (
    (normalizedKey.includes("wprm") || normalizedKey.includes("recipe"))
    && /(image|attachment|media)/u.test(normalizedKey)
  ) {
    const mediaId = numericId(metaValue);
    if (mediaId) {
      tableData.recipeMediaIds.add(mediaId);
      ensureIdCapacity(tableData.recipeMediaIds, limits, issues);
    }
  }
  if (normalizedKey === "_pll_language" || normalizedKey === "pll_language") {
    const locale = localeFor(metaValue);
    if (locale) {
      const previous = tableData.localeByPost.get(postId);
      if (previous && previous !== locale) {
        issues.add("conflicting-post-locales");
      }
      tableData.localeByPost.set(postId, locale);
      ensureIdCapacity(tableData.localeByPost, limits, issues);
    } else if (metaValue) {
      issues.add("unsupported-post-locale-metadata");
    }
  }
}

function processTermInsert(
  terms: Map<string, TermRecord>,
  insert: SqlInsert,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const id = requiredId(insert.row, "term_id", "WordPress term");
  const slug = value(insert.row, "slug");
  if (terms.has(id)) {
    throw new Error(`Malformed WordPress terms table: duplicate term ID ${id}.`);
  }
  terms.set(id, {
    id,
    primaryLocale: localeFor(slug),
    // Polylang uses `pll_`-prefixed slugs for secondary language taxonomies.
    secondaryLocale: secondaryLocaleFor(slug)
  });
  ensureIdCapacity(terms, limits, issues);
}

function processTermTaxonomyInsert(
  taxonomies: Map<string, TermTaxonomyRecord>,
  insert: SqlInsert,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const id = requiredId(insert.row, "term_taxonomy_id", "WordPress term taxonomy");
  const termId = requiredId(insert.row, "term_id", "WordPress term taxonomy");
  const rawTaxonomy = requiredValue(insert.row, "taxonomy", "WordPress term taxonomy");
  const taxonomy = taxonomyIdentifier(rawTaxonomy, issues);
  if (taxonomies.has(id)) {
    throw new Error(`Malformed WordPress term taxonomy table: duplicate ID ${id}.`);
  }
  taxonomies.set(id, { id, termId, taxonomy });
  ensureIdCapacity(taxonomies, limits, issues);
}

function processTermRelationshipInsert(
  relationships: TermRelationship[],
  relationshipsByTaxonomy: Map<string, TermRelationship[]>,
  insert: SqlInsert,
  limits: SourceInventoryLimits
) {
  const objectId = requiredId(insert.row, "object_id", "WordPress term relationship");
  const termTaxonomyId = requiredId(
    insert.row,
    "term_taxonomy_id",
    "WordPress term relationship"
  );
  relationships.push({ objectId, termTaxonomyId });
  const indexed = relationshipsByTaxonomy.get(termTaxonomyId) ?? [];
  indexed.push({ objectId, termTaxonomyId });
  relationshipsByTaxonomy.set(termTaxonomyId, indexed);
  if (relationships.length > limits.maxTermRelationships) {
    throw new Error("The source inventory exceeded the term relationship safety limit.");
  }
}

function processRedirectInsert(
  redirects: RedirectData,
  insert: SqlInsert,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const id = requiredId(insert.row, "id", "redirect record");
  if (redirects.ids.has(id)) {
    throw new Error(`Malformed redirect table: duplicate redirect ID ${id}.`);
  }
  redirects.ids.add(id);
  redirects.rows += 1;
  ensureIdCapacity(redirects.ids, limits, issues);
  const actionType = value(insert.row, "action_type");
  if (actionType) {
    addCount(redirects.actionTypes, safeIdentifier(actionType, issues));
  }
  const status = value(insert.row, "status") ?? value(insert.row, "action_code");
  if (status) {
    addCount(redirects.statuses, safeIdentifier(status, issues));
  }
}

function processGalleryInsert(
  gallery: GalleryData,
  insert: SqlInsert,
  table: string,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const normalized = table.toLowerCase();
  if (normalized.endsWith("bwg_gallery")) {
    gallery.bwgGalleryIds.add(requiredId(insert.row, "id", "BWG gallery"));
    ensureIdCapacity(gallery.bwgGalleryIds, limits, issues);
    return;
  }
  if (normalized.endsWith("bwg_image")) {
    const imageId = requiredId(insert.row, "id", "BWG image");
    gallery.bwgImageIds.add(imageId);
    ensureIdCapacity(gallery.bwgImageIds, limits, issues);
    const galleryId = numericId(value(insert.row, "gallery_id"));
    if (galleryId) {
      gallery.bwgImageGalleryRelations.push({ imageId, galleryId });
      if (gallery.bwgImageGalleryRelations.length > limits.maxIdsPerCategory) {
        throw new Error("The source inventory exceeded the gallery relationship safety limit.");
      }
    }
    return;
  }
  if (normalized.endsWith("bwg_album")) {
    gallery.bwgAlbumIds.add(requiredId(insert.row, "id", "BWG album"));
    ensureIdCapacity(gallery.bwgAlbumIds, limits, issues);
    return;
  }
  if (normalized.endsWith("bwg_shortcode")) {
    gallery.bwgShortcodeIds.add(requiredId(insert.row, "id", "BWG shortcode"));
    ensureIdCapacity(gallery.bwgShortcodeIds, limits, issues);
    return;
  }
  if (normalized.endsWith("bwg_album_gallery")) {
    const albumId = numericId(value(insert.row, "album_id"));
    const galleryId = numericId(value(insert.row, "gallery_id"));
    if (albumId && galleryId) {
      gallery.bwgAlbumGalleryRelations.push({ albumId, galleryId });
      if (gallery.bwgAlbumGalleryRelations.length > limits.maxIdsPerCategory) {
        throw new Error("The source inventory exceeded the gallery relationship safety limit.");
      }
    }
    return;
  }
  if (normalized.endsWith("finaltiles_gallery_images")) {
    gallery.finalTilesImageRows += 1;
    return;
  }
  if (normalized.endsWith("finaltiles_gallery")) {
    gallery.finalTilesGalleryRows += 1;
  }
}

function processRecipeTableInsert(
  recipes: RecipeTableData,
  insert: SqlInsert,
  table: string,
  issues: IssueCounter,
  limits: SourceInventoryLimits
) {
  const normalized = table.toLowerCase();
  if (isWprmRecipeTable(table)) {
    recipes.wprmRows += 1;
    const id = numericId(value(insert.row, "id")) ?? numericId(value(insert.row, "recipe_id"));
    if (id) {
      recipes.wprmIds.add(id);
      ensureIdCapacity(recipes.wprmIds, limits, issues);
    }
  } else if (isUltimateRecipeTable(table)) {
    recipes.ultimateRows += 1;
    const id = numericId(value(insert.row, "id")) ?? numericId(value(insert.row, "recipe_id"));
    if (id) {
      recipes.ultimateIds.add(id);
      ensureIdCapacity(recipes.ultimateIds, limits, issues);
    }
  } else if (normalized.endsWith("wprm_ratings")) {
    recipes.wprmRatingRows += 1;
    const recipeId = numericId(value(insert.row, "recipe_id"));
    const postId = numericId(value(insert.row, "post_id"));
    if (recipeId) {
      recipes.wprmRatingRecipeIds.add(recipeId);
      ensureIdCapacity(recipes.wprmRatingRecipeIds, limits, issues);
    }
    if (postId) {
      recipes.wprmRatingPostIds.add(postId);
      ensureIdCapacity(recipes.wprmRatingPostIds, limits, issues);
    }
  }
}

function tableCandidates(
  tables: ReadonlyMap<string, Set<string>>,
  suffix: string,
  requiredColumns: readonly string[]
) {
  return [...tables.entries()]
    .filter(([table, columns]) =>
      tableEndsWith(table, suffix) && tableHasColumns(columns, requiredColumns)
    )
    .map(([table]) => table);
}

function chooseCoreTable(
  candidates: readonly string[],
  companionCandidates: readonly string[],
  suffix: string,
  companionSuffix: string
) {
  const companionSet = new Set(companionCandidates.map((table) => table.toLowerCase()));
  const paired = candidates.filter((table) =>
    companionSet.has(`${table.slice(0, -suffix.length)}${companionSuffix}`.toLowerCase())
  );
  if (paired.length === 1) {
    return paired[0];
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length === 0) {
    throw new Error(`WordPress source is missing a ${suffix} table.`);
  }
  throw new Error(`WordPress source has ambiguous ${suffix} tables.`);
}

function sortedPostTypeCounts(values: ReadonlyMap<string, number>) {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([postType, count]) => ({ postType, count }));
}

function sortRelationships<T extends Record<string, string>>(values: readonly T[]) {
  return [...values].sort((left, right) => {
    const leftKey = Object.values(left).join(":");
    const rightKey = Object.values(right).join(":");
    return leftKey.localeCompare(rightKey);
  });
}

function sortedIssues(issues: IssueCounter) {
  return [...issues.values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

function tableInsertCounts(
  sqlStats: Awaited<ReturnType<typeof scanSqlDump>>,
  expectedTable: string
): SourceTableCounts {
  const actual = Object.entries(sqlStats.insertsByTable).find(
    ([table]) => table.toLowerCase() === expectedTable.toLowerCase()
  )?.[1];
  return actual ?? { insertStatements: 0, rows: 0 };
}

function aggregateArchives(
  archive: UploadArchiveInventory,
  attachedFiles: ReadonlyMap<string, string>,
  attachmentIds: ReadonlySet<string>,
  issues: IssueCounter
) {
  const referencedPaths = new Set(attachedFiles.values());
  const missingAttachedFileIds = new Set<string>();
  let matchedAttachedFiles = 0;
  for (const [attachmentId, mediaPath] of attachedFiles) {
    if (archive.uploadPathCounts.has(mediaPath)) {
      matchedAttachedFiles += 1;
    } else {
      missingAttachedFileIds.add(attachmentId);
    }
  }
  const uniqueUploadFiles = archive.uploadPathCounts.size;
  let unreferencedUploadFiles = 0;
  let duplicateUploadPaths = 0;
  for (const [mediaPath, count] of archive.uploadPathCounts) {
    if (!referencedPaths.has(mediaPath)) {
      unreferencedUploadFiles += 1;
    }
    if (count > 1) {
      duplicateUploadPaths += 1;
    }
  }
  const invalidEntries = archive.summaries.reduce(
    (total, summary) => total + summary.invalidEntries,
    0
  );
  if (invalidEntries > 0) {
    issues.add("invalid-upload-entry", invalidEntries);
  }
  if (archive.summaries.length === 0 && attachedFiles.size > 0) {
    issues.add("upload-archives-not-supplied");
  }
  for (const id of attachmentIds) {
    if (!attachedFiles.has(id)) {
      issues.add("attachment-without-file-metadata");
    }
  }
  return {
    archiveCount: archive.summaries.length,
    entries: archive.summaries.reduce((total, summary) => total + summary.entries, 0),
    files: archive.summaries.reduce((total, summary) => total + summary.files, 0),
    uploadFiles: archive.summaries.reduce((total, summary) => total + summary.uploadFiles, 0),
    generatedDerivativeFiles: archive.summaries.reduce(
      (total, summary) => total + summary.generatedDerivativeFiles,
      0
    ),
    uniqueUploadFiles,
    matchedAttachedFiles,
    missingAttachedFileIds: sortedIds(missingAttachedFileIds),
    unreferencedUploadFiles,
    duplicateUploadPaths,
    invalidEntries,
    archives: archive.summaries
  };
}

function createOutput(
  sqlStats: Awaited<ReturnType<typeof scanSqlDump>>,
  archive: UploadArchiveInventory,
  postTable: PostTableData,
  postMeta: PostMetaData | undefined,
  terms: ReadonlyMap<string, TermRecord>,
  termTaxonomies: ReadonlyMap<string, TermTaxonomyRecord>,
  termRelationships: readonly TermRelationship[],
  relationshipsByTaxonomy: ReadonlyMap<string, readonly TermRelationship[]>,
  redirects: RedirectData,
  redirectionGroupCount: number,
  gallery: GalleryData,
  recipes: RecipeTableData,
  issues: IssueCounter,
  limits: SourceInventoryLimits
): SourceInventoryOutput {
  const coreTablePrefix = postTable.table.slice(0, -"posts".length);
  const coreTable = (suffix: string) => `${coreTablePrefix}${suffix}`;
  const wprmPostIds = new Set<string>();
  const ultimatePostIds = new Set<string>();
  const ultimateTypeCounts = new Map<string, number>();
  for (const record of postTable.records.values()) {
    if (isWprmPostType(record.postType)) {
      wprmPostIds.add(record.id);
    }
    ensureIdCapacity(wprmPostIds, limits, issues);
    ensureIdCapacity(ultimatePostIds, limits, issues);
    if (isUltimateRecipePostType(record.postType)) {
      ultimatePostIds.add(record.id);
      addCount(ultimateTypeCounts, record.postType);
    }
  }
  const wprmMeta = postMeta?.wprmSignalPostIds ?? new Set<string>();
  const ultimateMeta = postMeta?.ultimateSignalPostIds ?? new Set<string>();
  ensureIdCapacity(wprmMeta, limits, issues);
  ensureIdCapacity(ultimateMeta, limits, issues);

  const postLanguageTermIds = {
    en: new Set<string>(),
    fr: new Set<string>(),
    ru: new Set<string>()
  };
  const termLanguageTermIds = {
    en: new Set<string>(),
    fr: new Set<string>(),
    ru: new Set<string>()
  };
  const localeByPost = new Map<string, SupportedLocale>();
  const localeByTerm = new Map<string, SupportedLocale>();
  let unsupportedLanguageTerms = 0;

  for (const taxonomy of termTaxonomies.values()) {
    if (taxonomy.taxonomy !== "language") {
      continue;
    }
    const term = terms.get(taxonomy.termId);
    const locale = term?.primaryLocale;
    if (!locale) {
      unsupportedLanguageTerms += 1;
      continue;
    }
    postLanguageTermIds[locale].add(taxonomy.termId);
    for (const relationship of relationshipsByTaxonomy.get(taxonomy.id) ?? []) {
      const previous = localeByPost.get(relationship.objectId);
      if (previous && previous !== locale) {
        issues.add("conflicting-post-locales");
      } else {
        localeByPost.set(relationship.objectId, locale);
      }
    }
  }

  for (const taxonomy of termTaxonomies.values()) {
    if (taxonomy.taxonomy !== "term_language") {
      continue;
    }
    const locale = terms.get(taxonomy.termId)?.secondaryLocale;
    if (!locale) {
      continue;
    }
    if (postLanguageTermIds[locale].size === 0) {
      issues.add("term-language-without-primary-language");
      continue;
    }
    termLanguageTermIds[locale].add(taxonomy.termId);
    for (const relationship of relationshipsByTaxonomy.get(taxonomy.id) ?? []) {
      const previous = localeByTerm.get(relationship.objectId);
      if (previous && previous !== locale) {
        issues.add("conflicting-term-locales");
      } else {
        localeByTerm.set(relationship.objectId, locale);
      }
    }
  }

  for (const [postId, locale] of postMeta?.localeByPost ?? []) {
    const previous = localeByPost.get(postId);
    if (previous && previous !== locale) {
      issues.add("conflicting-post-locales");
      continue;
    }
    localeByPost.set(postId, locale);
  }

  const postTranslationGroups = new Map<string, Set<string>>();
  const termTranslationGroups = new Map<string, Set<string>>();
  for (const taxonomy of termTaxonomies.values()) {
    if (taxonomy.taxonomy === "post_translations") {
      postTranslationGroups.set(
        taxonomy.id,
        new Set(
          (relationshipsByTaxonomy.get(taxonomy.id) ?? []).map(
            (relationship) => relationship.objectId
          )
        )
      );
    } else if (taxonomy.taxonomy === "term_translations") {
      termTranslationGroups.set(
        taxonomy.id,
        new Set(
          (relationshipsByTaxonomy.get(taxonomy.id) ?? []).map(
            (relationship) => relationship.objectId
          )
        )
      );
    }
  }
  const postTranslationGroupOutput = [...postTranslationGroups.entries()]
    .sort(([left], [right]) => compareIds(left, right))
    .map(([groupId, postIds]) => ({
      groupId,
      postIds: sortedIds(postIds)
    }));
  const termTranslationGroupOutput = [...termTranslationGroups.entries()]
    .sort(([left], [right]) => compareIds(left, right))
    .map(([groupId, termIds]) => ({
      groupId,
      termIds: sortedIds(termIds)
    }));
  const postEmptyTranslationGroups = postTranslationGroupOutput.filter(
    (group) => group.postIds.length === 0
  ).length;
  const termEmptyTranslationGroups = termTranslationGroupOutput.filter(
    (group) => group.termIds.length === 0
  ).length;
  const postTranslationEdges = postTranslationGroupOutput.reduce(
    (total, group) => total + Math.max(0, group.postIds.length - 1),
    0
  );
  const termTranslationEdges = termTranslationGroupOutput.reduce(
    (total, group) => total + Math.max(0, group.termIds.length - 1),
    0
  );
  if (unsupportedLanguageTerms > 0) {
    issues.add("unsupported-language-term", unsupportedLanguageTerms);
  }
  if (postEmptyTranslationGroups > 0) {
    issues.add("empty-post-translation-group", postEmptyTranslationGroups);
  }
  if (termEmptyTranslationGroups > 0) {
    issues.add("empty-term-translation-group", termEmptyTranslationGroups);
  }

  const taxonomySummary = new Map<string, {
    terms: Set<string>;
    termTaxonomies: Set<string>;
    relationships: number;
  }>();
  for (const taxonomy of termTaxonomies.values()) {
    const current = taxonomySummary.get(taxonomy.taxonomy) ?? {
      terms: new Set<string>(),
      termTaxonomies: new Set<string>(),
      relationships: 0
    };
    current.terms.add(taxonomy.termId);
    current.termTaxonomies.add(taxonomy.id);
    taxonomySummary.set(taxonomy.taxonomy, current);
  }
  let orphanRelationships = 0;
  for (const relationship of termRelationships) {
    const taxonomy = termTaxonomies.get(relationship.termTaxonomyId);
    if (!taxonomy) {
      orphanRelationships += 1;
      continue;
    }
    const current = taxonomySummary.get(taxonomy.taxonomy);
    if (current) {
      current.relationships += 1;
    }
  }
  if (orphanRelationships > 0) {
    issues.add("orphan-term-relationship", orphanRelationships);
  }

  const postCounts = {
    en: 0,
    fr: 0,
    ru: 0
  };
  const termCounts = {
    en: 0,
    fr: 0,
    ru: 0
  };
  for (const postId of postTable.records.keys()) {
    const locale = localeByPost.get(postId);
    if (locale) {
      postCounts[locale] += 1;
    }
  }
  for (const termId of terms.keys()) {
    const locale = localeByTerm.get(termId);
    if (locale) {
      termCounts[locale] += 1;
    }
  }

  const attachmentReferences = new Set<string>();
  for (const id of postMeta?.thumbnailMediaIds ?? []) {
    attachmentReferences.add(id);
  }
  for (const id of postMeta?.recipeMediaIds ?? []) {
    attachmentReferences.add(id);
  }
  const archiveSummary = aggregateArchives(
    archive,
    postMeta?.attachedFiles ?? new Map<string, string>(),
    postTable.attachmentIds,
    issues
  );
  const referencedAttachmentIds = sortedIds(attachmentReferences);
  const ambiguousPostTypeEvidence =
    ultimateTypeCounts.has("recipe") && ultimateTypeCounts.size === 1;
  if (ambiguousPostTypeEvidence) {
    issues.add("ambiguous-ultimate-recipe-post-type");
  }

  const postLocaleLinks = [...localeByPost.entries()]
    .filter(([postId]) => postTable.records.has(postId))
    .map(([postId, locale]) => ({ postId, locale }))
    .sort((left, right) =>
      compareIds(left.postId, right.postId) || left.locale.localeCompare(right.locale)
    );
  const termLocaleLinks = [...localeByTerm.entries()]
    .filter(([termId]) => terms.has(termId))
    .map(([termId, locale]) => ({ termId, locale }))
    .sort((left, right) =>
      compareIds(left.termId, right.termId) || left.locale.localeCompare(right.locale)
    );
  const byTaxonomy = [...taxonomySummary.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taxonomy, summary]) => ({
      taxonomy,
      terms: summary.terms.size,
      termTaxonomies: summary.termTaxonomies.size,
      relationships: summary.relationships,
      termTaxonomyIds: sortedIds(summary.termTaxonomies)
    }));

  return {
    schemaVersion: 2,
    kind: "wordpress-source-inventory",
    source: {
      databaseFormat: sqlStats.format,
      compressedBytes: sqlStats.compressedBytes,
      decompressedBytes: sqlStats.decompressedBytes,
      sqlStatements: sqlStats.statements,
      databaseTables: sqlStats.createTables,
      sqlRows: sqlStats.rows,
      uploadArchives: archive.summaries.length,
      relevantSqlTables: {
        posts: tableInsertCounts(sqlStats, postTable.table),
        postmeta: tableInsertCounts(sqlStats, postMeta?.table ?? coreTable("postmeta")),
        comments: tableInsertCounts(sqlStats, coreTable("comments")),
        terms: tableInsertCounts(sqlStats, coreTable("terms")),
        termTaxonomy: tableInsertCounts(sqlStats, coreTable("term_taxonomy")),
        termRelationships: tableInsertCounts(sqlStats, coreTable("term_relationships")),
        redirectionItems: tableInsertCounts(sqlStats, coreTable("redirection_items")),
        bwgGallery: tableInsertCounts(sqlStats, coreTable("bwg_gallery")),
        bwgImage: tableInsertCounts(sqlStats, coreTable("bwg_image")),
        wprmRatings: tableInsertCounts(sqlStats, coreTable("wprm_ratings"))
      }
    },
    posts: {
      total: postTable.records.size,
      pages: {
        count: postTable.pageIds.size,
        ids: sortedIds(postTable.pageIds)
      },
      byType: sortedPostTypeCounts(postTable.byType)
    },
    recipes: {
      wprm: {
        postRecords: wprmPostIds.size,
        postIds: sortedIds(wprmPostIds),
        dedicatedRows: recipes.wprmRows,
        dedicatedIds: sortedIds(recipes.wprmIds),
        metadataSignalPosts: sortedIds(wprmMeta),
        ratingRows: recipes.wprmRatingRows,
        ratingRecipeIds: sortedIds(recipes.wprmRatingRecipeIds),
        ratingPostIds: sortedIds(recipes.wprmRatingPostIds)
      },
      ultimateRecipe: {
        candidatePostRecords: ultimatePostIds.size,
        candidatePostIds: sortedIds(new Set([...ultimatePostIds, ...ultimateMeta])),
        candidatePostTypes: sortedPostTypeCounts(ultimateTypeCounts),
        metadataSignalPosts: sortedIds(ultimateMeta),
        dedicatedRows: recipes.ultimateRows,
        dedicatedIds: sortedIds(recipes.ultimateIds),
        ambiguousPostTypeEvidence
      }
    },
    locales: {
      posts: {
        languageTermIds: {
          en: sortedIds(postLanguageTermIds.en),
          fr: sortedIds(postLanguageTermIds.fr),
          ru: sortedIds(postLanguageTermIds.ru)
        },
        counts: postCounts,
        links: postLocaleLinks,
        translationGroups: postTranslationGroupOutput,
        emptyTranslationGroups: postEmptyTranslationGroups,
        translationEdges: postTranslationEdges
      },
      terms: {
        termLanguageTermIds: {
          en: sortedIds(termLanguageTermIds.en),
          fr: sortedIds(termLanguageTermIds.fr),
          ru: sortedIds(termLanguageTermIds.ru)
        },
        counts: termCounts,
        links: termLocaleLinks,
        translationGroups: termTranslationGroupOutput,
        emptyTranslationGroups: termEmptyTranslationGroups,
        translationEdges: termTranslationEdges
      },
      unsupportedLanguageTerms
    },
    taxonomies: {
      terms: terms.size,
      termTaxonomies: termTaxonomies.size,
      relationships: termRelationships.length,
      byTaxonomy
    },
    redirects: {
      redirectionItems: redirects.rows,
      redirectionItemIds: sortedIds(redirects.ids),
      redirectionGroups: redirectionGroupCount,
      oldSlugMetadata: postMeta?.oldSlugPostIds.size ?? 0,
      oldSlugPostIds: sortedIds(postMeta?.oldSlugPostIds ?? new Set<string>()),
      totalRecords: redirects.rows + (postMeta?.oldSlugPostIds.size ?? 0)
    },
    galleries: {
      bwg: {
        galleries: gallery.bwgGalleryIds.size,
        galleryIds: sortedIds(gallery.bwgGalleryIds),
        images: gallery.bwgImageIds.size,
        imageIds: sortedIds(gallery.bwgImageIds),
        albums: gallery.bwgAlbumIds.size,
        albumIds: sortedIds(gallery.bwgAlbumIds),
        shortcodes: gallery.bwgShortcodeIds.size,
        shortcodeIds: sortedIds(gallery.bwgShortcodeIds),
        imageGalleryRelationships: sortRelationships(gallery.bwgImageGalleryRelations),
        albumGalleryRelationships: sortRelationships(gallery.bwgAlbumGalleryRelations)
      },
      finalTiles: {
        galleryRows: gallery.finalTilesGalleryRows,
        imageRows: gallery.finalTilesImageRows
      },
      shortcodeReferences: {
        count: gallery.shortcodeReferences,
        ids: sortedIds(gallery.shortcodeReferenceIds),
        singularIds: sortedIds(gallery.singularShortcodeReferenceIds),
        listIds: sortedIds(gallery.listShortcodeReferenceIds),
        singularReferences: gallery.singularShortcodeReferences,
        listReferences: gallery.listShortcodeReferences,
        malformedReferences: gallery.malformedShortcodeReferences
      }
    },
    media: {
      attachments: {
        count: postTable.attachmentIds.size,
        ids: sortedIds(postTable.attachmentIds)
      },
      attachedFileMetadata: postMeta?.attachedFiles.size ?? 0,
      referencedAttachmentIds,
      archive: archiveSummary
    },
    privacy: {
      ignoredSensitiveTables: [
        "comments",
        "commentmeta",
        "users",
        "usermeta",
        "contacts",
        "subscribers",
        "newsletter"
      ],
      rawValuesEmitted: false
    },
    issues: sortedIssues(issues)
  };
}

export async function inventoryWordPressSource(
  options: WordPressSourceInventoryOptions
): Promise<SourceInventoryOutput> {
  const limits = mergeLimits(options.limits);
  const tableColumns = new Map<string, Set<string>>();
  const postTables = new Map<string, PostTableData>();
  const postMetaTables = new Map<string, PostMetaData>();
  const terms = new Map<string, TermRecord>();
  const termTaxonomies = new Map<string, TermTaxonomyRecord>();
  const termRelationships: TermRelationship[] = [];
  const relationshipsByTaxonomy = new Map<string, TermRelationship[]>();
  const redirects: RedirectData = {
    rows: 0,
    ids: new Set(),
    actionTypes: new Map(),
    statuses: new Map()
  };
  const gallery = createGalleryData();
  const recipes = createRecipeTableData();
  const issues = createIssueCounter();
  let redirectionGroupCount = 0;

  const sqlStats = await scanSqlDump(
    path.resolve(options.database),
    {
      onCreateTable(table) {
        const columns = new Set(table.columns);
        tableColumns.set(table.table, columns);
        if (
          tableHasColumns(columns, ["ID", "post_type"])
          && tableEndsWith(table.table, "posts")
        ) {
          postTables.set(table.table, createPostTable(table.table, table.columns));
        }
        if (
          tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
          && tableEndsWith(table.table, "postmeta")
        ) {
          postMetaTables.set(
            table.table,
            createPostMetaTable(table.table, table.columns)
          );
        }
      },
      getTableColumns(table) {
        return [...(tableColumns.get(table) ?? [])];
      },
      onInsert(insert) {
        const existingColumns = tableColumns.get(insert.table) ?? new Set(insert.columns);
        tableColumns.set(insert.table, existingColumns);
        if (
          tableHasColumns(existingColumns, ["ID", "post_type"])
          && tableEndsWith(insert.table, "posts")
        ) {
          const tableData =
            postTables.get(insert.table) ?? createPostTable(insert.table, insert.columns);
          postTables.set(insert.table, tableData);
          processPostInsert(tableData, insert, gallery, issues, limits);
        }
        if (
          tableHasColumns(existingColumns, ["post_id", "meta_key", "meta_value"])
          && tableEndsWith(insert.table, "postmeta")
        ) {
          const tableData =
            postMetaTables.get(insert.table)
            ?? createPostMetaTable(insert.table, insert.columns);
          postMetaTables.set(insert.table, tableData);
          processPostMetaInsert(tableData, insert, issues, limits);
        }
        const normalizedTable = insert.table.toLowerCase();
        if (tableEndsWith(insert.table, "terms") && tableHasColumns(existingColumns, ["term_id", "slug"])) {
          processTermInsert(terms, insert, issues, limits);
        } else if (
          tableEndsWith(insert.table, "term_taxonomy")
          && tableHasColumns(existingColumns, ["term_taxonomy_id", "term_id", "taxonomy"])
        ) {
          processTermTaxonomyInsert(termTaxonomies, insert, issues, limits);
        } else if (
          tableEndsWith(insert.table, "term_relationships")
          && tableHasColumns(existingColumns, ["object_id", "term_taxonomy_id"])
        ) {
          processTermRelationshipInsert(
            termRelationships,
            relationshipsByTaxonomy,
            insert,
            limits
          );
        } else if (
          normalizedTable.endsWith("redirection_items")
          && tableHasColumns(existingColumns, ["id"])
        ) {
          processRedirectInsert(redirects, insert, issues, limits);
        } else if (
          normalizedTable.endsWith("redirection_groups")
          && tableHasColumns(existingColumns, ["id"])
        ) {
          redirectionGroupCount += 1;
        } else if (
          normalizedTable.includes("bwg_")
          || normalizedTable.includes("finaltiles_")
        ) {
          processGalleryInsert(gallery, insert, insert.table, issues, limits);
        }
        processRecipeTableInsert(recipes, insert, insert.table, issues, limits);
      }
    },
    limits.sql
  );

  const postCandidates = tableCandidates(tableColumns, "posts", ["ID", "post_type"]);
  const postMetaCandidates = tableCandidates(
    tableColumns,
    "postmeta",
    ["post_id", "meta_key", "meta_value"]
  );
  const postTableName = chooseCoreTable(postCandidates, postMetaCandidates, "posts", "postmeta");
  const postMetaName = postMetaCandidates.length === 0
    ? undefined
    : chooseCoreTable(postMetaCandidates, postCandidates, "postmeta", "posts");
  const postTable = postTables.get(postTableName);
  if (!postTable) {
    throw new Error("WordPress source has no readable posts records.");
  }
  const postMeta = postMetaName ? postMetaTables.get(postMetaName) : undefined;
  if (!postMeta) {
    issues.add("missing-postmeta-table");
  }
  if (termRelationships.length > 0 && termTaxonomies.size === 0) {
    issues.add("relationships-without-taxonomy");
  }
  const archive = await inventoryUploadArchives(
    options.uploadArchives ?? options.uploads ?? [],
    limits.uploads
  );
  return createOutput(
    sqlStats,
    archive,
    postTable,
    postMeta,
    terms,
    termTaxonomies,
    termRelationships,
    relationshipsByTaxonomy,
    redirects,
    redirectionGroupCount,
    gallery,
    recipes,
    issues,
    limits
  );
}

export interface SourceInventoryCliArguments {
  readonly database: string;
  readonly uploads: readonly string[];
  readonly output?: string;
  readonly write: boolean;
  readonly dryRun: boolean;
  readonly overwrite: boolean;
  readonly limits: SourceInventoryLimits;
}

type ParsedArgument = string | boolean | string[];

const supportedOptions = new Set([
  "database",
  "uploads",
  "uploads-dir",
  "output",
  "write",
  "dry-run",
  "overwrite",
  "max-compressed-bytes",
  "max-decompressed-bytes",
  "max-statement-bytes",
  "max-sql-rows",
  "max-archives",
  "max-archive-bytes",
  "max-central-directory-bytes",
  "max-total-entries",
  "max-entries-per-archive",
  "max-entry-name-bytes",
  "max-entry-uncompressed-bytes",
  "max-total-uncompressed-bytes"
]);

function parseArguments(values: readonly string[]) {
  const parsed = new Map<string, ParsedArgument>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument?.startsWith("--") || argument === "--") {
      throw new Error(`Unexpected positional argument: ${argument ?? "<missing>"}`);
    }
    const key = argument.slice(2);
    if (!supportedOptions.has(key)) {
      throw new Error(`Unknown command-line option: --${key}`);
    }
    const next = values[index + 1];
    const takesValue = next !== undefined && !next.startsWith("--");
    if (!takesValue) {
      if (parsed.has(key)) {
        throw new Error(`Duplicate command-line option: --${key}`);
      }
      parsed.set(key, true);
      continue;
    }
    if (key === "uploads") {
      const existing = parsed.get(key);
      const paths = Array.isArray(existing) ? existing : [];
      parsed.set(key, [...paths, next]);
    } else {
      if (parsed.has(key)) {
        throw new Error(`Duplicate command-line option: --${key}`);
      }
      parsed.set(key, next);
    }
    index += 1;
  }
  return parsed;
}

function requiredArgument(args: ReadonlyMap<string, ParsedArgument>, key: string) {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option: --${key}`);
  }
  return value;
}

function numberArgument(args: ReadonlyMap<string, ParsedArgument>, key: string) {
  const value = args.get(key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`--${key} must be a positive safe integer.`);
  }
  return result;
}

async function expandUploadInputs(
  explicit: readonly string[],
  directory: string | undefined
) {
  const inputs = [...explicit];
  if (directory !== undefined) {
    const directoryPath = path.resolve(directory);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
        inputs.push(path.join(directoryPath, entry.name));
      }
    }
  }
  const unique = [...new Set(inputs.map((input) => path.resolve(input)))];
  return unique.sort((left, right) => left.localeCompare(right));
}

export async function runWordPressSourceInventory(
  argv: readonly string[]
): Promise<SourceInventoryOutput> {
  const args = parseArguments(argv);
  const database = requiredArgument(args, "database");
  const uploadsValue = args.get("uploads");
  const uploads = Array.isArray(uploadsValue) ? uploadsValue : [];
  const uploadsDirectory = args.get("uploads-dir");
  if (uploadsDirectory !== undefined && typeof uploadsDirectory !== "string") {
    throw new Error("--uploads-dir requires a directory path.");
  }
  const uploadArchives = await expandUploadInputs(
    uploads,
    typeof uploadsDirectory === "string" ? uploadsDirectory : undefined
  );
  const write = args.get("write") === true;
  const dryRun = args.get("dry-run") === true;
  const overwrite = args.get("overwrite") === true;
  const outputValue = args.get("output");
  const output = typeof outputValue === "string" ? path.resolve(outputValue) : undefined;
  if (write && !output) {
    throw new Error("--write requires an explicit --output path.");
  }
  if (!write && output) {
    throw new Error("--output is only valid together with --write.");
  }
  if (write && dryRun) {
    throw new Error("--dry-run and --write cannot be used together.");
  }
  if (overwrite && !write) {
    throw new Error("--overwrite is only valid together with --write.");
  }
  if (output) {
    await assertWritableOutput(output, overwrite);
  }

  const sql: Partial<SqlDumpLimits> = {};
  const sqlOptions: Array<[string, keyof SqlDumpLimits]> = [
    ["max-compressed-bytes", "maxCompressedBytes"],
    ["max-decompressed-bytes", "maxDecompressedBytes"],
    ["max-statement-bytes", "maxStatementBytes"],
    ["max-sql-rows", "maxRows"]
  ];
  for (const [option, key] of sqlOptions) {
    const value = numberArgument(args, option);
    if (value !== undefined) {
      sql[key] = value;
    }
  }
  const uploadsLimits: Partial<UploadArchiveLimits> = {};
  const uploadOptions: Array<[string, keyof UploadArchiveLimits]> = [
    ["max-archives", "maxArchives"],
    ["max-archive-bytes", "maxArchiveBytes"],
    ["max-central-directory-bytes", "maxCentralDirectoryBytes"],
    ["max-total-entries", "maxTotalEntries"],
    ["max-entries-per-archive", "maxEntriesPerArchive"],
    ["max-entry-name-bytes", "maxEntryNameBytes"],
    ["max-entry-uncompressed-bytes", "maxEntryUncompressedBytes"],
    ["max-total-uncompressed-bytes", "maxTotalUncompressedBytes"]
  ];
  for (const [option, key] of uploadOptions) {
    const value = numberArgument(args, option);
    if (value !== undefined) {
      uploadsLimits[key] = value;
    }
  }
  const inventory = await inventoryWordPressSource({
    database,
    uploadArchives,
    limits: {
      sql,
      uploads: uploadsLimits
    }
  });
  const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
  if (output) {
    await writeInventoryOutput(output, serialized, overwrite);
    console.log(`Created ${output}`);
  } else {
    process.stdout.write(serialized);
    console.error(
      "Dry run only; add --write --output migration-output/wordpress-source-inventory.json to write a file."
    );
  }
  return inventory;
}

export const runSourceInventory = runWordPressSourceInventory;
