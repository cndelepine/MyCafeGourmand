import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  SourceEvidenceError,
  type SourceEvidenceLimits
} from "./source-evidence-contracts";
import {
  numericId,
  rowValue,
  tableEndsWith,
  tableHasColumns
} from "./source-evidence-scan";
import { scanSqlDump, type SqlInsert, type SqlValue } from "./sql-stream";
import { parseStructuredValue } from "./source-evidence-structured";
import {
  WprmImportError,
  defaultWprmImportLimits,
  mergeWprmImportLimits,
  type RawAttachment,
  type RawAttachmentMeta,
  type RawRedirect,
  type RawTerm,
  type RawTermTaxonomy,
  type RawWordPressPost,
  type RawWprmMeta,
  type WprmImportLimits,
  type WprmImportLimitsInput,
  type WprmSourceGraph,
  type WprmSourceMetadata,
  type WprmSourceSnapshot,
  wprmTypeProvenance
} from "./wprm-import-contracts";
import {
  inventoryUploadArchives,
  type UploadArchiveInventory
} from "./uploads-inventory";
import {
  parseWordPressSourceOptions,
  WprmSourceOptionsError,
  type WprmWordPressOptions
} from "./wprm-import-options";

const wprmMetaKeys = new Set([
  "wprm_ingredients",
  "wprm_instructions",
  "wprm_parent_post_id",
  "_thumbnail_id",
  "wprm_servings",
  "wprm_servings_unit",
  "wprm_prep_time",
  "wprm_prep_time_zero",
  "wprm_cook_time",
  "wprm_cook_time_zero",
  "wprm_total_time",
  "wprm_custom_time",
  "wprm_custom_time_zero",
  "wprm_custom_time_label",
  "wprm_notes",
  "wprm_equipment",
  "wprm_nutrition_calories",
  "wprm_nutrition_serving_size",
  "wprm_nutrition_serving_unit",
  "wprm_servings_advanced_enabled",
  "wprm_servings_advanced"
]);

const wprmExcludedMetaKeys = new Set([
  "wprm_author_name",
  "wprm_pin_image_id",
  "wprm_pin_image_repin_id",
  "wprm_type",
  "wprm_video_id"
]);

const wprmOperationalMetaKeys = new Set([
  "wprm_author_display",
  "wprm_import_backup",
  "wprm_import_source",
  "wprm_ingredient_links_type",
  "wprm_metadata_cache",
  "wprm_seo",
  "wprm_seo_priority",
  "wprm_unit_system",
  "wprm_version",
  "wprm_video_metadata",
  "wprm_video_metadata_updated"
]);

const wpurSignalPrefixes = ["wpurp_", "ultimate_recipe", "urp_"];
const wpurSignalKeys = new Set([
  "recipe_title",
  "recipe_alternate_image",
  "recipe_description",
  "recipe_servings",
  "recipe_servings_type",
  "recipe_prep_time",
  "recipe_prep_time_text",
  "recipe_cook_time",
  "recipe_cook_time_text",
  "recipe_passive_time",
  "recipe_passive_time_text",
  "recipe_ingredients",
  "recipe_instructions",
  "recipe_notes",
  "recipe_video_id",
  "recipe_video_embed",
  "recipe_video_thumb"
]);

const attachmentMetaKeys = new Set([
  "_wp_attached_file",
  "_wp_attachment_image_alt",
  "_wp_attachment_metadata"
]);

function sourceError(error: unknown, fallback = "source-error"): WprmImportError {
  if (error instanceof WprmImportError) {
    return error;
  }
  if (
    error instanceof SourceEvidenceError
    || (error && typeof error === "object" && "code" in error
      && typeof error.code === "string")
  ) {
    const code = error instanceof SourceEvidenceError
      ? error.code
      : String(error.code);
    return new WprmImportError(code);
  }
  return new WprmImportError(fallback);
}

function valueText(value: SqlValue | undefined) {
  return value === null || value === undefined ? null : value;
}

function numericOrNull(value: SqlValue | undefined) {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return numericId(value.trim());
}

function stringOrNull(value: SqlValue | undefined) {
  if (value === null || value === undefined || value.length === 0) {
    return null;
  }
  return value;
}

function contentReferences(content: string, limit: number) {
  if (Buffer.byteLength(content, "utf8") > limit) {
    throw new SourceEvidenceError("post-content-scan-limit");
  }
  const references = new Set<string>();
  const shortcode =
    /\[\s*wprm-recipe\b[^\]]*\bid\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/giu;
  const block =
    /(?:wp-recipe-maker\/recipe|wprm-recipe)\b[^>\n]*?(?:"id"\s*:\s*|id\s*=\s*)(?:"?)(\d+)/giu;
  for (const match of content.matchAll(shortcode)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) {
      references.add(id);
    }
  }
  for (const match of content.matchAll(block)) {
    const id = match[1];
    if (id) {
      references.add(id);
    }
  }
  return references;
}

interface PassOneState {
  readonly tableColumns: Map<string, Set<string>>;
  readonly postTables: Set<string>;
  readonly postMetaTables: Set<string>;
  readonly optionTables: Set<string>;
  readonly optionTableDefinitions: Set<string>;
  readonly optionTableCandidates: Set<string>;
  readonly options: Map<string, string | null>;
  optionRecordCount: number;
  readonly posts: Map<string, RawWordPressPost>;
  readonly attachments: Map<string, RawAttachment>;
  readonly terms: Map<string, RawTerm>;
  readonly taxonomies: Map<string, RawTermTaxonomy>;
  readonly relationships: Map<string, Set<string>>;
  readonly redirects: RawRedirect[];
  postCount: number;
  relationshipCount: number;
  redirectCount: number;
  referenceCount: number;
  oldSlugCount: number;
  excludedRatingData: number;
}

function createPassOneState(): PassOneState {
  return {
    tableColumns: new Map(),
    postTables: new Set(),
    postMetaTables: new Set(),
    optionTables: new Set(),
    optionTableDefinitions: new Set(),
    optionTableCandidates: new Set(),
    options: new Map(),
    optionRecordCount: 0,
    posts: new Map(),
    attachments: new Map(),
    terms: new Map(),
    taxonomies: new Map(),
    relationships: new Map(),
    redirects: [],
    postCount: 0,
    relationshipCount: 0,
    redirectCount: 0,
    referenceCount: 0,
    oldSlugCount: 0,
    excludedRatingData: 0
  };
}

function rememberColumns(state: PassOneState, table: string, columns: readonly string[]) {
  const key = table.toLowerCase();
  const existing = state.tableColumns.get(key);
  if (existing === undefined) {
    state.tableColumns.set(key, new Set(columns));
  }
  return state.tableColumns.get(key) ?? new Set(columns);
}

function isExcludedTable(table: string) {
  const normalized = table.toLowerCase();
  return normalized.endsWith("comments")
    || normalized.endsWith("commentmeta")
    || normalized.includes("rating");
}

function processPost(
  state: PassOneState,
  insert: SqlInsert,
  limits: SourceEvidenceLimits
) {
  const id = numericId(rowValue(insert.row, "ID"));
  const typeValue = rowValue(insert.row, "post_type");
  if (id === null || typeValue === null || typeValue === undefined) {
    throw new SourceEvidenceError("malformed-post");
  }
  const type = typeValue.trim();
  const normalizedType = type.toLowerCase();
  const selected = normalizedType === "wprm_recipe"
    || normalizedType === "post"
    || normalizedType === "page"
    || normalizedType === "attachment";
  if (!selected) {
    return;
  }
  if (state.posts.has(id)) {
    throw new SourceEvidenceError("duplicate-post-id");
  }
  const rawContent = valueText(rowValue(insert.row, "post_content"));
  const references = rawContent === null
    ? new Set<string>()
    : contentReferences(rawContent, limits.maxPostContentBytes);
  state.referenceCount += references.size;
  if (state.referenceCount > limits.maxEvidenceReferences) {
    throw new SourceEvidenceError("evidence-reference-limit");
  }
  const post: RawWordPressPost = {
    id,
    type,
    status: rowValue(insert.row, "post_status")?.trim().toLowerCase() ?? "",
    hasPassword: (rowValue(insert.row, "post_password") ?? "").length > 0,
    parentId: numericOrNull(rowValue(insert.row, "post_parent")),
    slug: stringOrNull(rowValue(insert.row, "post_name")),
    title: selected && normalizedType !== "attachment"
      ? valueText(rowValue(insert.row, "post_title"))
      : null,
    content: selected && normalizedType !== "attachment" ? rawContent : null,
    excerpt: selected && normalizedType !== "attachment"
      ? valueText(rowValue(insert.row, "post_excerpt"))
      : null,
    createdLocal: valueText(rowValue(insert.row, "post_date")),
    createdGmt: valueText(rowValue(insert.row, "post_date_gmt")),
    modifiedLocal: valueText(rowValue(insert.row, "post_modified")),
    modifiedGmt: valueText(rowValue(insert.row, "post_modified_gmt")),
    mimeType: valueText(rowValue(insert.row, "post_mime_type")),
    wprmReferences: references
  };
  state.posts.set(id, post);
  state.postCount += 1;
  if (state.postCount > limits.maxPosts) {
    throw new SourceEvidenceError("post-limit");
  }
  if (normalizedType === "attachment") {
    state.attachments.set(id, {
      id,
      mimeType: post.mimeType
    });
  }
}

function processTerms(
  state: PassOneState,
  insert: SqlInsert,
  limits: SourceEvidenceLimits
) {
  const table = insert.table.toLowerCase();
  if (table.endsWith("terms")) {
    const id = numericId(rowValue(insert.row, "term_id"));
    if (id === null || state.terms.has(id)) {
      throw new SourceEvidenceError("malformed-term");
    }
    state.terms.set(id, {
      id,
      name: valueText(rowValue(insert.row, "name")),
      slug: valueText(rowValue(insert.row, "slug"))
    });
  } else if (table.endsWith("term_taxonomy")) {
    const id = numericId(rowValue(insert.row, "term_taxonomy_id"));
    const termId = numericId(rowValue(insert.row, "term_id"));
    const taxonomy = rowValue(insert.row, "taxonomy");
    if (id === null || termId === null || taxonomy === null || taxonomy === undefined) {
      throw new SourceEvidenceError("malformed-term-taxonomy");
    }
    if (state.taxonomies.has(id)) {
      throw new SourceEvidenceError("duplicate-term-taxonomy");
    }
    state.taxonomies.set(id, {
      id,
      termId,
      taxonomy: taxonomy
    });
  } else if (table.endsWith("term_relationships")) {
    const objectId = numericId(rowValue(insert.row, "object_id"));
    const taxonomyId = numericId(rowValue(insert.row, "term_taxonomy_id"));
    if (objectId === null || taxonomyId === null) {
      throw new SourceEvidenceError("malformed-term-relationship");
    }
    state.relationshipCount += 1;
    if (state.relationshipCount > limits.maxTermRelationships) {
      throw new SourceEvidenceError("term-relationship-limit");
    }
    const members = state.relationships.get(taxonomyId) ?? new Set<string>();
    members.add(objectId);
    state.relationships.set(taxonomyId, members);
  }
}

function processRedirect(
  state: PassOneState,
  insert: SqlInsert,
  limits: WprmImportLimits
) {
  state.redirectCount += 1;
  if (state.redirectCount > limits.maxRedirectRecords) {
    throw new SourceEvidenceError("redirect-record-limit");
  }
  state.redirects.push({
    id: numericId(rowValue(insert.row, "id")) ?? "0",
    source: valueText(rowValue(insert.row, "url"))
      ?? valueText(rowValue(insert.row, "match_url")),
    matchType: valueText(rowValue(insert.row, "match_type")),
    regex: valueText(rowValue(insert.row, "regex")),
    status: valueText(rowValue(insert.row, "status")),
    actionType: valueText(rowValue(insert.row, "action_type")),
    actionCode: valueText(rowValue(insert.row, "action_code")),
    actionData: valueText(rowValue(insert.row, "action_data"))
  });
}

function processOption(
  state: PassOneState,
  insert: SqlInsert,
  limits: WprmImportLimits,
  optionTable: string
) {
  if (insert.table.toLowerCase() !== optionTable) {
    return;
  }
  state.optionRecordCount += 1;
  if (state.optionRecordCount > limits.maxOptionRecords) {
    throw new SourceEvidenceError("option-record-limit");
  }
  const name = rowValue(insert.row, "option_name");
  if (name === null || name === undefined) {
    throw new SourceEvidenceError("malformed-option");
  }
  if (
    name === "home"
    || name === "permalink_structure"
    || name === "polylang"
  ) {
    if (state.options.has(name)) {
      throw new SourceEvidenceError("duplicate-option");
    }
    const value = valueText(rowValue(insert.row, "option_value"));
    if (
      value !== null
      && Buffer.byteLength(value, "utf8") > limits.evidence.maxMetaValueBytes
    ) {
      throw new SourceEvidenceError("option-value-limit");
    }
    state.options.set(name, value);
  }
}

function graphHandlers(state: PassOneState, limits: WprmImportLimits) {
  return {
    onCreateTable(table: { readonly table: string; readonly columns: readonly string[] }) {
      const columns = rememberColumns(state, table.table, table.columns);
      const normalizedTable = table.table.toLowerCase();
      if (tableEndsWith(normalizedTable, "options")) {
        if (state.optionTableDefinitions.has(normalizedTable)) {
          throw new SourceEvidenceError("duplicate-options-table");
        }
        state.optionTableDefinitions.add(normalizedTable);
        state.optionTables.add(normalizedTable);
        if (tableHasColumns(columns, ["option_name", "option_value"])) {
          state.optionTableCandidates.add(normalizedTable);
        }
      }
      if (
        tableEndsWith(table.table, "posts")
        && tableHasColumns(columns, ["ID", "post_type"])
      ) {
        state.postTables.add(table.table.toLowerCase());
      }
      if (
        tableEndsWith(table.table, "postmeta")
        && tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
      ) {
        state.postMetaTables.add(table.table.toLowerCase());
      }
    },
    getTableColumns(table: string) {
      return [...(state.tableColumns.get(table.toLowerCase()) ?? [])];
    },
    onInsert(insert: SqlInsert) {
      const columns = rememberColumns(state, insert.table, insert.columns);
      const table = insert.table.toLowerCase();
      if (tableEndsWith(table, "options")) {
        state.optionTables.add(table);
        if (tableHasColumns(columns, ["option_name", "option_value"])) {
          state.optionTableCandidates.add(table);
          processOption(
            state,
            insert,
            limits,
            table
          );
        }
      } else if (
        tableEndsWith(table, "posts")
        && tableHasColumns(columns, ["ID", "post_type"])
      ) {
        state.postTables.add(table);
        processPost(state, insert, limits.evidence);
      } else if (
        tableEndsWith(table, "postmeta")
        && tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
      ) {
        state.postMetaTables.add(table);
      } else if (
        tableEndsWith(table, "terms")
        || tableEndsWith(table, "term_taxonomy")
        || tableEndsWith(table, "term_relationships")
      ) {
        processTerms(state, insert, limits.evidence);
      } else if (table.endsWith("redirection_items")) {
        processRedirect(state, insert, limits);
      } else if (isExcludedTable(table)) {
        state.excludedRatingData += 1;
      }
    }
  };
}

function selectTable(
  tables: ReadonlySet<string>,
  suffix: string,
  code: string
) {
  const matches = [...tables].filter((table) => table.endsWith(suffix));
  if (matches.length !== 1) {
    throw new WprmImportError(code);
  }
  return matches[0]!;
}

function selectOptionsTable(state: PassOneState) {
  if (state.optionTables.size === 0) {
    throw new WprmImportError("missing-options-table");
  }
  if (state.optionTables.size !== 1) {
    throw new WprmImportError("multiple-options-tables");
  }
  if (state.optionTableCandidates.size !== 1) {
    throw new WprmImportError("missing-options-columns");
  }
  return [...state.optionTableCandidates][0]!;
}

function makeGraph(state: PassOneState): WprmSourceGraph {
  return {
    posts: state.posts,
    attachments: state.attachments,
    terms: state.terms,
    taxonomies: state.taxonomies,
    relationships: state.relationships,
    redirects: state.redirects,
    oldSlugCount: state.oldSlugCount,
    excludedRatingData: state.excludedRatingData
  };
}

interface PassTwoState {
  readonly wprm: Map<string, RawWprmMetaBuilder>;
  readonly attachments: Map<string, RawAttachmentMetaBuilder>;
  readonly wpurSignals: Map<string, Set<string>>;
  readonly wpurSignalPosts: Set<string>;
  postMetaRows: number;
  oldSlugRecords: number;
  referenceCount: number;
  excludedRatingData: number;
}

interface RawWprmMetaBuilder {
  readonly values: Map<string, string>;
  readonly duplicateKeys: Set<string>;
  readonly unsupportedKeys: Set<string>;
  wprmType: RawWprmMeta["wprmType"];
  readonly oldSlugs: string[];
  excludedRatingData: number;
  excludedOperationalData: number;
  excludedAuthorData: number;
  excludedSocialMediaData: number;
  excludedVideoData: number;
  excludedWprmType: number;
  pinImageFieldsWithoutReference: number;
  resolvedPinImageReferences: number;
  unresolvedPinImageReferences: number;
}

interface RawAttachmentMetaBuilder {
  attachedFile: string | null;
  alt: string | null;
  dimensions: string | null;
  readonly seenKeys: Set<string>;
  readonly duplicateKeys: Set<string>;
}

function createWprmBuilder(): RawWprmMetaBuilder {
  return {
    values: new Map(),
    duplicateKeys: new Set(),
    unsupportedKeys: new Set(),
    wprmType: wprmTypeProvenance(undefined),
    oldSlugs: [],
    excludedRatingData: 0,
    excludedOperationalData: 0,
    excludedAuthorData: 0,
    excludedSocialMediaData: 0,
    excludedVideoData: 0,
    excludedWprmType: 0,
    pinImageFieldsWithoutReference: 0,
    resolvedPinImageReferences: 0,
    unresolvedPinImageReferences: 0
  };
}

function createAttachmentBuilder(): RawAttachmentMetaBuilder {
  return {
    attachedFile: null,
    alt: null,
    dimensions: null,
    seenKeys: new Set(),
    duplicateKeys: new Set()
  };
}

function looksLikeRatingOrComment(key: string) {
  return /(?:rating|comment)/iu.test(key);
}

function isWprmUnsupportedKey(key: string) {
  return key.startsWith("wprm_")
    && !wprmMetaKeys.has(key)
    && !wprmExcludedMetaKeys.has(key)
    && !wprmOperationalMetaKeys.has(key);
}

function isWpurSignalKey(key: string) {
  return wpurSignalKeys.has(key)
    || wpurSignalPrefixes.some((prefix) => key.startsWith(prefix));
}

function numericReferenceValue(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim()) && value.trim() !== "0") {
    return value.trim();
  }
  return null;
}

function classifyExcludedWprmMetadata(
  builder: RawWprmMetaBuilder,
  key: string,
  value: string,
  rawValue: string | null,
  graph: WprmSourceGraph
) {
  const trimmed = value.trim();
  if (key === "wprm_type") {
    if (builder.wprmType.present) {
      builder.duplicateKeys.add(key);
    } else {
      builder.wprmType = wprmTypeProvenance(rawValue);
    }
    if (trimmed.length > 0) {
      builder.excludedWprmType += 1;
    }
    return;
  }
  if (trimmed.length === 0) {
    return;
  }
  if (key === "wprm_author_name") {
    builder.excludedAuthorData += 1;
    return;
  }
  if (key === "wprm_pin_image_id") {
    builder.excludedSocialMediaData += 1;
    if (trimmed === "0") {
      builder.pinImageFieldsWithoutReference += 1;
      return;
    }
    const attachmentId = numericReferenceValue(trimmed);
    if (attachmentId !== null && graph.attachments.has(attachmentId)) {
      builder.resolvedPinImageReferences += 1;
    } else {
      builder.unresolvedPinImageReferences += 1;
    }
    return;
  }
  if (key === "wprm_pin_image_repin_id") {
    builder.excludedSocialMediaData += 1;
    return;
  }
  if (key === "wprm_video_id") {
    builder.excludedVideoData += 1;
    return;
  }
}

function countStructuredImageReferences(
  value: string,
  limits: WprmImportLimits
) {
  const parsed = parseStructuredValue(value, limits.evidence);
  if (parsed === null) {
    return 0;
  }
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: parsed.value, depth: 1 }
  ];
  let count = 0;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current.value === null || typeof current.value !== "object") {
      continue;
    }
    if (current.depth > limits.evidence.maxSerializedDepth) {
      return count;
    }
    const children = Array.isArray(current.value)
      ? current.value.map((nested) => ["", nested] as const)
      : Object.entries(current.value);
    entries += children.length;
    if (entries > limits.evidence.maxSerializedEntries) {
      return count;
    }
    for (const [key, nested] of children) {
      if ((key === "image" || key === "image_id") && numericReferenceValue(nested) !== null) {
        count += 1;
      }
      if (nested !== null && typeof nested === "object") {
        pending.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }
  return count;
}

function rememberSingular(
  values: Map<string, string>,
  duplicates: Set<string>,
  key: string,
  value: string
) {
  if (values.has(key)) {
    duplicates.add(key);
  }
  values.set(key, value);
}

function metadataHandlers(
  state: PassTwoState,
  graph: WprmSourceGraph,
  tableColumns: ReadonlyMap<string, ReadonlySet<string>>,
  postMetaTable: string,
  limits: WprmImportLimits
) {
  return {
    getTableColumns(table: string) {
      return [...(tableColumns.get(table.toLowerCase()) ?? [])];
    },
    onInsert(insert: SqlInsert) {
      if (insert.table.toLowerCase() !== postMetaTable) {
        const table = insert.table.toLowerCase();
        if (isExcludedTable(table)) {
          state.excludedRatingData += 1;
        }
        return;
      }
      state.postMetaRows += 1;
      if (state.postMetaRows > limits.evidence.maxPostMetaRows) {
        throw new SourceEvidenceError("postmeta-row-limit");
      }
      const postId = numericId(rowValue(insert.row, "post_id"));
      const keyValue = rowValue(insert.row, "meta_key");
      if (postId === null || keyValue === null || keyValue === undefined) {
        throw new SourceEvidenceError("malformed-postmeta");
      }
      const key = keyValue.toLowerCase();
      const rawValue = rowValue(insert.row, "meta_value");
      const value = rawValue ?? "";
      if (Buffer.byteLength(value, "utf8") > limits.evidence.maxMetaValueBytes) {
        throw new SourceEvidenceError("meta-value-limit");
      }
      if (looksLikeRatingOrComment(key)) {
        state.excludedRatingData += 1;
      }

      const post = graph.posts.get(postId);
      const addReferences = (count: number) => {
        state.referenceCount += count;
        if (state.referenceCount > limits.evidence.maxEvidenceReferences) {
          throw new SourceEvidenceError("evidence-reference-limit");
        }
      };
      if (
        key === "wprm_instructions"
        && post?.type.toLowerCase() === "wprm_recipe"
      ) {
        addReferences(countStructuredImageReferences(value, limits));
      }
      if (
        key === "_thumbnail_id"
        && post?.type.toLowerCase() === "wprm_recipe"
        && numericReferenceValue(value) !== null
      ) {
        addReferences(1);
      }
      if (post?.type.toLowerCase() === "wprm_recipe") {
        const builder = state.wprm.get(postId) ?? createWprmBuilder();
        if (looksLikeRatingOrComment(key)) {
          builder.excludedRatingData += 1;
        } else if (wprmOperationalMetaKeys.has(key)) {
          builder.excludedOperationalData += 1;
        } else if (wprmExcludedMetaKeys.has(key)) {
          classifyExcludedWprmMetadata(builder, key, value, rawValue ?? null, graph);
        } else if (wprmMetaKeys.has(key)) {
          rememberSingular(builder.values, builder.duplicateKeys, key, value);
        } else if (isWprmUnsupportedKey(key) && value.trim().length > 0) {
          builder.unsupportedKeys.add(key);
        }
        state.wprm.set(postId, builder);
      }

      if (isWpurSignalKey(key)) {
        const keys = state.wpurSignals.get(postId) ?? new Set<string>();
        keys.add(key);
        state.wpurSignals.set(postId, keys);
        if (wpurSignalPrefixes.some((prefix) => key.startsWith(prefix))) {
          state.wpurSignalPosts.add(postId);
        }
      }

      if (post?.type.toLowerCase() === "attachment") {
        const builder = state.attachments.get(postId) ?? createAttachmentBuilder();
        if (attachmentMetaKeys.has(key)) {
          if (builder.seenKeys.has(key)) {
            builder.duplicateKeys.add(key);
          }
          builder.seenKeys.add(key);
          if (key === "_wp_attached_file") {
            builder.attachedFile = value;
          } else if (key === "_wp_attachment_image_alt") {
            builder.alt = rawValue ?? null;
          } else {
            builder.dimensions = rawValue ?? null;
          }
        }
        state.attachments.set(postId, builder);
      }

      if (
        key === "_wp_old_slug"
        && post !== undefined
        && ["wprm_recipe", "post", "page"].includes(post.type.toLowerCase())
      ) {
        state.oldSlugRecords += 1;
        if (state.oldSlugRecords > limits.maxOldSlugRecords) {
          throw new SourceEvidenceError("old-slug-record-limit");
        }
        const builder = state.wprm.get(postId) ?? createWprmBuilder();
        builder.oldSlugs.push(value);
        state.wprm.set(postId, builder);
      }
    }
  };
}

function freezeWprmBuilder(builder: RawWprmMetaBuilder): RawWprmMeta {
  return {
    values: builder.values,
    duplicateKeys: builder.duplicateKeys,
    unsupportedKeys: builder.unsupportedKeys,
    wprmType: builder.wprmType,
    excludedRatingData: builder.excludedRatingData,
    excludedOperationalData: builder.excludedOperationalData,
    excludedAuthorData: builder.excludedAuthorData,
    excludedSocialMediaData: builder.excludedSocialMediaData,
    excludedVideoData: builder.excludedVideoData,
    excludedWprmType: builder.excludedWprmType,
    pinImageFieldsWithoutReference: builder.pinImageFieldsWithoutReference,
    resolvedPinImageReferences: builder.resolvedPinImageReferences,
    unresolvedPinImageReferences: builder.unresolvedPinImageReferences,
    oldSlugs: builder.oldSlugs
  };
}

function freezeAttachmentBuilder(builder: RawAttachmentMetaBuilder): RawAttachmentMeta {
  return {
    attachedFile: builder.attachedFile,
    alt: builder.alt,
    dimensions: builder.dimensions,
    duplicateKeys: builder.duplicateKeys
  };
}

function freezeMetadata(
  state: PassTwoState,
  sql: Awaited<ReturnType<typeof scanSqlDump>>
): WprmSourceMetadata {
  return {
    wprm: new Map(
      [...state.wprm.entries()].map(([id, value]) => [id, freezeWprmBuilder(value)])
    ),
    attachments: new Map(
      [...state.attachments.entries()].map(([id, value]) => [id, freezeAttachmentBuilder(value)])
    ),
    wpurSignals: state.wpurSignals,
    wpurSignalPosts: state.wpurSignalPosts,
    sql
  };
}

async function regularDirectoryFiles(directory: string) {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WprmImportError("invalid-uploads-dir");
  }
  const entries = await readdir(directory, {
    withFileTypes: true
  });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new WprmImportError("invalid-upload-archive");
    }
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".zip") {
      paths.push(path.join(directory, entry.name));
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export async function resolveWprmUploadArchives(
  uploadsDir: string | undefined,
  uploadArchives: readonly string[] | undefined
) {
  if (uploadArchives !== undefined) {
    return [...uploadArchives].sort((left, right) =>
      path.resolve(left).localeCompare(path.resolve(right))
    );
  }
  if (uploadsDir === undefined) {
    return [];
  }
  return regularDirectoryFiles(path.resolve(uploadsDir));
}

export async function extractWprmSource(
  input: Pick<WprmImportSourceOptions, "database" | "uploadsDir" | "uploadArchives" | "limits">
): Promise<WprmSourceSnapshot> {
  const limits = mergeWprmImportLimits(input.limits);
  const database = path.resolve(input.database);
  const passOne = createPassOneState();
  let firstSql: Awaited<ReturnType<typeof scanSqlDump>>;
  try {
    firstSql = await scanSqlDump(
      database,
      graphHandlers(passOne, limits),
      limits.evidence.sql
    );
  } catch (error) {
    throw sourceError(error);
  }
  selectTable(passOne.postTables, "posts", "missing-core-table");
  const postMetaTable = selectTable(passOne.postMetaTables, "postmeta", "missing-postmeta-table");
  selectOptionsTable(passOne);
  let sourceOptions: WprmWordPressOptions;
  try {
    sourceOptions = parseWordPressSourceOptions(passOne.options, limits);
  } catch (error) {
    if (error instanceof WprmSourceOptionsError) {
      throw new WprmImportError(error.code);
    }
    throw new WprmImportError("invalid-wordpress-options");
  }
  if (passOne.relationshipCount > limits.evidence.maxTermRelationships) {
    throw new WprmImportError("term-relationship-limit");
  }

  const archives = await resolveWprmUploadArchives(input.uploadsDir, input.uploadArchives);
  let uploads: UploadArchiveInventory;
  try {
    uploads = await inventoryUploadArchives(archives, limits.evidence.uploads);
  } catch (error) {
    throw sourceError(error, "upload-probe-failed");
  }

  const passTwo: PassTwoState = {
    wprm: new Map(),
    attachments: new Map(),
    wpurSignals: new Map(),
    wpurSignalPosts: new Set(),
    postMetaRows: 0,
    oldSlugRecords: 0,
    referenceCount: 0,
    excludedRatingData: 0
  };
  let secondSql: Awaited<ReturnType<typeof scanSqlDump>>;
  try {
    secondSql = await scanSqlDump(
      database,
      metadataHandlers(
        passTwo,
        makeGraph(passOne),
        passOne.tableColumns,
        postMetaTable,
        limits
      ),
      limits.evidence.sql
    );
  } catch (error) {
    throw sourceError(error);
  }
  if (
    firstSql.decompressedBytes !== secondSql.decompressedBytes
    || firstSql.sqlDecompressedSha256 !== secondSql.sqlDecompressedSha256
  ) {
    throw new WprmImportError("source-changed-during-import");
  }
  const metadata = freezeMetadata(passTwo, secondSql);
  const graph: WprmSourceGraph = {
    ...makeGraph(passOne),
    oldSlugCount: passTwo.oldSlugRecords,
    excludedRatingData: passOne.excludedRatingData + passTwo.excludedRatingData
  };
  const wprmCount = [...graph.posts.values()]
    .filter((post) => post.type.toLowerCase() === "wprm_recipe")
    .length;
  const wpurCount = [...metadata.wpurSignals.entries()]
    .filter(([postId, keys]) =>
      graph.posts.get(postId)?.type.toLowerCase() === "recipe"
      && keys.has("recipe_ingredients")
      && keys.has("recipe_instructions")
    )
    .length;
  if (wprmCount + wpurCount > limits.evidence.maxRecipeCandidates) {
    throw new WprmImportError("recipe-candidate-limit");
  }
  return {
    graph,
    metadata,
    options: sourceOptions,
    sql: firstSql,
    uploads
  };
}

export interface WprmImportSourceOptions {
  readonly database: string;
  readonly uploadsDir?: string;
  readonly uploadArchives?: readonly string[];
  readonly limits?: WprmImportLimitsInput;
}

export {
  attachmentMetaKeys,
  defaultWprmImportLimits,
  isWpurSignalKey,
  wprmOperationalMetaKeys,
  wprmMetaKeys
};

export const extractWprmSourceTwoPass = extractWprmSource;
export const scanWprmImportSource = extractWprmSource;
