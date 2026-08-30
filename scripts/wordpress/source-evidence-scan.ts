import { validateSafeLocalPath } from "../../src/content/url-path";
import {
  type BwgArchivePathCandidate,
  type CountLabel,
  type IdSet,
  type Locale,
  type MemberCount,
  type SourceEvidenceLimits,
  SourceEvidenceError
} from "./source-evidence-contracts";
import {
  collectTargetStrings,
  readJsonValue,
  withinStructuredLimits
} from "./source-evidence-structured";
import {
  PhpSerializationError,
  parsePhpSerialized
} from "./php-serialize";
import type { SqlInsert, SqlValue } from "./sql-stream";

export function issueCounter() {
  const values = new Map<string, { severity: "error" | "warning"; count: number }>();
  return {
    add(code: string, count = 1, severity: "error" | "warning" = "error") {
      if (count <= 0) {
        return;
      }
      const previous = values.get(code);
      values.set(code, {
        severity: previous?.severity ?? severity,
        count: (previous?.count ?? 0) + count
      });
    },
    values
  };
}

export type IssueCounter = ReturnType<typeof issueCounter>;

export function sortedIssues(issues: IssueCounter) {
  return [...issues.values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, value]) => ({
      code,
      severity: value.severity,
      count: value.count
    }));
}


export type PostKind = "wprm" | "recipe" | "attachment" | "page" | "post" | "other";

export interface PostRecord {
  readonly kind: PostKind;
  readonly parentId: string | null;
  readonly references: ReadonlySet<string>;
}

export interface PostTableState {
  readonly table: string;
  readonly columns: Set<string>;
  readonly records: Map<string, PostRecord>;
  total: number;
  pages: number;
}

interface TermRecord {
  readonly locale: Locale | null;
  readonly secondaryLocale: Locale | null;
}

interface TermTaxonomyRecord {
  readonly termId: string;
  readonly taxonomy: string;
}

interface TermGraph {
  readonly terms: Map<string, TermRecord>;
  readonly taxonomies: Map<string, TermTaxonomyRecord>;
  readonly taxonomiesByTerm: Map<string, Set<string>>;
  readonly relationships: Map<string, Set<string>>;
  relationshipCount: number;
}

interface GalleryImagePath {
  readonly imagePath: BwgArchivePathCandidate;
  readonly thumbPath: BwgArchivePathCandidate;
  readonly genericImagePath: string | null;
  readonly genericThumbPath: string | null;
}

interface GalleryRelation {
  readonly imageId: string | null;
  readonly galleryId: string | null;
}

interface AlbumRelation {
  readonly albumId: string | null;
  readonly targetId: string | null;
  readonly isAlbum: "0" | "1" | null;
}

export interface GalleryGraph {
  readonly galleries: IdSet;
  readonly images: IdSet;
  readonly albums: IdSet;
  imageRelations: GalleryRelation[];
  albumRelations: AlbumRelation[];
  readonly imagePaths: GalleryImagePath[];
  shortcodes: number;
}

type RedirectTargetEncoding =
  | "plain"
  | "php-serialized"
  | "json"
  | "missing"
  | "malformed"
  | "unsupported";

export interface RedirectGraph {
  records: number;
  readonly statuses: Map<string, number>;
  readonly matchers: Map<string, number>;
  readonly actions: Map<string, number>;
  safeExactPath: number;
  unsafeOrUnsupported: number;
  readonly targetEncoding: Record<RedirectTargetEncoding, number>;
  resolvableLocalTargets: number;
}

export interface GraphState {
  readonly tableColumns: Map<string, Set<string>>;
  readonly postTables: Map<string, PostTableState>;
  readonly postMetaTables: Set<string>;
  readonly terms: TermGraph;
  readonly redirects: RedirectGraph;
  readonly galleries: GalleryGraph;
  readonly issues: IssueCounter;
  readonly referenceBudget: ReferenceBudget;
}

export class ReferenceBudget {
  private count = 0;

  constructor(private readonly limit: number) {}

  add(count = 1) {
    this.count += count;
    if (this.count > this.limit) {
      throw new SourceEvidenceError("evidence-reference-limit");
    }
  }
}

export function createGraphState(limits: SourceEvidenceLimits): GraphState {
  return {
    tableColumns: new Map(),
    postTables: new Map(),
    postMetaTables: new Set(),
    terms: {
      terms: new Map(),
      taxonomies: new Map(),
      taxonomiesByTerm: new Map(),
      relationships: new Map(),
      relationshipCount: 0
    },
    redirects: {
      records: 0,
      statuses: new Map(),
      matchers: new Map(),
      actions: new Map(),
      safeExactPath: 0,
      unsafeOrUnsupported: 0,
      targetEncoding: {
        plain: 0,
        "php-serialized": 0,
        json: 0,
        missing: 0,
        malformed: 0,
        unsupported: 0
      },
      resolvableLocalTargets: 0
    },
    galleries: {
      galleries: new Set(),
      images: new Set(),
      albums: new Set(),
      imageRelations: [],
      albumRelations: [],
      imagePaths: [],
      shortcodes: 0
    },
    issues: issueCounter(),
    referenceBudget: new ReferenceBudget(limits.maxEvidenceReferences)
  };
}

function postKind(value: string | null | undefined): PostKind {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "wprm_recipe") {
    return "wprm";
  }
  if (normalized === "recipe") {
    return "recipe";
  }
  if (normalized === "attachment") {
    return "attachment";
  }
  if (normalized === "page") {
    return "page";
  }
  if (normalized === "post") {
    return "post";
  }
  return "other";
}

function inspectWprmReferences(content: string) {
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

function processPostInsert(
  state: GraphState,
  insert: SqlInsert,
  tableState: PostTableState,
  limits: SourceEvidenceLimits
) {
  const id = numericId(rowValue(insert.row, "ID"));
  const rawType = rowValue(insert.row, "post_type");
  if (!id || rawType === null || rawType === undefined) {
    throw new SourceEvidenceError("malformed-post");
  }
  if (tableState.records.has(id)) {
    throw new SourceEvidenceError("duplicate-post-id");
  }
  const content = rowValue(insert.row, "post_content");
  const references = new Set<string>();
  if (
    content !== null
    && content !== undefined
    && Buffer.byteLength(content, "utf8") <= limits.maxPostContentBytes
  ) {
    for (const reference of inspectWprmReferences(content)) {
      references.add(reference);
      state.referenceBudget.add();
    }
  } else if (content !== null && content !== undefined) {
    throw new SourceEvidenceError("post-content-scan-limit");
  }
  const kind = postKind(rawType);
  tableState.records.set(id, {
    kind,
    parentId: numericId(rowValue(insert.row, "post_parent")),
    references
  });
  tableState.total += 1;
  if (tableState.total > limits.maxPosts) {
    throw new SourceEvidenceError("post-limit");
  }
  if (kind === "page") {
    tableState.pages += 1;
  }
}

function processTermInsert(state: GraphState, insert: SqlInsert) {
  const id = numericId(rowValue(insert.row, "term_id"));
  if (!id || state.terms.terms.has(id)) {
    throw new SourceEvidenceError("malformed-term");
  }
  const slug = rowValue(insert.row, "slug");
  state.terms.terms.set(id, {
    locale: normalizedLocale(slug),
    secondaryLocale: secondaryLocale(slug)
  });
}

function processTermTaxonomyInsert(state: GraphState, insert: SqlInsert) {
  const id = numericId(rowValue(insert.row, "term_taxonomy_id"));
  const termId = numericId(rowValue(insert.row, "term_id"));
  const taxonomy = rowValue(insert.row, "taxonomy");
  if (!id || !termId || taxonomy === null || taxonomy === undefined) {
    throw new SourceEvidenceError("malformed-term-taxonomy");
  }
  if (state.terms.taxonomies.has(id)) {
    throw new SourceEvidenceError("duplicate-term-taxonomy");
  }
  state.terms.taxonomies.set(id, {
    termId,
    taxonomy: taxonomy.toLowerCase()
  });
  const taxonomyIds = state.terms.taxonomiesByTerm.get(termId) ?? new Set<string>();
  taxonomyIds.add(id);
  state.terms.taxonomiesByTerm.set(termId, taxonomyIds);
}

function processTermRelationshipInsert(
  state: GraphState,
  insert: SqlInsert,
  limits: SourceEvidenceLimits
) {
  const objectId = numericId(rowValue(insert.row, "object_id"));
  const taxonomyId = numericId(rowValue(insert.row, "term_taxonomy_id"));
  if (!objectId || !taxonomyId) {
    throw new SourceEvidenceError("malformed-term-relationship");
  }
  state.terms.relationshipCount += 1;
  if (state.terms.relationshipCount > limits.maxTermRelationships) {
    throw new SourceEvidenceError("term-relationship-limit");
  }
  const members = state.terms.relationships.get(taxonomyId) ?? new Set<string>();
  members.add(objectId);
  state.terms.relationships.set(taxonomyId, members);
}

export function normalizedArchivePath(value: string): string | null {
  let candidate = value.trim().replaceAll("\\", "/");
  if (!candidate) {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      return null;
    }
  }
  candidate = candidate.split(/[?#]/u, 1)[0] ?? "";
  candidate = candidate.replace(/^\/+/u, "");
  const segments = candidate.split("/");
  const uploadsIndex = segments.findIndex((segment) => segment.toLowerCase() === "uploads");
  const relative = uploadsIndex >= 0 ? segments.slice(uploadsIndex + 1) : segments;
  if (
    relative.length === 0
    || relative.some((segment) =>
      !segment
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f\u007f]/u.test(segment)
    )
  ) {
    return null;
  }
  return relative.join("/");
}

const bwgArchiveRoot = "photo-gallery/";
const bwgWordPressRoot = "/wp-content/uploads/photo-gallery/";

function unsafeBwgPathValue(value: string) {
  return (
    value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.includes("?")
    || value.includes("#")
    || /%(?:2f|5c)/iu.test(value)
  );
}

function validateBwgPath(value: string) {
  try {
    validateSafeLocalPath(value.startsWith("/") ? value : `/${value}`, "BWG path");
    return true;
  } catch {
    return false;
  }
}

export function normalizeBwgArchivePath(
  value: string | null | undefined
): BwgArchivePathCandidate {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return { kind: "empty", archivePath: null };
  }
  if (unsafeBwgPathValue(trimmed)) {
    return { kind: "unsafe", archivePath: null };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) || trimmed.startsWith("//")) {
    return { kind: "external", archivePath: null };
  }
  if (/^[A-Za-z]:\//u.test(trimmed)) {
    return { kind: "absolute", archivePath: null };
  }
  const singleLeading = trimmed.startsWith("/");
  const relative = singleLeading ? trimmed.slice(1) : trimmed;
  if (relative.length === 0) {
    return { kind: "empty", archivePath: null };
  }
  if (trimmed.startsWith(bwgWordPressRoot)) {
    const rootTail = trimmed.slice(bwgWordPressRoot.length);
    if (!validateBwgPath(trimmed) || rootTail.includes(":")) {
      return { kind: "unsafe", archivePath: null };
    }
    return {
      kind: "wordpress-root-relative",
      archivePath: `photo-gallery/${trimmed.slice(bwgWordPressRoot.length)}`
    };
  }
  if (
    trimmed.startsWith("/wp-content/")
    || trimmed.startsWith("/uploads/")
  ) {
    return { kind: "unsupported", archivePath: null };
  }
  if (singleLeading) {
    if (!validateBwgPath(relative) || relative.includes(":")) {
      return { kind: "unsafe", archivePath: null };
    }
    return {
      kind: "single-leading-bwg-relative",
      archivePath: `${bwgArchiveRoot}${relative}`
    };
  }
  if (relative.startsWith(bwgArchiveRoot)) {
    if (!validateBwgPath(relative) || relative.includes(":")) {
      return { kind: "unsafe", archivePath: null };
    }
    return { kind: "already-archive-relative", archivePath: relative };
  }
  if (!validateBwgPath(relative) || relative.includes(":")) {
    return { kind: "unsafe", archivePath: null };
  }
  return {
    kind: "relative-to-bwg-root",
    archivePath: `${bwgArchiveRoot}${relative}`
  };
}

function processGalleryInsert(state: GraphState, insert: SqlInsert) {
  const table = insert.table.toLowerCase();
  if (table.endsWith("bwg_gallery")) {
    const id = numericId(rowValue(insert.row, "id"));
    if (id) {
      state.galleries.galleries.add(id);
    }
    return;
  }
  if (table.endsWith("bwg_image")) {
    const id = numericId(rowValue(insert.row, "id"));
    const galleryId = numericId(rowValue(insert.row, "gallery_id"));
    if (id) {
      state.galleries.images.add(id);
      state.galleries.imageRelations.push({ imageId: id, galleryId });
      const imageValue = rowValue(insert.row, "image_url");
      const thumbValue = rowValue(insert.row, "thumb_url");
      state.galleries.imagePaths.push({
        imagePath: normalizeBwgArchivePath(imageValue),
        thumbPath: normalizeBwgArchivePath(thumbValue),
        genericImagePath: imageValue ? normalizedArchivePath(imageValue) : null,
        genericThumbPath: thumbValue ? normalizedArchivePath(thumbValue) : null
      });
      if (imageValue !== null && imageValue !== undefined) {
        state.referenceBudget.add();
      }
      if (thumbValue !== null && thumbValue !== undefined) {
        state.referenceBudget.add();
      }
    }
    return;
  }
  if (table.endsWith("bwg_album")) {
    const id = numericId(rowValue(insert.row, "id"));
    if (id) {
      state.galleries.albums.add(id);
    }
    return;
  }
  if (table.endsWith("bwg_shortcode")) {
    state.galleries.shortcodes += 1;
    return;
  }
  if (table.endsWith("bwg_album_gallery")) {
    const albumId = numericId(rowValue(insert.row, "album_id"));
    const targetId = numericId(rowValue(insert.row, "alb_gal_id"));
    const isAlbum = rowValue(insert.row, "is_album");
    state.galleries.albumRelations.push({
      albumId,
      targetId,
      isAlbum: isAlbum === "0" || isAlbum === "1" ? isAlbum : null
    });
  }
}

function processRedirectInsert(
  state: GraphState,
  insert: SqlInsert,
  limits: SourceEvidenceLimits
) {
  for (const value of [
    rowValue(insert.row, "url"),
    rowValue(insert.row, "match_url"),
    rowValue(insert.row, "regex"),
    rowValue(insert.row, "status"),
    rowValue(insert.row, "match_type"),
    rowValue(insert.row, "action_type"),
    rowValue(insert.row, "action_code"),
    rowValue(insert.row, "action_data"),
    rowValue(insert.row, "match_data")
  ]) {
    if (
      value !== null
      && value !== undefined
      && Buffer.byteLength(value, "utf8") > limits.maxMetaValueBytes
    ) {
      throw new SourceEvidenceError("meta-value-limit");
    }
  }
  const source = rowValue(insert.row, "url")
    ?? rowValue(insert.row, "match_url")
    ?? null;
  const matchType = rowValue(insert.row, "match_type") ?? null;
  const regex = rowValue(insert.row, "regex") ?? null;
  const status = rowValue(insert.row, "status") ?? null;
  const actionType = rowValue(insert.row, "action_type") ?? null;
  const actionCode = rowValue(insert.row, "action_code") ?? null;
  const actionData = rowValue(insert.row, "action_data") ?? null;
  const redirects = state.redirects;
  redirects.records += 1;
  const statusLabel = safeLabel(status, statusLabels);
  redirects.statuses.set(
    statusLabel,
    (redirects.statuses.get(statusLabel) ?? 0) + 1
  );
  const matcherLabel = safeLabel(matchType, matcherLabels);
  redirects.matchers.set(
    matcherLabel,
    (redirects.matchers.get(matcherLabel) ?? 0) + 1
  );
  const actionLabel = safeLabel(actionType, actionTypeLabels);
  const code = actionCode && /^\d{3}$/u.test(actionCode.trim())
    ? Number(actionCode.trim())
    : "other";
  const actionKey = `${actionLabel}:${code}`;
  redirects.actions.set(
    actionKey,
    (redirects.actions.get(actionKey) ?? 0) + 1
  );
  const sourceSafe =
    matcherLabel === "url"
    && (regex === null || regex.trim() === "" || regex.trim() === "0")
    && isSafeLocalPath(source);
  if (sourceSafe) {
    redirects.safeExactPath += 1;
  } else {
    redirects.unsafeOrUnsupported += 1;
  }
  const target = redirectTarget(actionData, limits);
  redirects.targetEncoding[target.encoding] += 1;
  if (target.resolvable) {
    redirects.resolvableLocalTargets += 1;
  }
}

export function tableStateFor(
  state: GraphState,
  table: string,
  columns: readonly string[]
) {
  const existing = state.tableColumns.get(table);
  if (existing === undefined) {
    state.tableColumns.set(table, new Set(columns));
  }
  return state.tableColumns.get(table) ?? new Set(columns);
}

function postTableFor(state: GraphState, table: string, columns: readonly string[]) {
  if (
    !tableEndsWith(table, "posts")
    || !tableHasColumns(new Set(columns), ["ID", "post_type"])
  ) {
    return undefined;
  }
  const existing = state.postTables.get(table);
  if (existing) {
    return existing;
  }
  const result: PostTableState = {
    table,
    columns: new Set(columns),
    records: new Map(),
    total: 0,
    pages: 0
  };
  state.postTables.set(table, result);
  return result;
}

export function graphHandlers(state: GraphState, limits: SourceEvidenceLimits) {
  return {
    onCreateTable(table: { readonly table: string; readonly columns: readonly string[] }) {
      const columns = tableStateFor(state, table.table, table.columns);
      postTableFor(state, table.table, [...columns]);
      if (
        tableEndsWith(table.table, "postmeta")
        && tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
      ) {
        state.postMetaTables.add(table.table);
      }
    },
    getTableColumns(table: string) {
      return [...(state.tableColumns.get(table) ?? [])];
    },
    onInsert(insert: SqlInsert) {
      const columns = tableStateFor(state, insert.table, insert.columns);
      const posts = postTableFor(state, insert.table, [...columns]);
      if (posts) {
        processPostInsert(state, insert, posts, limits);
      }
      if (
        tableEndsWith(insert.table, "postmeta")
        && tableHasColumns(columns, ["post_id", "meta_key", "meta_value"])
      ) {
        state.postMetaTables.add(insert.table);
      }
      if (
        tableEndsWith(insert.table, "terms")
        && tableHasColumns(columns, ["term_id", "slug"])
      ) {
        processTermInsert(state, insert);
      } else if (
        tableEndsWith(insert.table, "term_taxonomy")
        && tableHasColumns(columns, ["term_taxonomy_id", "term_id", "taxonomy"])
      ) {
        processTermTaxonomyInsert(state, insert);
      } else if (
        tableEndsWith(insert.table, "term_relationships")
        && tableHasColumns(columns, ["object_id", "term_taxonomy_id"])
      ) {
        processTermRelationshipInsert(state, insert, limits);
      } else if (
        tableEndsWith(insert.table, "redirection_items")
        && tableHasColumns(columns, ["id"])
      ) {
        processRedirectInsert(state, insert, limits);
      } else if (insert.table.toLowerCase().includes("bwg_")) {
        processGalleryInsert(state, insert);
      }
    }
  };
}

export function selectCoreTable(
  candidates: ReadonlyMap<string, PostTableState>,
  suffix: string
) {
  const values = [...candidates.values()].filter((value) => tableEndsWith(value.table, suffix));
  if (values.length === 0) {
    throw new SourceEvidenceError("missing-core-table");
  }
  if (values.length !== 1) {
    throw new SourceEvidenceError("ambiguous-core-table");
  }
  return values[0];
}

export function selectPostMetaTable(state: GraphState) {
  const values = [...state.postMetaTables];
  if (values.length > 1) {
    throw new SourceEvidenceError("ambiguous-core-table");
  }
  return values[0];
}

function safeLabel(value: string | null | undefined, allowed: ReadonlySet<string>) {
  const normalized = value?.trim().toLowerCase();
  return normalized && allowed.has(normalized) ? normalized : "other";
}

const statusLabels = new Set(["enabled", "disabled", "active", "inactive", "0", "1"]);
const matcherLabels = new Set(["url", "regex", "relative", "absolute"]);
const actionTypeLabels = new Set(["url", "error", "pass", "proxy", "random", "data"]);

export function sortedCountLabels(values: ReadonlyMap<string, number>): CountLabel[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ value, count }));
}

export function sortedNumericCounts(values: ReadonlyMap<number, number>): MemberCount[] {
  return [...values.entries()]
    .sort(([left], [right]) => left - right)
    .map(([members, count]) => ({ members, count }));
}

  function isSafeLocalPath(value: string | null) {
    if (value === null) {
      return false;
    }
    try {
      validateSafeLocalPath(value, "redirect path");
      return true;
    } catch {
      return false;
    }
  }

  function redirectTarget(
    value: string | null,
    limits: SourceEvidenceLimits
  ): {
    readonly encoding: RedirectTargetEncoding;
    readonly resolvable: boolean;
  } {
    if (value === null || value.trim().length === 0) {
      return { encoding: "missing", resolvable: false };
    }
    const trimmed = value.trim();
    if (Buffer.byteLength(trimmed, "utf8") > limits.maxMetaValueBytes) {
      throw new SourceEvidenceError("meta-value-limit");
    }
    const serialized =
      /^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed) || /^N;/u.test(trimmed);
    if (serialized) {
      try {
        const parsed = parsePhpSerialized(trimmed, {
          maxInputBytes: limits.maxMetaValueBytes,
          maxDepth: limits.maxSerializedDepth,
          maxEntries: limits.maxSerializedEntries,
          maxStringBytes: limits.maxMetaValueBytes
        });
        const targets = collectTargetStrings(parsed);
        return {
          encoding: "php-serialized",
          resolvable: targets.length === 1 && isSafeLocalPath(targets[0] ?? null)
        };
      } catch (error) {
        if (
          error instanceof PhpSerializationError
          && (error.code === "depth-limit"
            || error.code === "entry-limit"
            || error.code === "string-limit")
        ) {
          throw new SourceEvidenceError("serialized-limit");
        }
        return {
          encoding: error instanceof PhpSerializationError
            && error.code === "unsupported-type"
            ? "unsupported"
            : "malformed",
          resolvable: false
        };
      }
    }
    if (/^[\[{]/u.test(trimmed)) {
      const parsed = readJsonValue(trimmed);
      if (parsed === null) {
        return { encoding: "malformed", resolvable: false };
      }
      if (!withinStructuredLimits(parsed, limits)) {
        throw new SourceEvidenceError("serialized-limit");
      }
      const targets = collectTargetStrings(parsed);
      return {
        encoding: "json",
        resolvable: targets.length === 1 && isSafeLocalPath(targets[0] ?? null)
      };
    }
    return {
      encoding: "plain",
      resolvable: isSafeLocalPath(trimmed)
    };
  }







export function tableHasColumns(
  columns: ReadonlySet<string>,
  required: readonly string[]
) {
  const normalized = new Set([...columns].map((column) => column.toLowerCase()));
  return required.every((column) => normalized.has(column.toLowerCase()));
}

export function tableEndsWith(table: string, suffix: string) {
  return table.toLowerCase().endsWith(suffix.toLowerCase());
}

export function rowValue(
  row: SqlInsert["row"],
  column: string
): SqlValue | undefined {
  if (row[column] !== undefined) {
    return row[column];
  }
  const actual = Object.keys(row).find(
    (candidate) => candidate.toLowerCase() === column.toLowerCase()
  );
  return actual === undefined ? undefined : row[actual];
}

export function numericId(value: SqlValue | undefined) {
  return value !== null
    && value !== undefined
    && /^\d+$/u.test(value)
    && value !== "0"
    ? value
    : null;
}

export function normalizedLocale(value: string | null | undefined): Locale | null {
  const normalized = value?.trim().toLowerCase().replace("_", "-");
  if (!normalized) {
    return null;
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  if (normalized === "fr" || normalized.startsWith("fr-")) {
    return "fr";
  }
  if (normalized === "ru" || normalized.startsWith("ru-")) {
    return "ru";
  }
  return null;
}

export function secondaryLocale(value: string | null | undefined): Locale | null {
  const normalized = value?.trim().toLowerCase();
  return normalized?.startsWith("pll_")
    ? normalizedLocale(normalized.slice(4))
    : null;
}
