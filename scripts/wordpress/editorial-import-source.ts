import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { SqlInsert, SqlValue } from "./sql-stream";
import { scanSqlDump } from "./sql-stream";
import { countEditorialContentReferences } from "./editorial-import-map";
import {
  numericId,
  rowValue,
  tableEndsWith,
  tableHasColumns
} from "./source-evidence-scan";
import { SourceEvidenceError } from "./source-evidence-contracts";
import { inventoryUploadArchives } from "./uploads-inventory";
import {
  parseWordPressSourceOptions,
  WprmSourceOptionsError
} from "./wprm-import-options";
import { parsePhpSerialized } from "./php-serialize";
import { parseStructuredValue } from "./source-evidence-structured";
import {
  EditorialImportError,
  mergeEditorialImportLimits,
  type EditorialImportLimits,
  type EditorialImportLimitsInput,
  type EditorialSourceSnapshot,
  type RawBwgGallery,
  type RawBwgImage,
  type RawEditorialAttachment,
  type RawEditorialAttachmentMeta,
  type RawEditorialPage,
  type RawEditorialPostState,
  type RawWpTilesGridTemplate,
  type RawTerm,
  type RawTermTaxonomy
} from "./editorial-import-contracts";

type SourceRow = Readonly<Record<string, string | null>>;

interface PassOneState {
  readonly tableColumns: Map<string, Set<string>>;
  readonly postTables: Set<string>;
  readonly postMetaTables: Set<string>;
  readonly optionTables: Set<string>;
  readonly optionsByTable: Map<string, Map<string, string | null>>;
  readonly posts: Map<string, RawEditorialPostState>;
  readonly pages: Map<string, RawEditorialPage>;
  readonly attachments: Map<string, RawEditorialAttachment>;
  readonly terms: Map<string, RawTerm>;
  readonly taxonomies: Map<string, RawTermTaxonomy>;
  readonly relationships: Map<string, Set<string>>;
  readonly gridTemplates: Map<string, RawWpTilesGridTemplate>;
  readonly galleries: Map<string, RawBwgGallery>;
  readonly galleryImages: RawBwgImage[];
  readonly galleryImageIds: Set<string>;
  pageCount: number;
  evidenceReferenceCount: number;
  relationshipCount: number;
  galleryImageCount: number;
}

interface PassTwoState {
  readonly attachedFiles: Map<string, string | null>;
  readonly attachmentAlts: Map<string, string | null>;
  readonly attachmentSeenKeys: Map<string, Set<string>>;
  readonly attachmentDuplicateKeys: Map<string, Set<string>>;
  readonly attachmentDimensions: Map<string, {
    readonly width: number | null;
    readonly height: number | null;
  }>;
  readonly featuredValues: Map<string, string[]>;
  readonly featuredMalformed: Set<string>;
  evidenceReferenceCount: number;
  featuredReferenceCount: number;
  postMetaRows: number;
}

function positiveDimension(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function attachmentDimensions(value: string, limits: EditorialImportLimits) {
  const parsed = parseStructuredValue(value, limits.evidence);
  if (
    parsed === null
    || parsed.value === null
    || typeof parsed.value !== "object"
    || Array.isArray(parsed.value)
  ) {
    return { width: null, height: null };
  }
  return {
    width: positiveDimension(parsed.value.width),
    height: positiveDimension(parsed.value.height)
  };
}

function sourceError(error: unknown, fallback = "source-error"): EditorialImportError {
  if (error instanceof EditorialImportError) {
    return error;
  }
  if (
    error instanceof SourceEvidenceError
    || (error !== null
      && typeof error === "object"
      && "code" in error
      && typeof error.code === "string")
  ) {
    const code = error instanceof SourceEvidenceError
      ? error.code
      : String(error.code);
    return new EditorialImportError(code);
  }
  return new EditorialImportError(fallback);
}

function scanError(code: string) {
  return new SourceEvidenceError(code);
}

function rawRow(row: Readonly<Record<string, SqlValue>>): SourceRow {
  return Object.fromEntries(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right))
  );
}

function textOrNull(value: SqlValue | undefined) {
  return value === undefined || value === null || value.length === 0 ? null : value;
}

function exactTextOrNull(value: SqlValue | undefined) {
  return value === undefined || value === null ? null : value;
}

function numericOrNull(value: SqlValue | undefined) {
  return value === undefined || value === null || value.trim().length === 0
    ? null
    : numericId(value.trim());
}

function wordpressParentId(value: SqlValue | undefined) {
  if (value === undefined || value === null || value.trim().length === 0) {
    return { id: null, malformed: false };
  }
  const normalized = value.trim();
  if (normalized === "0") {
    return { id: null, malformed: false };
  }
  const id = numericId(normalized);
  return id === null
    ? { id: null, malformed: true }
    : { id, malformed: false };
}

function wordpressMenuOrder(value: SqlValue | undefined) {
  if (value === undefined || value === null || value.trim().length === 0) {
    return { value: null, malformed: false };
  }
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    return { value: null, malformed: true };
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    return { value: null, malformed: true };
  }
  return { value: parsed, malformed: false };
}

function bwgGalleryId(value: SqlValue | undefined) {
  if (value === undefined || value === null || value.trim().length === 0) {
    return { id: null, state: "missing" as const };
  }
  const id = numericId(value.trim());
  return id === null
    ? { id: null, state: "malformed" as const }
    : { id, state: "present" as const };
}

function assertSourceRowLimits(
  row: Readonly<Record<string, SqlValue>>,
  limits: EditorialImportLimits
) {
  for (const [column, value] of Object.entries(row)) {
    if (value === null) {
      continue;
    }
    const limit = column === "post_content"
      ? limits.evidence.maxPostContentBytes
      : limits.evidence.maxMetaValueBytes;
    if (Buffer.byteLength(value, "utf8") > limit) {
      throw scanError(
        column === "post_content" ? "post-content-scan-limit" : "source-value-limit"
      );
    }
  }
}

function rememberColumns(
  state: PassOneState,
  table: string,
  columns: readonly string[]
) {
  const key = table.toLowerCase();
  const existing = state.tableColumns.get(key);
  if (existing === undefined) {
    state.tableColumns.set(key, new Set(columns));
  }
  return state.tableColumns.get(key) ?? new Set(columns);
}

function createPassOneState(): PassOneState {
  return {
    tableColumns: new Map(),
    postTables: new Set(),
    postMetaTables: new Set(),
    optionTables: new Set(),
    optionsByTable: new Map(),
    posts: new Map(),
    pages: new Map(),
    attachments: new Map(),
    terms: new Map(),
    taxonomies: new Map(),
    relationships: new Map(),
    gridTemplates: new Map(),
    galleries: new Map(),
    galleryImages: [],
    galleryImageIds: new Set(),
    pageCount: 0,
    evidenceReferenceCount: 0,
    relationshipCount: 0,
    galleryImageCount: 0
  };
}

function addEvidenceReferences(
  state: Pick<PassOneState | PassTwoState, "evidenceReferenceCount">,
  count: number,
  limits: EditorialImportLimits
) {
  if (count <= 0) {
    return;
  }
  state.evidenceReferenceCount += count;
  if (state.evidenceReferenceCount > limits.evidence.maxEvidenceReferences) {
    throw scanError("evidence-reference-limit");
  }
}

function processPost(
  state: PassOneState,
  insert: SqlInsert,
  limits: EditorialImportLimits
) {
  const id = numericId(rowValue(insert.row, "ID"));
  const typeValue = rowValue(insert.row, "post_type");
  if (id === null || typeValue === null || typeValue === undefined) {
    throw scanError("malformed-post");
  }
  const type = typeValue.trim().toLowerCase();
  if (state.posts.has(id)) {
    throw scanError("duplicate-post-id");
  }
  if (state.posts.size >= limits.evidence.maxPosts) {
    throw scanError("post-limit");
  }
  assertSourceRowLimits(insert.row, limits);
  const content = textOrNull(rowValue(insert.row, "post_content"));
  const status = rowValue(insert.row, "post_status")?.trim().toLowerCase() ?? "";
  const hasPassword = (rowValue(insert.row, "post_password") ?? "").length > 0;
  const parent = wordpressParentId(rowValue(insert.row, "post_parent"));
  const menuOrder = wordpressMenuOrder(rowValue(insert.row, "menu_order"));
  if (type === "page") {
    addEvidenceReferences(
      state,
      countEditorialContentReferences(content),
      limits
    );
  }
  state.posts.set(id, {
    id,
    type,
    status,
    hasPassword,
    parentId: parent.id,
    parentIdMalformed: parent.malformed,
    menuOrder: menuOrder.value,
    menuOrderMalformed: menuOrder.malformed,
    createdGmt: textOrNull(rowValue(insert.row, "post_date_gmt"))
  });
  if (type === "grid_template") {
    if (state.gridTemplates.has(id)) {
      throw scanError("malformed-wp-tiles-grid");
    }
    state.gridTemplates.set(id, {
      id,
      status,
      hasPassword,
      title: textOrNull(rowValue(insert.row, "post_title")),
      content,
      menuOrder: menuOrder.value,
      menuOrderMalformed: menuOrder.malformed
    });
    return;
  }
  if (type !== "page" && type !== "attachment") {
    return;
  }
  const source = rawRow(insert.row);
  if (type === "page") {
    if (
      content !== null
      && Buffer.byteLength(content, "utf8") > limits.evidence.maxPostContentBytes
    ) {
      throw scanError("post-content-scan-limit");
    }
    state.pages.set(id, {
      id,
      status,
      hasPassword,
      parentId: parent.id,
      parentIdMalformed: parent.malformed,
      authorId: numericOrNull(rowValue(insert.row, "post_author")),
      slug: textOrNull(rowValue(insert.row, "post_name")),
      title: textOrNull(rowValue(insert.row, "post_title")),
      content,
      excerpt: textOrNull(rowValue(insert.row, "post_excerpt")),
      createdLocal: textOrNull(rowValue(insert.row, "post_date")),
      createdGmt: textOrNull(rowValue(insert.row, "post_date_gmt")),
      modifiedLocal: textOrNull(rowValue(insert.row, "post_modified")),
      modifiedGmt: textOrNull(rowValue(insert.row, "post_modified_gmt")),
      guid: textOrNull(rowValue(insert.row, "guid")),
      source
    });
    state.pageCount += 1;
    if (state.pageCount > limits.maxPageCandidates) {
      throw scanError("page-candidate-limit");
    }
    return;
  }
  state.attachments.set(id, {
    id,
    status,
    hasPassword,
    parentId: parent.id,
    parentIdMalformed: parent.malformed,
    mimeType: textOrNull(rowValue(insert.row, "post_mime_type")),
    guid: textOrNull(rowValue(insert.row, "guid")),
    source
  });
}

function processTerms(
  state: PassOneState,
  insert: SqlInsert,
  limits: EditorialImportLimits
) {
  assertSourceRowLimits(insert.row, limits);
  const table = insert.table.toLowerCase();
  if (tableEndsWith(table, "terms")) {
    const id = numericId(rowValue(insert.row, "term_id"));
    if (id === null || state.terms.has(id)) {
      throw scanError("malformed-term");
    }
    state.terms.set(id, {
      id,
      name: exactTextOrNull(rowValue(insert.row, "name")),
      slug: textOrNull(rowValue(insert.row, "slug"))
    });
    return;
  }
  if (tableEndsWith(table, "term_taxonomy")) {
    const id = numericId(rowValue(insert.row, "term_taxonomy_id"));
    const termId = numericId(rowValue(insert.row, "term_id"));
    const taxonomy = rowValue(insert.row, "taxonomy");
    if (id === null || termId === null || taxonomy === null || taxonomy === undefined) {
      throw scanError("malformed-term-taxonomy");
    }
    if (state.taxonomies.has(id)) {
      throw scanError("duplicate-term-taxonomy");
    }
    const parent = wordpressParentId(rowValue(insert.row, "parent"));
    state.taxonomies.set(id, {
      id,
      termId,
      taxonomy: taxonomy.trim().toLowerCase(),
      parentTermId: parent.id,
      parentTermIdMalformed: parent.malformed
    });
    return;
  }
  if (tableEndsWith(table, "term_relationships")) {
    const objectId = numericId(rowValue(insert.row, "object_id"));
    const taxonomyId = numericId(rowValue(insert.row, "term_taxonomy_id"));
    if (objectId === null || taxonomyId === null) {
      throw scanError("malformed-term-relationship");
    }
    state.relationshipCount += 1;
    if (state.relationshipCount > limits.evidence.maxTermRelationships) {
      throw scanError("term-relationship-limit");
    }
    const members = state.relationships.get(taxonomyId) ?? new Set<string>();
    members.add(objectId);
    state.relationships.set(taxonomyId, members);
  }
}

function processOption(
  state: PassOneState,
  insert: SqlInsert,
  limits: EditorialImportLimits
) {
  const table = insert.table.toLowerCase();
  const optionName = rowValue(insert.row, "option_name");
  if (optionName === null || optionName === undefined) {
    throw scanError("malformed-option");
  }
  if (
    optionName !== "home"
    && optionName !== "permalink_structure"
    && optionName !== "page_for_posts"
    && optionName !== "polylang"
    && optionName !== "wp_tiles"
  ) {
    return;
  }
  const optionValue = rowValue(insert.row, "option_value") ?? null;
  if (
    optionValue !== null
    && Buffer.byteLength(optionValue, "utf8") > limits.evidence.maxMetaValueBytes
  ) {
    throw scanError("option-value-limit");
  }
  const options = state.optionsByTable.get(table) ?? new Map<string, string | null>();
  if (options.has(optionName)) {
    throw scanError("duplicate-option");
  }
  options.set(optionName, optionValue);
  state.optionsByTable.set(table, options);
}

const maxWpTilesOptionValueBytes = 4_096;

type WpTilesSourceOptions = {
  readonly defaultGrid: string | null;
  readonly pagination: "ajax" | null;
};

function wpTilesSourceOptions(
  value: string | null | undefined,
  limits: EditorialImportLimits
): WpTilesSourceOptions {
  if (value === undefined) {
    return { defaultGrid: null, pagination: null };
  }
  if (value === null) {
    throw new EditorialImportError("invalid-wp-tiles-option");
  }
  let parsed: ReturnType<typeof parsePhpSerialized>;
  try {
    parsed = parsePhpSerialized(value, {
      maxInputBytes: limits.evidence.maxMetaValueBytes,
      maxDepth: limits.evidence.maxSerializedDepth,
      maxEntries: limits.evidence.maxSerializedEntries,
      maxStringBytes: limits.evidence.maxMetaValueBytes,
      rejectDuplicateKeys: true
    });
  } catch {
    throw new EditorialImportError("invalid-wp-tiles-option");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EditorialImportError("invalid-wp-tiles-option");
  }
  const defaultGrid = parsed.default_grid;
  let normalizedDefaultGrid: string | null;
  if (defaultGrid === undefined || defaultGrid === null || defaultGrid === false) {
    normalizedDefaultGrid = null;
  } else if (
    typeof defaultGrid !== "string"
    || defaultGrid.length === 0
    || Buffer.byteLength(defaultGrid, "utf8") > maxWpTilesOptionValueBytes
    || /[\u0000-\u001f\u007f]/u.test(defaultGrid)
  ) {
    throw new EditorialImportError("invalid-wp-tiles-option");
  } else {
    normalizedDefaultGrid = defaultGrid;
  }
  const pagination = parsed.pagination;
  if (pagination === undefined) {
    return { defaultGrid: normalizedDefaultGrid, pagination: null };
  }
  if (
    typeof pagination !== "string"
    || pagination.length === 0
    || Buffer.byteLength(pagination, "utf8") > maxWpTilesOptionValueBytes
    || /[\u0000-\u001f\u007f]/u.test(pagination)
  ) {
    throw new EditorialImportError("invalid-wp-tiles-pagination-option");
  }
  if (pagination !== "ajax") {
    throw new EditorialImportError("unsupported-wp-tiles-pagination-option");
  }
  return { defaultGrid: normalizedDefaultGrid, pagination };
}

function pageForPosts(value: string | null | undefined) {
  if (value === undefined) {
    return null;
  }
  if (
    value === null
    || !/^(?:0|[1-9]\d*)$/u.test(value)
  ) {
    throw new EditorialImportError("invalid-page-for-posts-option");
  }
  return value === "0" ? null : value;
}

function processGallery(
  state: PassOneState,
  insert: SqlInsert,
  limits: EditorialImportLimits
) {
  assertSourceRowLimits(insert.row, limits);
  const table = insert.table.toLowerCase();
  if (table.endsWith("bwg_gallery")) {
    const id = numericId(rowValue(insert.row, "id"));
    if (id === null || state.galleries.has(id)) {
      throw scanError("malformed-bwg-gallery");
    }
    state.galleries.set(id, { id, source: rawRow(insert.row) });
    return;
  }
  if (!table.endsWith("bwg_image")) {
    return;
  }
  const id = numericId(rowValue(insert.row, "id"));
  if (id === null || state.galleryImageIds.has(id)) {
    throw scanError("malformed-bwg-image");
  }
  state.galleryImageIds.add(id);
  state.galleryImageCount += 1;
  if (state.galleryImageCount > limits.maxBwgImageRecords) {
    throw scanError("bwg-image-limit");
  }
  const imageUrl = textOrNull(rowValue(insert.row, "image_url"));
  const thumbUrl = textOrNull(rowValue(insert.row, "thumb_url"));
  const order = wordpressMenuOrder(rowValue(insert.row, "order"));
  addEvidenceReferences(
    state,
    (imageUrl === null ? 0 : 1) + (thumbUrl === null ? 0 : 1),
    limits
  );
  const gallery = bwgGalleryId(rowValue(insert.row, "gallery_id"));
  state.galleryImages.push({
    id,
    galleryId: gallery.id,
    galleryIdState: gallery.state,
    imageUrl,
    thumbUrl,
    resolution: textOrNull(rowValue(insert.row, "resolution")),
    alt: textOrNull(rowValue(insert.row, "alt")),
    description: textOrNull(rowValue(insert.row, "description")),
    order: order.value,
    orderMalformed: order.malformed,
    source: rawRow(insert.row)
  });
}

function passOneHandlers(state: PassOneState, limits: EditorialImportLimits) {
  return {
    onCreateTable(table: { readonly table: string; readonly columns: readonly string[] }) {
      const columns = rememberColumns(state, table.table, table.columns);
      const normalized = table.table.toLowerCase();
      if (
        tableEndsWith(normalized, "posts")
        && tableHasColumns(columns, ["ID", "post_type"])
      ) {
        state.postTables.add(normalized);
      }
      if (
        tableEndsWith(normalized, "postmeta")
        && tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
      ) {
        state.postMetaTables.add(normalized);
      }
      if (
        tableEndsWith(normalized, "options")
        && tableHasColumns(columns, ["option_name", "option_value"])
      ) {
        state.optionTables.add(normalized);
      }
    },
    getTableColumns(table: string) {
      return [...(state.tableColumns.get(table.toLowerCase()) ?? [])];
    },
    onInsert(insert: SqlInsert) {
      const columns = rememberColumns(state, insert.table, insert.columns);
      const table = insert.table.toLowerCase();
      if (
        tableEndsWith(table, "posts")
        && tableHasColumns(columns, ["ID", "post_type"])
      ) {
        state.postTables.add(table);
        processPost(state, insert, limits);
      } else if (
        tableEndsWith(table, "postmeta")
        && tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
      ) {
        state.postMetaTables.add(table);
      } else if (
        tableEndsWith(table, "options")
        && tableHasColumns(columns, ["option_name", "option_value"])
      ) {
        state.optionTables.add(table);
        processOption(state, insert, limits);
      } else if (
        tableEndsWith(table, "terms")
        || tableEndsWith(table, "term_taxonomy")
        || tableEndsWith(table, "term_relationships")
      ) {
        processTerms(state, insert, limits);
      } else if (table.endsWith("bwg_gallery") || table.endsWith("bwg_image")) {
        processGallery(state, insert, limits);
      }
    }
  };
}

function selectTable(tables: ReadonlySet<string>, suffix: string, code: string) {
  const candidates = [...tables].filter((table) => table.endsWith(suffix));
  if (candidates.length !== 1) {
    throw new EditorialImportError(code);
  }
  return candidates[0]!;
}

function metadataHandlers(
  state: PassTwoState,
  pages: ReadonlyMap<string, RawEditorialPage>,
  attachments: ReadonlyMap<string, RawEditorialAttachment>,
  tableColumns: ReadonlyMap<string, ReadonlySet<string>>,
  postMetaTable: string,
  limits: EditorialImportLimits
) {
  return {
    getTableColumns(table: string) {
      return [...(tableColumns.get(table.toLowerCase()) ?? [])];
    },
    onInsert(insert: SqlInsert) {
      if (insert.table.toLowerCase() !== postMetaTable) {
        return;
      }
      state.postMetaRows += 1;
      if (state.postMetaRows > limits.evidence.maxPostMetaRows) {
        throw scanError("postmeta-row-limit");
      }
      const postId = numericId(rowValue(insert.row, "post_id"));
      const keyValue = rowValue(insert.row, "meta_key");
      if (postId === null || keyValue === null || keyValue === undefined) {
        throw scanError("malformed-postmeta");
      }
      const key = keyValue.toLowerCase();
      const value = rowValue(insert.row, "meta_value") ?? "";
      if (Buffer.byteLength(value, "utf8") > limits.evidence.maxMetaValueBytes) {
        throw scanError("meta-value-limit");
      }
      if (pages.has(postId) && key === "_thumbnail_id") {
        addEvidenceReferences(state, 1, limits);
        state.featuredReferenceCount += 1;
        const values = state.featuredValues.get(postId) ?? [];
        values.push(value);
        state.featuredValues.set(postId, values);
        if (numericId(value.trim()) === null) {
          state.featuredMalformed.add(postId);
        }
      }
      if (!attachments.has(postId)) {
        return;
      }
      if (
        key !== "_wp_attached_file"
        && key !== "_wp_attachment_image_alt"
        && key !== "_wp_attachment_metadata"
      ) {
        return;
      }
      const seen = state.attachmentSeenKeys.get(postId) ?? new Set<string>();
      const duplicates = state.attachmentDuplicateKeys.get(postId) ?? new Set<string>();
      if (seen.has(key)) {
        duplicates.add(key);
      }
      seen.add(key);
      state.attachmentSeenKeys.set(postId, seen);
      state.attachmentDuplicateKeys.set(postId, duplicates);
      if (key === "_wp_attached_file") {
        state.attachedFiles.set(postId, value.length === 0 ? null : value);
      } else if (key === "_wp_attachment_image_alt") {
        state.attachmentAlts.set(postId, rowValue(insert.row, "meta_value") ?? null);
      } else {
        state.attachmentDimensions.set(postId, attachmentDimensions(value, limits));
      }
    }
  };
}

async function regularDirectoryFiles(directory: string) {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new EditorialImportError("invalid-uploads-dir");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new EditorialImportError("invalid-upload-archive");
    }
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".zip") {
      paths.push(path.join(directory, entry.name));
    }
  }
  return paths.sort((left, right) => path.resolve(left).localeCompare(path.resolve(right)));
}

export async function resolveEditorialUploadArchives(
  uploadsDir: string | undefined,
  uploadArchives: readonly string[] | undefined
) {
  if (uploadArchives !== undefined) {
    return [...uploadArchives].sort((left, right) =>
      path.resolve(left).localeCompare(path.resolve(right))
    );
  }
  return uploadsDir === undefined ? [] : regularDirectoryFiles(path.resolve(uploadsDir));
}

export async function extractEditorialSource(input: {
  readonly database: string;
  readonly uploadsDir?: string;
  readonly uploadArchives?: readonly string[];
  readonly limits?: EditorialImportLimitsInput;
}): Promise<EditorialSourceSnapshot> {
  const limits = mergeEditorialImportLimits(input.limits);
  const database = path.resolve(input.database);
  const passOne = createPassOneState();
  let firstSql;
  try {
    firstSql = await scanSqlDump(database, passOneHandlers(passOne, limits), limits.evidence.sql);
  } catch (error) {
    throw sourceError(error);
  }
  const postTable = selectTable(passOne.postTables, "posts", "missing-core-table");
  const postMetaTable = selectTable(
    passOne.postMetaTables,
    "postmeta",
    "missing-postmeta-table"
  );
  const optionTable = selectTable(
    passOne.optionTables,
    "options",
    "missing-options-table"
  );
  let options: ReturnType<typeof parseWordPressSourceOptions>;
  try {
    options = parseWordPressSourceOptions(
      passOne.optionsByTable.get(optionTable) ?? new Map(),
      limits
    );
  } catch (error) {
    if (error instanceof WprmSourceOptionsError) {
      throw new EditorialImportError(error.code);
    }
    throw new EditorialImportError("invalid-wordpress-options");
  }
  let wpTiles: WpTilesSourceOptions;
  try {
    wpTiles = wpTilesSourceOptions(
      passOne.optionsByTable.get(optionTable)?.get("wp_tiles"),
      limits
    );
  } catch (error) {
    if (error instanceof EditorialImportError) {
      throw error;
    }
    throw new EditorialImportError("invalid-wp-tiles-option");
  }
  let postsPage: string | null;
  try {
    postsPage = pageForPosts(
      passOne.optionsByTable.get(optionTable)?.get("page_for_posts")
    );
  } catch (error) {
    if (error instanceof EditorialImportError) {
      throw error;
    }
    throw new EditorialImportError("invalid-page-for-posts-option");
  }
  if (postsPage !== null && !passOne.pages.has(postsPage)) {
    throw new EditorialImportError(
      passOne.posts.has(postsPage)
        ? "page-for-posts-not-page"
        : "unresolved-page-for-posts"
    );
  }
  if (postTable.slice(0, -"posts".length) !== postMetaTable.slice(0, -"postmeta".length)) {
    throw new EditorialImportError("unpaired-core-tables");
  }
  const archives = await resolveEditorialUploadArchives(
    input.uploadsDir,
    input.uploadArchives
  );
  let uploads;
  try {
    uploads = await inventoryUploadArchives(archives, limits.evidence.uploads);
  } catch (error) {
    throw sourceError(error, "upload-probe-failed");
  }
  const passTwo: PassTwoState = {
    attachedFiles: new Map(),
    attachmentAlts: new Map(),
    attachmentSeenKeys: new Map(),
    attachmentDuplicateKeys: new Map(),
    attachmentDimensions: new Map(),
    featuredValues: new Map(),
    featuredMalformed: new Set(),
    evidenceReferenceCount: passOne.evidenceReferenceCount,
    featuredReferenceCount: 0,
    postMetaRows: 0
  };
  let secondSql;
  try {
    secondSql = await scanSqlDump(
      database,
      metadataHandlers(
        passTwo,
        passOne.pages,
        passOne.attachments,
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
    throw new EditorialImportError("source-changed-during-import");
  }
  const attachmentMeta = new Map<string, RawEditorialAttachmentMeta>();
  for (const attachmentId of passOne.attachments.keys()) {
    const dimensions = passTwo.attachmentDimensions.get(attachmentId);
    attachmentMeta.set(attachmentId, {
      attachedFile: passTwo.attachedFiles.get(attachmentId) ?? null,
      alt: passTwo.attachmentAlts.get(attachmentId) ?? null,
      duplicateKeys: passTwo.attachmentDuplicateKeys.get(attachmentId) ?? new Set(),
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null
    });
  }
  const featuredMediaReferences = new Map<string, readonly (string | null)[]>();
  const featuredMediaDuplicates = new Set<string>();
  for (const pageId of passOne.pages.keys()) {
    const values = passTwo.featuredValues.get(pageId) ?? [];
    if (values.length > 1) {
      featuredMediaDuplicates.add(pageId);
    }
    featuredMediaReferences.set(
      pageId,
      values.map((value) => numericId(value.trim()))
    );
  }
  return {
    graph: {
      posts: passOne.posts,
      pages: passOne.pages,
      attachments: passOne.attachments,
      attachmentMeta,
      featuredMediaReferences,
      featuredReferenceCount: passTwo.featuredReferenceCount,
      featuredMediaDuplicates,
      featuredMediaMalformed: passTwo.featuredMalformed,
      terms: passOne.terms,
      taxonomies: passOne.taxonomies,
      relationships: passOne.relationships,
      gridTemplates: passOne.gridTemplates,
      galleries: passOne.galleries,
      galleryImages: [...passOne.galleryImages].sort((left, right) =>
        BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0
      )
    },
    sql: firstSql,
    uploads,
    options: {
      homeOrigin: options.homeOrigin,
      locales: options.locales,
      pageForPosts: postsPage,
      wpTilesDefaultGrid: wpTiles.defaultGrid,
      wpTilesPagination: wpTiles.pagination
    }
  };
}

export const extractWordPressEditorialSource = extractEditorialSource;
