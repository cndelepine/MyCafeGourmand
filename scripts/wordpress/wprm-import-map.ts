import path from "node:path";
import { recipeRecordSchema, type Quantity, type RecipeRecord } from "../../src/content/schema";
import {
  decodeRecipeSlug,
  validateSafeLocalPath
} from "../../src/content/url-path";
import {
  normalizedArchivePath,
  numericId
} from "./source-evidence-scan";
import {
  isPhpValue,
  readJsonValue,
  withinStructuredLimits
} from "./source-evidence-structured";
import {
  parsePhpSerialized,
  PhpSerializationError,
  type PhpValue
} from "./php-serialize";
import {
  WprmImportError,
  type WprmIssueCode,
  type WprmImportLimits,
  type WprmSourceGraph,
  type WprmSourceMetadata,
  type WprmSourceSnapshot
} from "./wprm-import-contracts";
import type { WprmRelations } from "./wprm-import-relations";

const fractionValues: Readonly<Record<string, number>> = {
  "¼": 0.25,
  "½": 0.5,
  "¾": 0.75,
  "⅐": 1 / 7,
  "⅑": 1 / 9,
  "⅒": 0.1,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875
};

const allowedIngredientGroupKeys = new Set(["ingredients", "name", "uid"]);
const allowedIngredientKeys = new Set([
  "uid",
  "amount",
  "unit",
  "name",
  "notes",
  "raw",
  "splits",
  "converted",
  "link",
  "id",
  "unit_id",
  "product_amount",
  "product_amount_default",
  "product_item_snapshot",
  "conversion_item_snapshot"
]);
const unsupportedIngredientContentKeys = new Set([
  "splits",
  "converted",
  "link",
  "product_amount",
  "product_amount_default",
  "product_item_snapshot",
  "conversion_item_snapshot"
]);
const allowedInstructionGroupKeys = new Set(["instructions", "name", "uid"]);
const allowedInstructionKeys = new Set([
  "uid",
  "name",
  "text",
  "type",
  "image",
  "ingredients",
  "video",
  "tip_icon",
  "tip_style",
  "tip_accent",
  "tip_text_color"
]);
const unsupportedInstructionContentKeys = new Set([
  "name",
  "type",
  "video",
  "ingredients",
  "tip_icon",
  "tip_style",
  "tip_accent",
  "tip_text_color"
]);

const imageExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp"
]);

export class WprmMappingError extends WprmImportError {
  readonly issueCodes: readonly WprmIssueCode[];

  constructor(issueCodes: readonly WprmIssueCode[]) {
    super(issueCodes[0] ?? "malformed-wprm-meta");
    this.name = "WprmMappingError";
    this.issueCodes = [...new Set(issueCodes)];
  }
}

export interface WprmMappingResult {
  readonly record: RecipeRecord;
  readonly codes: readonly WprmIssueCode[];
}

function nonEmptyText(value: PhpValue | null | undefined) {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function objectEntries(value: PhpValue): Array<[string, PhpValue]> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => [String(index), entry] as [string, PhpValue]);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value);
  }
  return [];
}

function orderedValues(value: PhpValue) {
  const entries = objectEntries(value);
  if (entries.length === 0) {
    return [];
  }
  return entries
    .sort(([left], [right]) => {
      const leftNumber = /^\d+$/u.test(left) ? Number(left) : null;
      const rightNumber = /^\d+$/u.test(right) ? Number(right) : null;
      return leftNumber !== null && rightNumber !== null
        ? leftNumber - rightNumber
        : 0;
    })
    .map(([, entry]) => entry);
}

function isObject(value: PhpValue | undefined): value is Record<string, PhpValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyValue(value: PhpValue) {
  if (value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  return Object.keys(value).length > 0;
}

function hasUnsupportedKeys(
  value: Record<string, PhpValue>,
  allowed: ReadonlySet<string>
) {
  return Object.entries(value).some(([key, nested]) =>
    !allowed.has(key) && isNonEmptyValue(nested)
  );
}

function hasNonEmptyKeys(
  value: Record<string, PhpValue>,
  keys: ReadonlySet<string>
) {
  return [...keys].some((key) => {
    const nested = value[key];
    return nested !== undefined && isNonEmptyValue(nested);
  });
}

function parseNumberToken(value: string) {
  const normalized = value.trim().replace(/\u00a0/gu, " ");
  if (!normalized || normalized.length > 64) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(fractionValues, normalized)) {
    return fractionValues[normalized]!;
  }
  const fraction = normalized.match(/^(\d+)\s*\/\s*(\d+)$/u);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (
      denominator > 0
      && denominator <= 10_000
      && numerator > 0
      && numerator <= 1_000_000
    ) {
      const result = numerator / denominator;
      return Number.isFinite(result) && result > 0 ? result : null;
    }
    return null;
  }
  const mixed = normalized.match(/^(\d+)\s+([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/u);
  if (mixed) {
    const whole = Number(mixed[1]);
    const fractionValue = fractionValues[mixed[2]!]!;
    const result = whole + fractionValue;
    return result > 0 && result <= 1_000_000 ? result : null;
  }
  const mixedAscii = normalized.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/u);
  if (mixedAscii) {
    const whole = Number(mixedAscii[1]);
    const numerator = Number(mixedAscii[2]);
    const denominator = Number(mixedAscii[3]);
    if (
      whole >= 0
      && numerator > 0
      && denominator > 0
      && denominator <= 10_000
      && numerator < denominator
    ) {
      const result = whole + numerator / denominator;
      return result > 0 && result <= 1_000_000 ? result : null;
    }
    return null;
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(normalized)) {
    return null;
  }
  const result = Number(normalized);
  return Number.isFinite(result) && result > 0 && result <= 1_000_000
    ? result
    : null;
}

export function parseWprmQuantity(
  amount: string | null,
  unit: string | null
): Quantity | null {
  const rawAmount = amount ?? "";
  const rawUnit = unit ?? "";
  if (rawAmount.length === 0 && rawUnit.length === 0) {
    return null;
  }
  const raw = [rawAmount, rawUnit].filter((value) => value.length > 0).join(" ");
  const trimmedAmount = rawAmount.trim();
  const normalizedUnit = rawUnit.length > 0 ? rawUnit : null;
  if (trimmedAmount.length === 0) {
    return {
      raw,
      unit: normalizedUnit,
      scalable: false
    };
  }
  const range = trimmedAmount.match(
    /^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/iu
  );
  if (range) {
    const min = parseNumberToken(range[1]!);
    const max = parseNumberToken(range[2]!);
    if (min !== null && max !== null && min <= max) {
      return {
        raw,
        min,
        max,
        unit: normalizedUnit,
        scalable: true
      };
    }
  } else {
    const value = parseNumberToken(trimmedAmount);
    if (value !== null) {
      return {
        raw,
        value,
        unit: normalizedUnit,
        scalable: true
      };
    }
  }
  return {
    raw,
    unit: normalizedUnit,
    scalable: false
  };
}

function valueAt(object: Record<string, PhpValue>, key: string) {
  return object[key];
}

function parseStructured(
  raw: string | undefined,
  limits: WprmImportLimits,
  issueCode: WprmIssueCode
) {
  if (raw === undefined || raw.trim().length === 0) {
    throw new WprmMappingError([issueCode]);
  }
  const trimmed = raw.trim();
  let parsedValue: PhpValue | null = null;
  if (/^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed) || /^N;/u.test(trimmed)) {
    try {
      parsedValue = parsePhpSerialized(trimmed, {
        maxInputBytes: limits.evidence.maxMetaValueBytes,
        maxDepth: limits.evidence.maxSerializedDepth,
        maxEntries: limits.evidence.maxSerializedEntries,
        maxStringBytes: limits.evidence.maxMetaValueBytes
      });
    } catch (error) {
      if (
        error instanceof PhpSerializationError
        && ["depth-limit", "entry-limit", "string-limit"].includes(error.code)
      ) {
        throw new WprmMappingError(["source-limit"]);
      }
      throw new WprmMappingError([issueCode]);
    }
  } else if (/^[\[{]/u.test(trimmed)) {
    const jsonValue = readJsonValue(trimmed);
    if (
      jsonValue === null
      || !isPhpValue(jsonValue)
      || !withinStructuredLimits(jsonValue, limits.evidence)
    ) {
      throw new WprmMappingError(
        jsonValue !== null && isPhpValue(jsonValue)
          ? ["source-limit"]
          : [issueCode]
      );
    }
    parsedValue = jsonValue;
  } else {
    throw new WprmMappingError([issueCode]);
  }
  const keySets = new Set<string>();
  const pending: PhpValue[] = [parsedValue];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || value === null || typeof value !== "object") {
      continue;
    }
    const keys = Array.isArray(value) ? [] : Object.keys(value).sort();
    keySets.add(JSON.stringify(keys));
    if (keySets.size > limits.evidence.maxShapeKeySets) {
      throw new WprmMappingError(["source-limit"]);
    }
    for (const nested of Array.isArray(value) ? value : Object.values(value)) {
      pending.push(nested);
    }
  }
  return parsedValue;
}

function mapIngredients(
  raw: string | undefined,
  limits: WprmImportLimits
) {
  const root = parseStructured(raw, limits, "malformed-wprm-ingredients");
  const groups: RecipeRecord["recipe"]["ingredientGroups"] = [];
  let unsupported = false;
  for (const [groupIndex, rawGroup] of orderedValues(root).entries()) {
    if (!isObject(rawGroup)) {
      throw new WprmMappingError(["malformed-wprm-ingredients"]);
    }
    unsupported ||= hasUnsupportedKeys(rawGroup, allowedIngredientGroupKeys);
    const groupName = nonEmptyText(valueAt(rawGroup, "name"));
    const rawItems = valueAt(rawGroup, "ingredients");
    if (rawItems === undefined || rawItems === null) {
      throw new WprmMappingError(["malformed-wprm-ingredients"]);
    }
    const items: RecipeRecord["recipe"]["ingredientGroups"][number]["items"] = [];
    for (const [sourceIndex, rawItem] of orderedValues(rawItems).entries()) {
      if (!isObject(rawItem)) {
        throw new WprmMappingError(["malformed-wprm-ingredients"]);
      }
      unsupported ||= hasUnsupportedKeys(rawItem, allowedIngredientKeys)
        || hasNonEmptyKeys(rawItem, unsupportedIngredientContentKeys);
      const name = nonEmptyText(valueAt(rawItem, "name"));
      if (name === null) {
        throw new WprmMappingError(["malformed-wprm-ingredients"]);
      }
      const amount = nonEmptyText(valueAt(rawItem, "amount"));
      const unit = nonEmptyText(valueAt(rawItem, "unit"));
      const notes = nonEmptyText(valueAt(rawItem, "notes"));
      const explicitRaw = nonEmptyText(valueAt(rawItem, "raw"));
      const rawText = explicitRaw
        ?? [amount, unit, name, notes].filter((value): value is string => value !== null).join(" ");
      if (rawText.length === 0) {
        throw new WprmMappingError(["malformed-wprm-ingredients"]);
      }
      items.push({
        sourceIndex,
        raw: rawText,
        quantity: parseWprmQuantity(amount, unit),
        name,
        notes
      });
    }
    if (items.length === 0) {
      throw new WprmMappingError(["malformed-wprm-ingredients"]);
    }
    groups.push({
      name: groupName,
      sourceIndex: groupIndex,
      items
    });
  }
  if (groups.length === 0) {
    throw new WprmMappingError(["malformed-wprm-ingredients"]);
  }
  return { groups, unsupported };
}

function numericReference(value: PhpValue | undefined): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    return numericId(value.trim());
  }
  if (isObject(value)) {
    return numericReference(value.id ?? value.attachment_id);
  }
  return null;
}

function mapInstructions(
  raw: string | undefined,
  limits: WprmImportLimits
) {
  const root = parseStructured(raw, limits, "malformed-wprm-instructions");
  const groups: RecipeRecord["recipe"]["instructionGroups"] = [];
  const references: string[] = [];
  let unsupported = false;
  for (const [groupIndex, rawGroup] of orderedValues(root).entries()) {
    if (!isObject(rawGroup)) {
      throw new WprmMappingError(["malformed-wprm-instructions"]);
    }
    unsupported ||= hasUnsupportedKeys(rawGroup, allowedInstructionGroupKeys);
    const groupName = nonEmptyText(valueAt(rawGroup, "name"));
    const rawSteps = valueAt(rawGroup, "instructions");
    if (rawSteps === undefined || rawSteps === null) {
      throw new WprmMappingError(["malformed-wprm-instructions"]);
    }
    const steps: RecipeRecord["recipe"]["instructionGroups"][number]["steps"] = [];
    for (const [sourceIndex, rawStep] of orderedValues(rawSteps).entries()) {
      if (!isObject(rawStep)) {
        throw new WprmMappingError(["malformed-wprm-instructions"]);
      }
      unsupported ||= hasUnsupportedKeys(rawStep, allowedInstructionKeys)
        || hasNonEmptyKeys(rawStep, unsupportedInstructionContentKeys);
      const text = nonEmptyText(valueAt(rawStep, "text"));
      if (text === null) {
        throw new WprmMappingError(["malformed-wprm-instructions"]);
      }
      const rawImage = valueAt(rawStep, "image");
      const imageText = rawImage === undefined
        || rawImage === null
        || rawImage === 0
        || (typeof rawImage === "string" && rawImage.trim() === "0")
        ? null
        : nonEmptyText(rawImage);
      const mediaId = imageText === null
        ? null
        : numericReference(rawImage);
      if (imageText !== null && mediaId === null) {
        throw new WprmMappingError(["missing-attachment"]);
      }
      if (mediaId !== null) {
        references.push(mediaId);
      }
      steps.push({
        sourceIndex,
        text,
        mediaId: mediaId === null ? null : `wordpress-attachment:${mediaId}`
      });
    }
    if (steps.length === 0) {
      throw new WprmMappingError(["malformed-wprm-instructions"]);
    }
    groups.push({
      name: groupName,
      sourceIndex: groupIndex,
      steps
    });
  }
  if (groups.length === 0) {
    throw new WprmMappingError(["malformed-wprm-instructions"]);
  }
  return { groups, references, unsupported };
}

function sourceTimestamp(
  local: string | null,
  gmt: string | null,
  codes: Set<WprmIssueCode>
) {
  const localValue = local?.trim() ?? "";
  const gmtValue = gmt?.trim() ?? "";
  const zero = (value: string) =>
    value.length === 0 || /^0{4}-0{2}-0{2}(?:[ T]0{2}:0{2}:0{2})?$/u.test(value);
  if (zero(gmtValue)) {
    if (!zero(localValue)) {
      codes.add("timestamp-without-gmt");
    }
    return null;
  }
  const mysql = gmtValue.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u
  );
  if (mysql) {
    const year = Number(mysql[1]);
    const month = Number(mysql[2]);
    const day = Number(mysql[3]);
    const hour = Number(mysql[4]);
    const minute = Number(mysql[5]);
    const second = Number(mysql[6]);
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (
      date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day
      && date.getUTCHours() === hour
      && date.getUTCMinutes() === minute
      && date.getUTCSeconds() === second
    ) {
      return `${mysql[1]}-${mysql[2]}-${mysql[3]}T${mysql[4]}:${mysql[5]}:${mysql[6]}+00:00`;
    }
  }
  const parsed = new Date(gmtValue);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().replace("Z", "+00:00");
  }
  codes.add("timestamp-without-gmt");
  return null;
}

function mapDuration(
  value: string | undefined,
  zeroValue: string | undefined
) {
  if (value === undefined || value.length === 0) {
    return zeroValue === "1"
      ? { raw: "0", minutes: 0 }
      : null;
  }
  const minutes = /^\d+$/u.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER
    ? Number(value)
    : null;
  return {
    raw: value,
    minutes
  };
}

function mapCustomTime(values: ReadonlyMap<string, string>) {
  const duration = mapDuration(
    values.get("wprm_custom_time"),
    values.get("wprm_custom_time_zero")
  );
  const labelValue = values.get("wprm_custom_time_label");
  if (duration === null && (labelValue === undefined || labelValue.length === 0)) {
    return null;
  }
  if (duration === null) {
    throw new WprmMappingError(["malformed-wprm-meta"]);
  }
  return {
    label: labelValue && labelValue.length > 0 ? labelValue : null,
    duration
  };
}

function normalizeAttachmentFile(value: string | null) {
  if (value === null || value.length === 0) {
    return null;
  }
  if (
    value.includes("\\")
    || value.includes("?")
    || value.includes("#")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || /^[a-z][a-z\d+.-]*:\/\//iu.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  const normalized = normalizedArchivePath(value);
  if (normalized === null) {
    return null;
  }
  try {
    validateSafeLocalPath(`/${normalized}`, "attachment path");
  } catch {
    return null;
  }
  return normalized;
}

function parseDimensions(
  raw: string | null,
  limits: WprmImportLimits
) {
  if (raw === null || raw.trim().length === 0) {
    return { width: null, height: null };
  }
  const parsedValue = parseStructured(
    raw,
    limits,
    "invalid-attachment-metadata"
  );
  if (!isObject(parsedValue)) {
    throw new WprmMappingError(["invalid-attachment-metadata"]);
  }
  const read = (key: string) => {
    const value = parsedValue[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/u.test(value) && Number(value) > 0) {
      return Number(value);
    }
    return null;
  };
  return {
    width: read("width"),
    height: read("height")
  };
}

function mapMedia(
  attachmentIds: readonly string[],
  graph: WprmSourceGraph,
  metadata: WprmSourceMetadata,
  uploads: WprmSourceSnapshot["uploads"],
  limits: WprmImportLimits
) {
  const uniqueIds = [...new Set(attachmentIds)];
  if (uniqueIds.length > limits.maxMediaPerCandidate) {
    throw new WprmMappingError(["source-limit"]);
  }
  const media: RecipeRecord["media"] = [];
  for (const attachmentId of uniqueIds) {
    const attachment = graph.attachments.get(attachmentId);
    const attachmentMeta = metadata.attachments.get(attachmentId);
    if (attachment === undefined || attachmentMeta === undefined) {
      throw new WprmMappingError(["missing-attachment"]);
    }
    if (attachmentMeta.duplicateKeys.size > 0) {
      throw new WprmMappingError(["duplicate-singular-meta"]);
    }
    const archivePath = normalizeAttachmentFile(attachmentMeta.attachedFile);
    if (archivePath === null) {
      throw new WprmMappingError(["unsafe-attachment-path"]);
    }
    const archiveCount = uploads.uploadPathCounts.get(archivePath) ?? 0;
    if (archiveCount === 0) {
      throw new WprmMappingError(["attachment-archive-missing"]);
    }
    if (archiveCount !== 1) {
      throw new WprmMappingError(["duplicate-attachment-archive-path"]);
    }
    const extension = path.posix.extname(archivePath).toLowerCase();
    if (!imageExtensions.has(extension)) {
      throw new WprmMappingError(["unsupported-attachment-extension"]);
    }
    const dimensions = parseDimensions(attachmentMeta.dimensions, limits);
    media.push({
      id: `wordpress-attachment:${attachmentId}`,
      sourceId: attachmentId,
      path: `/recipes/media/wordpress/${attachmentId}${extension}`,
      alt: attachmentMeta.alt !== null && attachmentMeta.alt.trim().length > 0
        ? attachmentMeta.alt
        : null,
      width: dimensions.width,
      height: dimensions.height
    });
  }
  return media;
}

function recordSlug(
  postSlug: string | null,
  parentSlug: string | null,
  useParent: boolean,
  codes: Set<WprmIssueCode>
) {
  const slug = useParent && parentSlug !== null && parentSlug.length > 0
    ? parentSlug
    : postSlug;
  if (slug === null || slug.length === 0) {
    codes.add("unsafe-canonical-slug");
    return "";
  }
  try {
    return decodeRecipeSlug(slug, "canonical slug");
  } catch {
    codes.add("unsafe-canonical-slug");
  }
  return slug;
}

export function mapWprmRecipeCandidate(
  recipeId: string,
  graph: WprmSourceGraph,
  metadata: WprmSourceMetadata,
  relations: WprmRelations,
  uploads: WprmSourceSnapshot["uploads"],
  limits: WprmImportLimits
): WprmMappingResult {
  const post = graph.posts.get(recipeId);
  const meta = metadata.wprm.get(recipeId);
  if (post === undefined || post.type.toLowerCase() !== "wprm_recipe") {
    throw new WprmMappingError(["unsupported-wprm-post"]);
  }
  if (post.status !== "publish") {
    throw new WprmMappingError(["nonpublish-recipe"]);
  }
  if (post.hasPassword) {
    throw new WprmMappingError(["protected-source-post"]);
  }
  if (meta === undefined) {
    throw new WprmMappingError(["missing-wprm-metadata"]);
  }
  const codes = new Set<WprmIssueCode>();
  if (meta.duplicateKeys.size > 0) {
    codes.add("duplicate-singular-meta");
  }
  const title = post.title;
  if (title === null || title.length === 0) {
    throw new WprmMappingError(["missing-wprm-title"]);
  }
  const locale = relations.locales.get(recipeId) ?? null;
  if (locale === null) {
    throw new WprmMappingError(["missing-recipe-locale"]);
  }
  const parentLink = relations.parentLinks.get(recipeId);
  const parent = parentLink?.parentId === null || parentLink?.parentId === undefined
    ? null
    : graph.posts.get(parentLink.parentId) ?? null;
  const parentUsable = parentLink?.parentKind === "usable" && parent !== null;
  const slug = recordSlug(
    post.slug,
    parentUsable ? parent?.slug ?? null : null,
    parentUsable,
    codes
  );
  if (slug.length === 0) {
    throw new WprmMappingError([...codes]);
  }
  if (codes.has("unsafe-canonical-slug")) {
    throw new WprmMappingError([...codes]);
  }
  if (meta.unsupportedKeys.size > 0) {
    codes.add("unsupported-wprm-field");
  }
  const ingredients = mapIngredients(meta.values.get("wprm_ingredients"), limits);
  const instructions = mapInstructions(meta.values.get("wprm_instructions"), limits);
  if (ingredients.unsupported || instructions.unsupported) {
    codes.add("unsupported-wprm-field");
  }
  const heroReference = numericReference(
    meta.values.get("_thumbnail_id") ?? undefined
  );
  if (
    meta.values.has("_thumbnail_id")
    && meta.values.get("_thumbnail_id")?.trim() !== ""
    && meta.values.get("_thumbnail_id")?.trim() !== "0"
    && heroReference === null
  ) {
    throw new WprmMappingError(["missing-attachment"]);
  }
  const instructionReferences = instructions.references;
  const media = mapMedia(
    [
      ...(heroReference === null ? [] : [heroReference]),
      ...instructionReferences
    ],
    graph,
    metadata,
    uploads,
    limits
  );
  const timestamps = new Set<WprmIssueCode>();
  const createdAt = sourceTimestamp(post.createdLocal, post.createdGmt, timestamps);
  const modifiedAt = sourceTimestamp(post.modifiedLocal, post.modifiedGmt, timestamps);
  for (const code of timestamps) {
    codes.add(code);
  }
  const editorialCreatedAt = parent !== null
    ? sourceTimestamp(parent.createdLocal, parent.createdGmt, timestamps)
    : null;
  const editorialModifiedAt = parent !== null
    ? sourceTimestamp(parent.modifiedLocal, parent.modifiedGmt, timestamps)
    : null;
  for (const code of timestamps) {
    codes.add(code);
  }
  const taxonomyValues = [
    ...(relations.recipeTaxonomies.get(recipeId) ?? []),
    ...(relations.editorialTaxonomies.get(recipeId) ?? [])
  ].map((taxonomy) => ({
    scope: taxonomy.scope,
    taxonomy: taxonomy.taxonomy,
    sourceId: taxonomy.sourceId,
    sourceTaxonomyId: taxonomy.sourceTaxonomyId,
    name: taxonomy.name,
    slug: taxonomy.slug
  }));
  if (taxonomyValues.length > limits.maxTaxonomiesPerCandidate) {
    throw new WprmMappingError(["source-limit"]);
  }
  const servings = parseWprmQuantity(
    meta.values.get("wprm_servings") ?? null,
    meta.values.get("wprm_servings_unit") ?? null
  );
  const values = meta.values;
  const record = recipeRecordSchema.parse({
    schemaVersion: 1,
    kind: "recipe",
    id: `wordpress:wprm:${recipeId}`,
    locale,
    translationGroupId: relations.translationGroups.get(recipeId) ?? null,
    slug,
    source: {
      system: "wordpress",
      postId: recipeId,
      recipeId,
      postType: post.type,
      plugin: "wprm",
      sourceSlug: post.slug,
      createdAt,
      modifiedAt,
      editorialPostId: parentLink?.parentId ?? null,
      editorialPostType: parent?.type ?? null,
      editorialSourceSlug: parent?.slug ?? null,
      editorialCreatedAt,
      editorialModifiedAt
    },
    redirectFrom: [],
    title,
    description: post.content !== null && post.content.length > 0 ? post.content : null,
    editorial: {
      content: parentUsable && parent?.content !== null && parent?.content !== undefined
        && parent.content.length > 0
        ? parent.content
        : null,
      excerpt: parentUsable && parent?.excerpt !== null && parent?.excerpt !== undefined
        && parent.excerpt.length > 0
        ? parent.excerpt
        : null
    },
    taxonomies: taxonomyValues,
    recipe: {
      notes: values.get("wprm_notes") && values.get("wprm_notes")!.length > 0
        ? values.get("wprm_notes")!
        : null,
      servings,
      times: {
        prep: mapDuration(
          values.get("wprm_prep_time"),
          values.get("wprm_prep_time_zero")
        ),
        cook: mapDuration(
          values.get("wprm_cook_time"),
          values.get("wprm_cook_time_zero")
        ),
        rest: null,
        total: mapDuration(values.get("wprm_total_time"), undefined),
        custom: mapCustomTime(values)
      },
      heroMediaId: heroReference === null
        ? null
        : `wordpress-attachment:${heroReference}`,
      ingredientGroups: ingredients.groups,
      instructionGroups: instructions.groups
    },
    media,
    seo: null
  });
  return {
    record,
    codes: [...codes].sort((left, right) => left.localeCompare(right))
  };
}

export function mapWprmRecipe(
  recipeId: string,
  graph: WprmSourceGraph,
  metadata: WprmSourceMetadata,
  relations: WprmRelations,
  uploads: WprmSourceSnapshot["uploads"],
  limits: WprmImportLimits
) {
  return mapWprmRecipeCandidate(
    recipeId,
    graph,
    metadata,
    relations,
    uploads,
    limits
  ).record;
}

export const mapWprmToRecipeRecord = mapWprmRecipe;
export const mapWprmRecord = mapWprmRecipe;
