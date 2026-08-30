import path from "node:path";
import type { Locale } from "../../src/content/schema";
import {
  decodeRecipeSlug,
  localPathKey,
  validateSafeLocalPath
} from "../../src/content/url-path";
import {
  normalizeBwgArchivePath,
  normalizedLocale
} from "./source-evidence-scan";
import { normalizeWprmAttachmentFile } from "./wprm-import-map";
import {
  classifyEditorialPublicationStatus,
  EditorialImportError,
  type EditorialCandidateOutcome,
  type EditorialCandidateStatus,
  type EditorialGalleryAsset,
  type EditorialGalleryCandidate,
  type EditorialGalleryOutcome,
  type EditorialGalleryRecord,
  type EditorialImportLimits,
  type EditorialIssueCode,
  type EditorialMediaReference,
  type EditorialPublicationDisposition,
  type EditorialPublicationStatus,
  type EditorialSourceSnapshot,
  type EditorialStructuralAnalysis,
  type RawEditorialAttachment,
  type RawBwgGallery,
  type RawBwgImage,
  type RawEditorialPage
} from "./editorial-import-contracts";

interface EditorialRelations {
  readonly locales: ReadonlyMap<string, Locale | null>;
  readonly translationGroups: ReadonlyMap<string, string | null>;
  readonly issues: ReadonlyMap<string, ReadonlySet<EditorialIssueCode>>;
  readonly sourcePaths: ReadonlyMap<string, string | null>;
  readonly pathOwners: ReadonlyMap<string, readonly string[]>;
  readonly groupSummary: {
    readonly groups: number;
    readonly completeTriples: number;
    readonly enFrPairs: number;
    readonly ungrouped: number;
  };
}

interface ContentScan {
  readonly shortcodeCounts: ReadonlyMap<string, number>;
  readonly blockCounts: ReadonlyMap<string, number>;
  readonly inlineAttachmentIds: readonly string[];
  readonly imageSources: readonly string[];
  readonly imageReferenceCount: number;
  readonly hrefs: readonly string[];
  readonly galleryReferences: number;
  readonly galleryIds: ReadonlySet<string>;
  readonly galleryIssueCodes: ReadonlySet<EditorialIssueCode>;
}

const imageExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp"
]);

const harmlessShortcodes = new Set([
  "audio",
  "caption",
  "embed",
  "gallery",
  "playlist",
  "video",
  "wp_caption"
]);

const bwgShortcodes = new Set([
  "bwg",
  "bwg_gallery",
  "best_wordpress_gallery",
  "best-wordpress-gallery"
]);

const bwgGalleryIdAttributes = new Set([
  "id",
  "gallery_id",
  "gallery-id",
  "galleryid"
]);

interface ShortcodeAttribute {
  readonly name: string;
  readonly value: string | null;
}

function parseShortcodeAttributes(shortcode: string, name: string) {
  const body = shortcode.slice(1, -1).trim();
  const attributeText = body.slice(name.length).trim().replace(/\s+\/\s*$/u, "");
  const attributes: ShortcodeAttribute[] = [];
  let offset = 0;
  while (offset < attributeText.length) {
    while (/\s/u.test(attributeText[offset] ?? "")) {
      offset += 1;
    }
    if (offset >= attributeText.length) {
      break;
    }
    const nameMatch = attributeText.slice(offset).match(/^[A-Za-z][A-Za-z0-9_-]*/u);
    if (nameMatch === null) {
      return null;
    }
    const attributeName = nameMatch[0]!.toLowerCase();
    offset += nameMatch[0]!.length;
    while (/\s/u.test(attributeText[offset] ?? "")) {
      offset += 1;
    }
    if (attributeText[offset] !== "=") {
      attributes.push({ name: attributeName, value: null });
      continue;
    }
    offset += 1;
    while (/\s/u.test(attributeText[offset] ?? "")) {
      offset += 1;
    }
    const quote = attributeText[offset];
    if (quote === "\"" || quote === "'") {
      offset += 1;
      const end = attributeText.indexOf(quote, offset);
      if (end === -1) {
        return null;
      }
      attributes.push({
        name: attributeName,
        value: attributeText.slice(offset, end)
      });
      offset = end + 1;
      continue;
    }
    const valueMatch = attributeText.slice(offset).match(/^[^\s"'=<>`]+/u);
    if (valueMatch === null) {
      return null;
    }
    attributes.push({ name: attributeName, value: valueMatch[0]! });
    offset += valueMatch[0]!.length;
  }
  return attributes;
}

function parseBwgGalleryReference(
  shortcode: string,
  name: string
): { readonly id: string | null; readonly issue: EditorialIssueCode | null } {
  const attributes = parseShortcodeAttributes(shortcode, name);
  if (attributes === null) {
    return { id: null, issue: "malformed-gallery-reference" };
  }
  const idAttributes = attributes.filter((attribute) =>
    bwgGalleryIdAttributes.has(attribute.name)
  );
  if (idAttributes.length === 0) {
    if (attributes.some((attribute) =>
      attribute.name === "ids"
      || attribute.name === "gallery"
      || attribute.name === "gallery_ids"
    )) {
      return { id: null, issue: "unsupported-gallery-reference" };
    }
    return { id: null, issue: "gallery-reference-missing" };
  }
  if (idAttributes.length !== 1) {
    return { id: null, issue: "ambiguous-gallery-reference" };
  }
  const value = idAttributes[0]!.value?.trim() ?? "";
  if (value.includes(",")) {
    return { id: null, issue: "ambiguous-gallery-reference" };
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    return { id: null, issue: "malformed-gallery-reference" };
  }
  return { id: value, issue: null };
}

const knownBlocks = new Set([
  "audio",
  "button",
  "buttons",
  "code",
  "column",
  "columns",
  "cover",
  "details",
  "embed",
  "file",
  "gallery",
  "group",
  "heading",
  "html",
  "image",
  "list",
  "media-text",
  "paragraph",
  "preformatted",
  "pullquote",
  "quote",
  "separator",
  "shortcode",
  "spacer",
  "table",
  "verse",
  "video"
]);

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

function sortedCodes(values: Iterable<EditorialIssueCode>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function addIssue(
  issues: Map<string, Set<EditorialIssueCode>>,
  sourceId: string,
  code: EditorialIssueCode
) {
  const values = issues.get(sourceId) ?? new Set<EditorialIssueCode>();
  values.add(code);
  issues.set(sourceId, values);
}

function canonicalSourcePath(locale: Locale, segments: readonly string[]) {
  const prefix = locale === "en" ? [] : [locale];
  const candidate = `/${[...prefix, ...segments].join("/")}/`;
  validateSafeLocalPath(candidate, "editorial source path");
  return candidate;
}

function pageLocaleRelations(snapshot: EditorialSourceSnapshot) {
  const locales = new Map<string, Locale | null>();
  const conflicts = new Set<string>();
  for (const [taxonomyId, taxonomy] of snapshot.graph.taxonomies) {
    if (taxonomy.taxonomy !== "language") {
      continue;
    }
    const locale = normalizedLocale(snapshot.graph.terms.get(taxonomy.termId)?.slug);
    if (locale === null) {
      continue;
    }
    for (const sourceId of snapshot.graph.relationships.get(taxonomyId) ?? []) {
      if (!snapshot.graph.pages.has(sourceId)) {
        continue;
      }
      const previous = locales.get(sourceId);
      if (previous !== undefined && previous !== locale) {
        conflicts.add(sourceId);
        locales.set(sourceId, null);
      } else if (!conflicts.has(sourceId)) {
        locales.set(sourceId, locale);
      }
    }
  }
  for (const sourceId of snapshot.graph.pages.keys()) {
    if (!locales.has(sourceId)) {
      locales.set(sourceId, null);
    }
  }
  return { locales, conflicts };
}

function deriveEditorialRelations(snapshot: EditorialSourceSnapshot): EditorialRelations {
  const issues = new Map<string, Set<EditorialIssueCode>>();
  const { locales, conflicts } = pageLocaleRelations(snapshot);
  for (const sourceId of conflicts) {
    addIssue(issues, sourceId, "conflicting-page-locale");
  }
  for (const [sourceId, locale] of locales) {
    if (locale === null) {
      addIssue(issues, sourceId, "missing-page-locale");
    }
  }

  const translationGroups = new Map<string, string | null>();
  const groupMembership = new Map<string, string[]>();
  for (const [taxonomyId, taxonomy] of snapshot.graph.taxonomies) {
    if (taxonomy.taxonomy !== "post_translations") {
      continue;
    }
    const members = [...(snapshot.graph.relationships.get(taxonomyId) ?? [])]
      .filter((sourceId) => snapshot.graph.pages.has(sourceId))
      .sort(numericIdSort);
    if (members.length === 0) {
      continue;
    }
    groupMembership.set(taxonomyId, members);
    const byLocale = new Map<Locale, string>();
    let invalid = members.length < 2;
    for (const sourceId of members) {
      const existingGroup = translationGroups.get(sourceId);
      if (existingGroup !== undefined && existingGroup !== taxonomyId) {
        invalid = true;
        addIssue(issues, sourceId, "invalid-translation-group");
      } else {
        translationGroups.set(sourceId, taxonomyId);
      }
      const locale = locales.get(sourceId) ?? null;
      if (locale === null) {
        invalid = true;
        continue;
      }
      if (byLocale.has(locale)) {
        invalid = true;
        addIssue(issues, sourceId, "duplicate-translation-group-locale");
        const other = byLocale.get(locale);
        if (other !== undefined) {
          addIssue(issues, other, "duplicate-translation-group-locale");
        }
      } else {
        byLocale.set(locale, sourceId);
      }
    }
    if (invalid) {
      for (const sourceId of members) {
        addIssue(issues, sourceId, "invalid-translation-group");
      }
    }
  }
  for (const sourceId of snapshot.graph.pages.keys()) {
    if (!translationGroups.has(sourceId)) {
      translationGroups.set(sourceId, null);
    }
  }

  const decodedSlugs = new Map<string, string | null>();
  for (const [sourceId, page] of snapshot.graph.pages) {
    if (page.title === null) {
      addIssue(issues, sourceId, "missing-page-title");
    }
    if (page.slug === null) {
      addIssue(issues, sourceId, "missing-page-slug");
    } else {
      try {
        decodedSlugs.set(
          sourceId,
          decodeRecipeSlug(page.slug, "Editorial page slug")
        );
      } catch {
        decodedSlugs.set(sourceId, null);
        addIssue(issues, sourceId, "unsafe-canonical-slug");
      }
    }
    if (!decodedSlugs.has(sourceId)) {
      decodedSlugs.set(sourceId, null);
    }
    if (page.hasPassword) {
      addIssue(issues, sourceId, "protected-page");
    }
    if (classifyEditorialPublicationStatus(page.status) === "unknown") {
      addIssue(issues, sourceId, "unknown-page-status");
    }
    if (page.parentIdMalformed) {
      addIssue(issues, sourceId, "malformed-page-parent");
    }
  }

  interface PagePathResolution {
    readonly segments: readonly string[] | null;
  }

  const pathStates = new Map<string, "visiting" | "done">();
  const pathResults = new Map<string, PagePathResolution>();
  const pathStack: string[] = [];
  const maxPageParentDepth = 256;

  const resolvePagePath = (sourceId: string): PagePathResolution => {
    const existing = pathResults.get(sourceId);
    if (existing !== undefined) {
      return existing;
    }
    if (pathStates.get(sourceId) === "visiting") {
      const cycleStart = pathStack.indexOf(sourceId);
      const cycle = cycleStart === -1
        ? [sourceId]
        : pathStack.slice(cycleStart);
      for (const cycleId of cycle) {
        addIssue(issues, cycleId, "cyclic-page-parent");
      }
      return { segments: null };
    }

    const page = snapshot.graph.pages.get(sourceId);
    if (page === undefined) {
      return { segments: null };
    }
    pathStates.set(sourceId, "visiting");
    pathStack.push(sourceId);
    const locale = locales.get(sourceId) ?? null;
    const slug = decodedSlugs.get(sourceId) ?? null;
    let segments: readonly string[] | null = null;
    let parentResult: PagePathResolution | null = null;

    if (page.parentIdMalformed) {
      addIssue(issues, sourceId, "malformed-page-parent");
    } else if (page.parentId !== null) {
      const parentPage = snapshot.graph.pages.get(page.parentId);
      if (parentPage === undefined) {
        if (
          snapshot.graph.posts?.has(page.parentId)
          || snapshot.graph.attachments.has(page.parentId)
        ) {
          addIssue(issues, sourceId, "non-page-parent");
        } else {
          addIssue(issues, sourceId, "missing-page-parent");
        }
      } else {
        if (pathStack.length >= maxPageParentDepth) {
          addIssue(issues, sourceId, "page-parent-depth-limit");
          parentResult = { segments: null };
        } else {
          parentResult = resolvePagePath(page.parentId);
        }
        const parentLocale = locales.get(page.parentId) ?? null;
        const parentGroup = translationGroups.get(page.parentId) ?? null;
        const group = translationGroups.get(sourceId) ?? null;
        if (parentLocale !== locale) {
          addIssue(issues, sourceId, "incompatible-page-parent-locale");
        }
        if (
          (parentGroup === null) !== (group === null)
          || (parentGroup !== null && parentGroup === group)
        ) {
          addIssue(issues, sourceId, "incompatible-page-parent-translation");
        }
        const parentPublication = classifyEditorialPublicationStatus(parentPage.status);
        if (parentPublication !== "published" || parentPage.hasPassword) {
          addIssue(issues, sourceId, "incompatible-page-parent-publication");
        }
        if (parentResult.segments === null) {
          const parentIssues = issues.get(page.parentId);
          if (parentIssues?.has("unsafe-canonical-slug")
            || parentIssues?.has("unsafe-page-ancestor-slug")) {
            addIssue(issues, sourceId, "unsafe-page-ancestor-slug");
          }
          if (parentIssues?.has("cyclic-page-parent")) {
            addIssue(issues, sourceId, "cyclic-page-parent");
          }
          if (parentIssues?.has("missing-page-parent")) {
            addIssue(issues, sourceId, "missing-page-parent");
          }
          if (parentIssues?.has("non-page-parent")) {
            addIssue(issues, sourceId, "non-page-parent");
          }
          if (parentIssues?.has("malformed-page-parent")) {
            addIssue(issues, sourceId, "malformed-page-parent");
          }
          if (parentIssues?.has("page-parent-depth-limit")) {
            addIssue(issues, sourceId, "page-parent-depth-limit");
          }
          for (const code of [
            "incompatible-page-parent-locale",
            "incompatible-page-parent-publication",
            "incompatible-page-parent-translation"
          ] as const) {
            if (parentIssues?.has(code)) {
              addIssue(issues, sourceId, code);
            }
          }
          if (
            parentIssues !== undefined
            && !parentIssues.has("unsafe-canonical-slug")
            && !parentIssues.has("unsafe-page-ancestor-slug")
            && !parentIssues.has("cyclic-page-parent")
            && !parentIssues.has("missing-page-parent")
            && !parentIssues.has("non-page-parent")
            && !parentIssues.has("malformed-page-parent")
            && !parentIssues.has("page-parent-depth-limit")
            && !parentIssues.has("incompatible-page-parent-locale")
            && !parentIssues.has("incompatible-page-parent-publication")
            && !parentIssues.has("incompatible-page-parent-translation")
          ) {
            addIssue(issues, sourceId, "invalid-page-ancestor");
          }
        }
      }
    }

    if (locale !== null && slug !== null) {
      if (page.parentId === null && !page.parentIdMalformed) {
        segments = [slug];
      } else if (
        parentResult?.segments !== null
        && parentResult?.segments !== undefined
        && !issues.get(sourceId)?.has("incompatible-page-parent-locale")
        && !issues.get(sourceId)?.has("incompatible-page-parent-translation")
        && !issues.get(sourceId)?.has("incompatible-page-parent-publication")
        && !issues.get(sourceId)?.has("cyclic-page-parent")
        && !issues.get(sourceId)?.has("missing-page-parent")
        && !issues.get(sourceId)?.has("non-page-parent")
        && !issues.get(sourceId)?.has("malformed-page-parent")
        && !issues.get(sourceId)?.has("unsafe-page-ancestor-slug")
      ) {
        segments = [...parentResult.segments, slug];
      }
    }
    if (segments !== null && locale !== null) {
      try {
        canonicalSourcePath(locale, segments);
      } catch {
        addIssue(issues, sourceId, "unsafe-canonical-slug");
        segments = null;
      }
    }

    pathStack.pop();
    pathStates.set(sourceId, "done");
    const result = { segments } satisfies PagePathResolution;
    pathResults.set(sourceId, result);
    return result;
  };

  for (const sourceId of snapshot.graph.pages.keys()) {
    resolvePagePath(sourceId);
  }

  for (const members of groupMembership.values()) {
    const parentGroups = new Set<string | null>();
    for (const sourceId of members) {
      const parentId = snapshot.graph.pages.get(sourceId)?.parentId ?? null;
      if (parentId === null || !snapshot.graph.pages.has(parentId)) {
        parentGroups.add(null);
      } else {
        parentGroups.add(translationGroups.get(parentId) ?? null);
      }
    }
    if (parentGroups.size > 1) {
      for (const sourceId of members) {
        addIssue(issues, sourceId, "incompatible-page-parent-translation");
      }
    }
  }

  const sourcePaths = new Map<string, string | null>();
  const pathOwners = new Map<string, string[]>();
  for (const sourceId of snapshot.graph.pages.keys()) {
    const locale = locales.get(sourceId) ?? null;
    const segments = pathResults.get(sourceId)?.segments ?? null;
    let sourcePath: string | null = null;
    if (locale !== null && segments !== null) {
      try {
        sourcePath = canonicalSourcePath(locale, segments);
        const key = localPathKey(sourcePath);
        const owners = pathOwners.get(key) ?? [];
        owners.push(sourceId);
        pathOwners.set(key, owners);
      } catch {
        addIssue(issues, sourceId, "unsafe-canonical-slug");
      }
    }
    sourcePaths.set(sourceId, sourcePath);
  }
  for (const owners of pathOwners.values()) {
    if (owners.length > 1) {
      for (const sourceId of owners) {
        addIssue(issues, sourceId, "canonical-slug-collision");
      }
    }
  }

  let completeTriples = 0;
  let enFrPairs = 0;
  for (const members of groupMembership.values()) {
    const groupLocales = new Set(
      members.map((sourceId) => locales.get(sourceId)).filter(
        (locale): locale is Locale => locale !== null && locale !== undefined
      )
    );
    if (
      members.length === 3
      && groupLocales.size === 3
      && groupLocales.has("en")
      && groupLocales.has("fr")
      && groupLocales.has("ru")
    ) {
      completeTriples += 1;
    }
    if (
      members.length === 2
      && groupLocales.size === 2
      && groupLocales.has("en")
      && groupLocales.has("fr")
    ) {
      enFrPairs += 1;
    }
  }
  return {
    locales,
    translationGroups,
    issues,
    sourcePaths,
    pathOwners,
    groupSummary: {
      groups: groupMembership.size,
      completeTriples,
      enFrPairs,
      ungrouped: [...translationGroups.values()].filter((value) => value === null).length
    }
  };
}

function increment(values: Map<string, number>, key: string) {
  values.set(key, (values.get(key) ?? 0) + 1);
}

interface MarkupImageScan {
  readonly sources: readonly string[];
  readonly referenceCount: number;
  readonly malformed: boolean;
  readonly ambiguous: boolean;
}

function markupWhitespace(value: string) {
  return value === " " || value === "\n" || value === "\r" || value === "\t"
    || value === "\f";
}

function parseImageTagAttributes(value: string) {
  const values = new Map<string, string[]>();
  let offset = 0;
  let malformed = false;
  let ambiguous = false;
  while (offset < value.length) {
    while (markupWhitespace(value[offset] ?? "")) {
      offset += 1;
    }
    if (offset >= value.length) {
      break;
    }
    if (value[offset] === "/") {
      offset += 1;
      while (markupWhitespace(value[offset] ?? "")) {
        offset += 1;
      }
      if (offset < value.length) {
        malformed = true;
      }
      break;
    }
    const nameMatch = value.slice(offset).match(/^[A-Za-z_:][A-Za-z0-9:._-]*/u);
    if (nameMatch === null) {
      malformed = true;
      break;
    }
    const name = nameMatch[0]!.toLowerCase();
    offset += nameMatch[0]!.length;
    while (markupWhitespace(value[offset] ?? "")) {
      offset += 1;
    }
    let attributeValue: string | null = null;
    if (value[offset] === "=") {
      offset += 1;
      while (markupWhitespace(value[offset] ?? "")) {
        offset += 1;
      }
      const quote = value[offset];
      if (quote === "\"" || quote === "'") {
        offset += 1;
        const end = value.indexOf(quote, offset);
        if (end === -1) {
          malformed = true;
          break;
        }
        attributeValue = value.slice(offset, end);
        offset = end + 1;
      } else {
        const start = offset;
        while (
          offset < value.length
          && !markupWhitespace(value[offset] ?? "")
          && !["\"", "'", "<", ">", "=", "`"].includes(value[offset] ?? "")
        ) {
          offset += 1;
        }
        if (start === offset) {
          malformed = true;
          break;
        }
        attributeValue = value.slice(start, offset);
      }
    }
    if (name !== "src" && name !== "srcset") {
      continue;
    }
    if (attributeValue === null) {
      malformed = true;
      continue;
    }
    const previous = values.get(name) ?? [];
    if (previous.length > 0) {
      ambiguous = true;
    }
    previous.push(attributeValue);
    values.set(name, previous);
  }
  return { values, malformed, ambiguous };
}

function parseSrcsetCandidates(value: string) {
  const sources: string[] = [];
  let offset = 0;
  let malformed = false;
  while (offset < value.length) {
    while (markupWhitespace(value[offset] ?? "")) {
      offset += 1;
    }
    if (offset >= value.length) {
      break;
    }
    if (value[offset] === ",") {
      return { sources, malformed: true };
    }
    const start = offset;
    while (
      offset < value.length
      && !markupWhitespace(value[offset] ?? "")
      && value[offset] !== ","
    ) {
      offset += 1;
    }
    const source = value.slice(start, offset);
    if (source.length === 0) {
      return { sources, malformed: true };
    }
    if (source.toLowerCase().startsWith("data:")) {
      sources.push(value.slice(start).trim());
      return { sources, malformed: true };
    }
    sources.push(source);
    while (markupWhitespace(value[offset] ?? "")) {
      offset += 1;
    }
    const descriptorKinds = new Set<string>();
    while (offset < value.length && value[offset] !== ",") {
      const descriptorStart = offset;
      while (
        offset < value.length
        && !markupWhitespace(value[offset] ?? "")
        && value[offset] !== ","
      ) {
        offset += 1;
      }
      const descriptor = value.slice(descriptorStart, offset);
      const kind = /^\d+w$/u.test(descriptor)
        ? "width"
        : /^\d+h$/u.test(descriptor)
          ? "height"
          : /^(?:\d+(?:\.\d+)?|\.\d+)x$/u.test(descriptor)
            ? "density"
            : null;
      if (
        descriptor.length === 0
        || kind === null
        || descriptorKinds.has(kind)
      ) {
        malformed = true;
      } else {
        descriptorKinds.add(kind);
      }
      while (markupWhitespace(value[offset] ?? "")) {
        offset += 1;
      }
    }
    if (offset < value.length) {
      offset += 1;
      if (value.slice(offset).trim().length === 0) {
        malformed = true;
      }
    }
  }
  return { sources, malformed };
}

function scanImageMarkup(content: string): MarkupImageScan {
  const sources: string[] = [];
  let malformed = false;
  let ambiguous = false;
  let offset = 0;
  while (offset < content.length) {
    const start = content.indexOf("<", offset);
    if (start === -1) {
      break;
    }
    if (content.startsWith("<!--", start)) {
      const end = content.indexOf("-->", start + 4);
      if (end === -1) {
        malformed = true;
        break;
      }
      offset = end + 3;
      continue;
    }
    const tagMatch = content.slice(start).match(/^<\s*(img|source)\b/iu);
    if (tagMatch === null) {
      offset = start + 1;
      continue;
    }
    let cursor = start + tagMatch[0]!.length;
    let quote: "\"" | "'" | null = null;
    for (; cursor < content.length; cursor += 1) {
      const character = content[cursor]!;
      if (quote !== null) {
        if (character === quote) {
          quote = null;
        }
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (cursor >= content.length || quote !== null) {
      malformed = true;
      break;
    }
    const attributes = parseImageTagAttributes(
      content.slice(start + tagMatch[0]!.length, cursor)
    );
    malformed = malformed || attributes.malformed;
    ambiguous = ambiguous || attributes.ambiguous;
    for (const source of attributes.values.get("src") ?? []) {
      sources.push(source);
    }
    for (const srcset of attributes.values.get("srcset") ?? []) {
      const parsed = parseSrcsetCandidates(srcset);
      sources.push(...parsed.sources);
      malformed = malformed || parsed.malformed;
    }
    offset = cursor + 1;
  }
  return {
    sources,
    referenceCount: sources.length + (malformed ? 1 : 0),
    malformed,
    ambiguous
  };
}

function scanContent(
  content: string | null,
  limits: EditorialImportLimits,
  issues: Set<EditorialIssueCode>
): ContentScan {
  const shortcodeCounts = new Map<string, number>();
  const blockCounts = new Map<string, number>();
  const inlineAttachmentIds: string[] = [];
  const imageSources: string[] = [];
  const hrefs: string[] = [];
  let galleryReferences = 0;
  const galleryIds = new Set<string>();
  const galleryIssueCodes = new Set<EditorialIssueCode>();
  if (content === null || content.length === 0) {
    return {
      shortcodeCounts,
      blockCounts,
      inlineAttachmentIds,
      imageSources,
      imageReferenceCount: 0,
      hrefs,
      galleryReferences,
      galleryIds,
      galleryIssueCodes
    };
  }
  let shortcodes = 0;
  const shortcodePattern = /\[([A-Za-z][A-Za-z0-9_-]*)(?:\s[^\]]*)?\]/gu;
  for (const match of content.matchAll(shortcodePattern)) {
    shortcodes += 1;
    if (shortcodes > limits.maxShortcodesPerPage) {
      issues.add("source-limit");
      break;
    }
    const name = match[1]!.toLowerCase();
    const shortcode = match[0]!;
    increment(shortcodeCounts, name);
    if (name === "wp-tiles") {
      issues.add("unsupported-wp-tiles");
    } else if (name === "contact-form-7") {
      issues.add("unsupported-contact-form-7");
    } else if (
      bwgShortcodes.has(name)
    ) {
      galleryReferences += 1;
      const reference = parseBwgGalleryReference(shortcode, name);
      if (reference.issue !== null) {
        galleryIssueCodes.add(reference.issue);
        issues.add(reference.issue);
      }
      if (reference.id !== null) {
        galleryIds.add(reference.id);
      }
    } else if (!harmlessShortcodes.has(name)) {
      issues.add("unsupported-shortcode");
    }
    if (name === "gallery" || name === "caption" || name === "image") {
      const ids = shortcode.match(/\bids?\s*=\s*(["']?)([\d,\s]+)\1/iu)?.[2];
      for (const id of ids?.split(",") ?? []) {
        if (/^\d+$/u.test(id.trim())) {
          inlineAttachmentIds.push(id.trim());
        }
      }
      const attachmentId = shortcode.match(/\battachment_id\s*=\s*(["']?)(\d+)\1/iu)?.[2];
      if (attachmentId) {
        inlineAttachmentIds.push(attachmentId);
      }
    }
  }
  let blocks = 0;
  for (const match of content.matchAll(/<!--\s+wp:([A-Za-z0-9_/-]+)/gu)) {
    blocks += 1;
    if (blocks > limits.maxBlocksPerPage) {
      issues.add("source-limit");
      break;
    }
    const name = match[1]!.toLowerCase();
    increment(blockCounts, name);
    const plain = name.startsWith("core/") ? name.slice("core/".length) : name;
    if (plain.includes("tile")) {
      issues.add("unsupported-wp-tiles");
    } else if (!knownBlocks.has(plain)) {
      issues.add("unsupported-block");
    }
  }
  for (const match of content.matchAll(/\bwp-image-(\d+)\b/giu)) {
    inlineAttachmentIds.push(match[1]!);
  }
  for (
    const match of content.matchAll(
      /\bdata-(?:attachment|image)-id\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/giu
    )
  ) {
    inlineAttachmentIds.push(match[1] ?? match[2] ?? match[3]!);
  }
  for (const match of content.matchAll(/<!--\s+wp:image\s+(\{[^>]*\})\s+-->/giu)) {
    const id = match[1]!.match(/"id"\s*:\s*(\d+)/u)?.[1];
    if (id) {
      inlineAttachmentIds.push(id);
    }
  }
  const imageMarkup = scanImageMarkup(content);
  imageSources.push(...imageMarkup.sources);
  if (imageMarkup.malformed) {
    issues.add("malformed-page-content");
  }
  if (imageMarkup.ambiguous) {
    issues.add("ambiguous-inline-media");
  }
  for (
    const match of content.matchAll(
      /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/giu
    )
  ) {
    hrefs.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  const unclosedBwgPattern =
    /\[(bwg|bwg_gallery|best_wordpress_gallery|best-wordpress-gallery)\b[^\]]*$/giu;
  if (unclosedBwgPattern.test(content)) {
    galleryReferences += 1;
    galleryIssueCodes.add("malformed-gallery-reference");
    issues.add("malformed-gallery-reference");
  }
  return {
    shortcodeCounts,
    blockCounts,
    inlineAttachmentIds,
    imageSources,
    imageReferenceCount: imageMarkup.referenceCount,
    hrefs,
    galleryReferences,
    galleryIds,
    galleryIssueCodes
  };
}

/**
 * Count bounded editorial evidence before mapping retains references. A
 * reference is one gallery shortcode occurrence, one distinct inline
 * attachment identifier per post, or one image element in post content.
 */
export function countEditorialContentReferences(content: string | null) {
  if (content === null || content.length === 0) {
    return 0;
  }
  const inlineAttachmentIds: string[] = [];
  let galleryReferences = 0;
  for (const match of content.matchAll(
    /\[([A-Za-z][A-Za-z0-9_-]*)(?:\s[^\]]*)?\]/gu
  )) {
    const name = match[1]!.toLowerCase();
    const shortcode = match[0]!;
    if (bwgShortcodes.has(name)) {
      galleryReferences += 1;
    }
    if (name === "gallery" || name === "caption" || name === "image") {
      const ids = shortcode.match(/\bids?\s*=\s*(["']?)([\d,\s]+)\1/iu)?.[2];
      for (const id of ids?.split(",") ?? []) {
        if (/^\d+$/u.test(id.trim())) {
          inlineAttachmentIds.push(id.trim());
        }
      }
      const attachmentId = shortcode.match(
        /\battachment_id\s*=\s*(["']?)(\d+)\1/iu
      )?.[2];
      if (attachmentId !== undefined) {
        inlineAttachmentIds.push(attachmentId);
      }
    }
  }
  if (
    /\[(bwg|bwg_gallery|best_wordpress_gallery|best-wordpress-gallery)\b[^\]]*$/iu
      .test(content)
  ) {
    galleryReferences += 1;
  }
  for (const match of content.matchAll(/\bwp-image-(\d+)\b/giu)) {
    inlineAttachmentIds.push(match[1]!);
  }
  for (const match of content.matchAll(
    /\bdata-(?:attachment|image)-id\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))/giu
  )) {
    inlineAttachmentIds.push(match[1] ?? match[2] ?? match[3]!);
  }
  for (const match of content.matchAll(/<!--\s+wp:image\s+(\{[^>]*\})\s+-->/giu)) {
    const id = match[1]!.match(/"id"\s*:\s*(\d+)/u)?.[1];
    if (id !== undefined) {
      inlineAttachmentIds.push(id);
    }
  }
  const imageMarkup = scanImageMarkup(content);
  return galleryReferences + inlineAttachmentIds.length + imageMarkup.referenceCount;
}

function sortedCounts(values: ReadonlyMap<string, number>) {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => ({ name, count }));
}

function internalPath(
  value: string,
  currentPath: string | null,
  homeOrigin: string
): { readonly kind: "external" | "fragment" | "unsafe" | "internal"; readonly path?: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return { kind: "fragment" };
  }
  if (/^(?:mailto|tel):/iu.test(trimmed)) {
    return { kind: "external" };
  }
  if (/^(?:javascript|data|vbscript):/iu.test(trimmed)) {
    return { kind: "unsafe" };
  }
  if (trimmed.startsWith("//")) {
    return { kind: "unsafe" };
  }
  let parsed: URL;
  try {
    const base = new URL(currentPath ?? "/", homeOrigin);
    parsed = new URL(trimmed, base);
  } catch {
    return { kind: "unsafe" };
  }
  const home = new URL(homeOrigin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "external" };
  }
  if (parsed.hostname !== home.hostname || parsed.port !== home.port) {
    return { kind: "external" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { kind: "unsafe" };
  }
  const isAbsoluteHttp = /^https?:\/\//iu.test(trimmed);
  const absolutePath = trimmed.match(
    /^https?:\/\/[^/?#]+(?<path>\/[^?#]*)?(?:[?#].*)?$/iu
  )?.groups?.path;
  const rawPath = isAbsoluteHttp
    ? (absolutePath ?? "/")
    : (trimmed.startsWith("/")
      ? (trimmed.split(/[?#]/u, 1)[0] ?? "")
      : `/${trimmed.split(/[?#]/u, 1)[0] ?? ""}`);
  try {
    validateSafeLocalPath(rawPath || "/", "internal source URL");
    return { kind: "internal", path: localPathKey(parsed.pathname) };
  } catch {
    return { kind: "unsafe" };
  }
}

interface AttachmentPathIndex {
  readonly owners: ReadonlyMap<string, readonly string[]>;
  readonly ambiguousAttachmentIds: ReadonlySet<string>;
}

function attachmentPathIndex(snapshot: EditorialSourceSnapshot): AttachmentPathIndex {
  const pathOwners = new Map<string, Set<string>>();
  const home = new URL(snapshot.options.homeOrigin);
  const addOwner = (pathValue: string, attachmentId: string) => {
    const owners = pathOwners.get(pathValue) ?? new Set<string>();
    owners.add(attachmentId);
    pathOwners.set(pathValue, owners);
  };
  for (const [attachmentId, attachment] of [...snapshot.graph.attachments.entries()]
    .sort(([left], [right]) => numericIdSort(left, right))) {
    const attachedFile = normalizeWprmAttachmentFile(
      snapshot.graph.attachmentMeta.get(attachmentId)?.attachedFile ?? null
    );
    if (attachedFile !== null) {
      try {
        addOwner(localPathKey(`/wp-content/uploads/${attachedFile}`), attachmentId);
      } catch {
        // The attachment mapping records the unsafe path for review.
      }
    }
    if (attachment.guid !== null) {
      try {
        const guid = new URL(attachment.guid);
        if (
          (guid.protocol === "http:" || guid.protocol === "https:")
          && guid.hostname === home.hostname
          && guid.port === home.port
          && guid.pathname.length > 0
        ) {
          addOwner(localPathKey(guid.pathname), attachmentId);
        }
      } catch {
        // A GUID is source provenance only and is not required for media matching.
      }
    }
  }
  const owners = new Map<string, readonly string[]>();
  const ambiguousAttachmentIds = new Set<string>();
  for (const [pathValue, ids] of pathOwners) {
    const sorted = [...ids].sort(numericIdSort);
    owners.set(pathValue, sorted);
    if (sorted.length > 1) {
      for (const id of sorted) {
        ambiguousAttachmentIds.add(id);
      }
    }
  }
  return { owners, ambiguousAttachmentIds };
}

function imageAttachmentId(
  value: string,
  currentPath: string | null,
  homeOrigin: string,
  attachments: AttachmentPathIndex
) {
  if (value.trim().length === 0) {
    return {
      sourceId: null,
      unresolved: false,
      classification: "unsafe" as const
    };
  }
  const resolved = internalPath(value, currentPath, homeOrigin);
  if (resolved.kind === "unsafe" || resolved.kind === "fragment") {
    return {
      sourceId: null,
      unresolved: false,
      classification: "unsafe" as const
    };
  }
  if (resolved.kind === "external" || resolved.path === undefined) {
    return {
      sourceId: null,
      unresolved: false,
      classification: "external" as const
    };
  }
  const owners = attachments.owners.get(resolved.path) ?? [];
  if (owners.length > 1) {
    return {
      sourceId: null,
      unresolved: false,
      classification: "ambiguous" as const
    };
  }
  const sourceId = owners[0] ?? null;
  return {
    sourceId,
    unresolved: sourceId === null,
    classification: "internal" as const
  };
}

type AttachmentParentState =
  | "published"
  | "non-public"
  | "protected"
  | "unknown"
  | "unresolved";

function attachmentParentState(
  sourceId: string,
  snapshot: EditorialSourceSnapshot,
  issues: Set<EditorialIssueCode>,
  visiting: Set<string>
): AttachmentParentState {
  const seen = new Set(visiting);
  let currentId = sourceId;
  let depth = 0;
  while (true) {
    if (depth >= 256) {
      issues.add("attachment-parent-depth-limit");
      issues.add("unresolved-attachment-parent");
      return "unresolved";
    }
    depth += 1;
    const post = snapshot.graph.posts?.get(currentId);
    if (post === undefined) {
      issues.add("missing-attachment-parent");
      issues.add("unresolved-attachment-parent");
      return "unresolved";
    }
    if (seen.has(currentId)) {
      issues.add("cyclic-attachment-parent");
      issues.add("unresolved-attachment-parent");
      return "unresolved";
    }
    seen.add(currentId);
    if (post.parentIdMalformed) {
      issues.add("malformed-attachment-parent");
      issues.add("unresolved-attachment-parent");
      return "unresolved";
    }
    if (post.hasPassword) {
      issues.add("protected-attachment-parent");
      return "protected";
    }
    if (post.status === "publish") {
      return "published";
    }
    if (post.status === "inherit") {
      if (post.parentId === null) {
        return "published";
      }
      currentId = post.parentId;
      continue;
    }
    const publication = classifyEditorialPublicationStatus(post.status);
    if (publication === "publication-excluded") {
      issues.add("nonpublish-attachment-parent");
      return "non-public";
    }
    issues.add("unknown-attachment-parent-status");
    return "unknown";
  }
}

function validateAttachmentAvailability(
  attachment: RawEditorialAttachment,
  snapshot: EditorialSourceSnapshot,
  issues: Set<EditorialIssueCode>
) {
  if (attachment.hasPassword === true) {
    issues.add("protected-attachment");
  }
  const status = attachment.status ?? "";
  const parentId = attachment.parentId ?? null;
  if (attachment.parentIdMalformed === true) {
    issues.add("malformed-attachment-parent");
    issues.add("unresolved-attachment-parent");
    return;
  }
  if (status === "inherit") {
    if (parentId === null) {
      return;
    }
    attachmentParentState(parentId, snapshot, issues, new Set([attachment.id]));
    return;
  }
  const publication = classifyEditorialPublicationStatus(status);
  if (publication === "publication-excluded") {
    issues.add("nonpublish-attachment");
  } else if (publication === "unknown") {
    issues.add("unknown-attachment-status");
  }
  if (parentId !== null) {
    attachmentParentState(parentId, snapshot, issues, new Set([attachment.id]));
  }
}

function attachmentReference(
  sourceId: string,
  roles: ReadonlySet<"featured" | "inline">,
  snapshot: EditorialSourceSnapshot,
  issues: Set<EditorialIssueCode>,
  ambiguousAttachmentIds: ReadonlySet<string>
): EditorialMediaReference | null {
  const attachment = snapshot.graph.attachments.get(sourceId);
  const metadata = snapshot.graph.attachmentMeta.get(sourceId);
  if (attachment === undefined || metadata === undefined) {
    issues.add("missing-attachment");
    return null;
  }
  const sortedRoles = [...roles].sort((left, right) => left.localeCompare(right));
  if (metadata.duplicateKeys.size > 0) {
    issues.add("duplicate-attachment-meta");
  }
  if (metadata.width === null || metadata.height === null) {
    issues.add("invalid-attachment-metadata");
  }
  if (ambiguousAttachmentIds.has(sourceId)) {
    issues.add("ambiguous-attachment-path");
  }
  validateAttachmentAvailability(attachment, snapshot, issues);
  if (metadata.attachedFile === null) {
    issues.add("missing-attachment-file");
    return {
      sourceId,
      roles: sortedRoles,
      mimeType: attachment.mimeType,
      attachedFile: null,
      alt: metadata.alt,
      archiveMatch: "missing",
      width: metadata.width,
      height: metadata.height
    };
  }
  const attachedFile = normalizeWprmAttachmentFile(metadata.attachedFile);
  if (attachedFile === null) {
    issues.add("unsafe-attachment-path");
    return {
      sourceId,
      roles: sortedRoles,
      mimeType: attachment.mimeType,
      attachedFile: null,
      alt: metadata.alt,
      archiveMatch: "unsafe",
      width: metadata.width,
      height: metadata.height
    };
  }
  const extension = path.posix.extname(attachedFile).toLowerCase();
  if (!imageExtensions.has(extension)) {
    issues.add("unsupported-attachment-extension");
  }
  const pathCount = snapshot.uploads.uploadPathCounts.get(attachedFile) ?? 0;
  const archiveMatch = pathCount === 1
    ? "matched"
    : pathCount === 0
      ? "missing"
      : "duplicate";
  if (archiveMatch === "missing") {
    issues.add("attachment-archive-missing");
  } else if (archiveMatch === "duplicate") {
    issues.add("duplicate-attachment-archive-path");
  }
  return {
    sourceId,
    roles: sortedRoles,
    mimeType: attachment.mimeType,
    attachedFile,
    alt: metadata.alt,
    archiveMatch,
    width: metadata.width,
    height: metadata.height
  };
}

function publicationDisposition(
  sourceId: string,
  snapshot: EditorialSourceSnapshot
): EditorialPublicationDisposition {
  return snapshot.options.pageForPosts === sourceId
    ? "posts-archive"
    : "editorial-page";
}

function publicationStatus(
  disposition: EditorialPublicationDisposition,
  page: RawEditorialPage
) {
  return disposition === "posts-archive"
    ? "publication-excluded" as const
    : classifyEditorialPublicationStatus(page.status);
}

function publicationIssue(
  publication: EditorialPublicationStatus,
  disposition: EditorialPublicationDisposition,
  page: RawEditorialPage,
  issues: Set<EditorialIssueCode>
) {
  if (disposition === "posts-archive") {
    issues.add("page-for-posts-archive");
  } else if (publication === "publication-excluded") {
    issues.add("nonpublish-page");
  }
  if (page.hasPassword) {
    issues.add("protected-page");
  }
}

function candidateStatus(
  publication: EditorialPublicationStatus,
  issues: ReadonlySet<EditorialIssueCode>
): EditorialCandidateStatus {
  if (publication === "publication-excluded") {
    return "publication-excluded";
  }
  return issues.size === 0 ? "ready" : "review";
}

function mapPageCandidate(
  sourceId: string,
  snapshot: EditorialSourceSnapshot,
  relations: EditorialRelations,
  attachmentPaths: AttachmentPathIndex,
  limits: EditorialImportLimits
) {
  const page = snapshot.graph.pages.get(sourceId);
  if (page === undefined) {
    throw new EditorialImportError("missing-page");
  }
  const pageIssues = new Set(relations.issues.get(sourceId) ?? []);
  const disposition = publicationDisposition(sourceId, snapshot);
  const publication = publicationStatus(disposition, page);
  publicationIssue(publication, disposition, page, pageIssues);
  const scan = scanContent(page.content, limits, pageIssues);
  if (scan.galleryReferences > 0) {
    pageIssues.add("unlocalized-gallery-publication");
    if (snapshot.graph.galleries.size === 0) {
      pageIssues.add("gallery-reference-missing");
    }
    if ([...scan.galleryIds].some((id) => !snapshot.graph.galleries.has(id))) {
      pageIssues.add("gallery-reference-missing");
    }
  }
  const currentPath = relations.sourcePaths.get(sourceId) ?? null;
  let internal = 0;
  let resolved = 0;
  let unresolved = 0;
  let unsafe = 0;
  let unsafeImageReferences = 0;
  let externalImageReferences = 0;
  const imageResolutions: ReturnType<typeof imageAttachmentId>[] = [];
  for (const href of scan.hrefs) {
    const target = internalPath(href, currentPath, snapshot.options.homeOrigin);
    if (target.kind === "unsafe") {
      unsafe += 1;
      pageIssues.add("unsafe-internal-link");
    } else if (target.kind === "internal") {
      internal += 1;
      if (
        target.path === "/"
        || (target.path !== undefined && relations.pathOwners.has(target.path))
      ) {
        resolved += 1;
      } else if (target.path !== undefined && attachmentPaths.owners.has(target.path)) {
        if ((attachmentPaths.owners.get(target.path) ?? []).length === 1) {
          resolved += 1;
        } else {
          unresolved += 1;
          pageIssues.add("ambiguous-attachment-path");
        }
      } else {
        unresolved += 1;
        pageIssues.add("unresolved-internal-link");
      }
    }
  }
  const roles = new Map<string, Set<"featured" | "inline">>();
  const addRole = (attachmentId: string, role: "featured" | "inline") => {
    const values = roles.get(attachmentId) ?? new Set<"featured" | "inline">();
    values.add(role);
    roles.set(attachmentId, values);
  };
  const featuredReferences = snapshot.graph.featuredMediaReferences.get(sourceId) ?? [];
  if (snapshot.graph.featuredMediaDuplicates.has(sourceId)) {
    pageIssues.add("duplicate-attachment-meta");
  }
  if (snapshot.graph.featuredMediaMalformed.has(sourceId)) {
    pageIssues.add("invalid-attachment-metadata");
  }
  for (const featuredId of featuredReferences) {
    if (featuredId !== null) {
      addRole(featuredId, "featured");
    }
  }
  for (const attachmentId of scan.inlineAttachmentIds) {
    addRole(attachmentId, "inline");
  }
  for (const imageSource of scan.imageSources) {
    const image = imageAttachmentId(
      imageSource,
      currentPath,
      snapshot.options.homeOrigin,
      attachmentPaths
    );
    imageResolutions.push(image);
    if (image.sourceId !== null) {
      addRole(image.sourceId, "inline");
    } else if (image.classification === "unsafe") {
      unsafeImageReferences += 1;
      pageIssues.add("unsafe-inline-media");
    } else if (image.classification === "external") {
      externalImageReferences += 1;
    } else if (image.classification === "ambiguous") {
      pageIssues.add("ambiguous-inline-media");
    } else {
      pageIssues.add("unresolved-inline-media");
    }
  }
  if (
    scan.inlineAttachmentIds.length + scan.imageReferenceCount
    > limits.maxInlineMediaReferences
  ) {
    pageIssues.add("source-limit");
  }
  const media = [...roles.entries()]
    .sort(([left], [right]) => numericIdSort(left, right))
    .flatMap(([attachmentId, role]) => {
      const entry = attachmentReference(
        attachmentId,
        role,
        snapshot,
        pageIssues,
        attachmentPaths.ambiguousAttachmentIds
      );
      return entry === null ? [] : [entry];
    });
  const resolvedMediaIds = new Set(
    media
      .filter((entry) => entry.archiveMatch === "matched")
      .map((entry) => entry.sourceId)
  );
  const unresolvedMediaReferences = featuredReferences.filter(
    (attachmentId) => attachmentId === null || !resolvedMediaIds.has(attachmentId)
  ).length + scan.inlineAttachmentIds.filter(
    (attachmentId) => !resolvedMediaIds.has(attachmentId)
  ).length + imageResolutions.filter((image) =>
    image.classification !== "unsafe"
    && image.classification !== "external"
    && (image.sourceId === null || !resolvedMediaIds.has(image.sourceId))
  ).length;
  const structure: EditorialStructuralAnalysis = {
    model: "lossless-wordpress-html-v2",
    shortcodeCounts: sortedCounts(scan.shortcodeCounts),
    blockCounts: sortedCounts(scan.blockCounts),
    links: { internal, resolved, unresolved, unsafe },
    inlineMediaReferences: scan.inlineAttachmentIds.length,
    markupImageReferences: scan.imageReferenceCount,
    unresolvedMediaReferences,
    unsafeImageReferences,
    externalImageReferences
  };
  const issueCodes = sortedCodes(pageIssues);
  const status = candidateStatus(publication, pageIssues);
  return {
    schemaVersion: 1 as const,
    kind: "wordpress-editorial-page-candidate" as const,
    sourceId,
    locale: relations.locales.get(sourceId) ?? null,
    translationGroupId: relations.translationGroups.get(sourceId) ?? null,
    sourcePath: currentPath,
    publicationDisposition: disposition,
    publication,
    status,
    issueCodes,
    source: {
      post: page.source,
      title: page.title,
      body: page.content,
      excerpt: page.excerpt
    },
    structure,
    media
  };
}

function galleryImagePublished(
  image: RawBwgImage,
  issueCodes: Set<EditorialIssueCode>
) {
  const value = image.source.published ?? image.source.publish ?? image.source.status;
  if (value === undefined || value === null) {
    issueCodes.add("unknown-gallery-image-publication");
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "1"
    || normalized === "true"
    || normalized === "publish"
    || normalized === "published"
  ) {
    return true;
  }
  if (
    normalized === "0"
    || normalized === "false"
    || normalized === "draft"
    || normalized === "private"
    || normalized === "trash"
  ) {
    return false;
  }
  issueCodes.add("unknown-gallery-image-publication");
  return false;
}

function galleryImageAssets(
  snapshot: EditorialSourceSnapshot,
  image: RawBwgImage,
  issueCodes: Set<EditorialIssueCode>
) {
  const assets: EditorialGalleryAsset[] = [];
  for (const [role, value] of [
    ["original", image.imageUrl],
    ["thumbnail", image.thumbUrl]
  ] as const) {
    const normalized = normalizeBwgArchivePath(value);
    let normalization: EditorialGalleryAsset["normalization"];
    if (normalized.archivePath === null) {
      normalization = normalized.kind === "unsafe" ? "unsafe" : "unsupported";
      issueCodes.add(
        normalization === "unsafe"
          ? "gallery-image-path-unsafe"
          : "gallery-image-path-unsupported"
      );
    } else {
      const occurrences = snapshot.uploads.uploadPathCounts.get(normalized.archivePath) ?? 0;
      normalization = occurrences === 1
        ? "matched"
        : occurrences === 0
          ? "missing"
          : "duplicate";
      if (normalization === "missing") {
        issueCodes.add("gallery-image-archive-missing");
      } else if (normalization === "duplicate") {
        issueCodes.add("gallery-image-archive-duplicate");
      }
    }
    assets.push({
      sourceId: image.id,
      role,
      storagePath: normalized.archivePath,
      normalization
    });
  }
  return assets;
}

function mapSingleGalleryCandidate(
  snapshot: EditorialSourceSnapshot,
  gallery: RawBwgGallery,
  referencedIds: ReadonlySet<string>,
  sharedIssueCodes: ReadonlySet<EditorialIssueCode>
) {
  const issueCodes = new Set(sharedIssueCodes);
  if (!referencedIds.has(gallery.id)) {
    issueCodes.add("gallery-reference-missing");
  }
  issueCodes.add("unlocalized-gallery-publication");
  const images = snapshot.graph.galleryImages
    .filter((image) =>
      image.galleryIdState === "present" && image.galleryId === gallery.id
    )
    .sort((left, right) => numericIdSort(left.id, right.id));
  const publishedImages = images.filter((image) =>
    galleryImagePublished(image, issueCodes)
  ).length;
  const assets = images.flatMap((image) =>
    galleryImageAssets(snapshot, image, issueCodes)
  );
  const record: EditorialGalleryCandidate = {
    schemaVersion: 1,
    kind: "wordpress-bwg-gallery-candidate",
    sourceId: gallery.id,
    locale: null,
    status: "review",
    issueCodes: sortedCodes(issueCodes),
    publishedImages,
    source: {
      gallery: gallery.source,
      images: images.map((image) => image.source)
    },
    assets
  };
  return record;
}

function unassignedGalleryImageIssue(
  image: RawBwgImage,
  snapshot: EditorialSourceSnapshot
): EditorialIssueCode {
  if (image.galleryIdState === "missing") {
    return "missing-bwg-image-gallery-id";
  }
  if (image.galleryIdState === "malformed") {
    return "malformed-bwg-image-gallery-id";
  }
  if (image.galleryId === null || !snapshot.graph.galleries.has(image.galleryId)) {
    return "missing-bwg-image-gallery";
  }
  throw new EditorialImportError("assigned-bwg-image-candidate");
}

function mapUnassignedGalleryImageCandidate(
  snapshot: EditorialSourceSnapshot,
  image: RawBwgImage,
  sharedIssueCodes: ReadonlySet<EditorialIssueCode>
) {
  const issueCodes = new Set(sharedIssueCodes);
  issueCodes.add("unlocalized-gallery-publication");
  issueCodes.add(unassignedGalleryImageIssue(image, snapshot));
  const publishedImages = galleryImagePublished(image, issueCodes) ? 1 : 0;
  const assets = galleryImageAssets(snapshot, image, issueCodes);
  return {
    schemaVersion: 1 as const,
    kind: "wordpress-bwg-unassigned-image-candidate" as const,
    sourceId: image.id,
    locale: null,
    status: "review" as const,
    issueCodes: sortedCodes(issueCodes),
    publishedImages,
    source: { image: image.source },
    assets
  };
}

function mapGalleryCandidates(
  snapshot: EditorialSourceSnapshot,
  limits: EditorialImportLimits
) {
  const sharedIssueCodes = new Set<EditorialIssueCode>();
  const referencedIds = new Set<string>();
  let references = 0;
  for (const page of [...snapshot.graph.pages.values()].sort((left, right) =>
    numericIdSort(left.id, right.id)
  )) {
    const scan = scanContent(page.content, limits, new Set());
    references += scan.galleryReferences;
    for (const id of scan.galleryIds) {
      referencedIds.add(id);
    }
    for (const code of scan.galleryIssueCodes) {
      sharedIssueCodes.add(code);
    }
  }
  if (snapshot.graph.galleries.size === 0 && (references > 0 || sharedIssueCodes.size > 0)) {
    sharedIssueCodes.add("gallery-reference-missing");
  }
  const galleryRecords = [...snapshot.graph.galleries.values()]
    .sort((left, right) => numericIdSort(left.id, right.id))
    .map((gallery) =>
      mapSingleGalleryCandidate(snapshot, gallery, referencedIds, sharedIssueCodes)
    );
  const unassignedImages = snapshot.graph.galleryImages
    .filter((image) =>
      image.galleryIdState !== "present"
      || image.galleryId === null
      || !snapshot.graph.galleries.has(image.galleryId)
    )
    .sort((left, right) => numericIdSort(left.id, right.id));
  const records: readonly EditorialGalleryRecord[] = [
    ...galleryRecords,
    ...unassignedImages.map((image) =>
      mapUnassignedGalleryImageCandidate(snapshot, image, sharedIssueCodes)
    )
  ];
  const issueCodes = new Set<EditorialIssueCode>(sharedIssueCodes);
  for (const record of records) {
    for (const code of record.issueCodes) {
      issueCodes.add(code);
    }
  }
  return {
    records,
    issueCodes: sortedCodes(issueCodes),
    assignedImages: snapshot.graph.galleryImages.length - unassignedImages.length,
    unassignedImages: unassignedImages.length
  };
}

function assertEditorialMappingLimits(
  snapshot: EditorialSourceSnapshot,
  limits: EditorialImportLimits
) {
  const postCount = snapshot.graph.posts?.size
    ?? snapshot.graph.pages.size + snapshot.graph.attachments.size;
  if (postCount > limits.evidence.maxPosts) {
    throw new EditorialImportError("post-limit");
  }
  let references = 0;
  for (const page of snapshot.graph.pages.values()) {
    references += countEditorialContentReferences(page.content);
  }
  references += snapshot.graph.featuredReferenceCount;
  for (const image of snapshot.graph.galleryImages) {
    if (image.imageUrl !== null) {
      references += 1;
    }
    if (image.thumbUrl !== null) {
      references += 1;
    }
  }
  if (references > limits.evidence.maxEvidenceReferences) {
    throw new EditorialImportError("evidence-reference-limit");
  }
}

export function mapEditorialCandidates(
  snapshot: EditorialSourceSnapshot,
  limits: EditorialImportLimits
) {
  assertEditorialMappingLimits(snapshot, limits);
  const relations = deriveEditorialRelations(snapshot);
  const attachmentPaths = attachmentPathIndex(snapshot);
  const records = [...snapshot.graph.pages.keys()]
    .sort(numericIdSort)
    .map((sourceId) =>
      mapPageCandidate(sourceId, snapshot, relations, attachmentPaths, limits)
    );
  const galleryMapping = mapGalleryCandidates(snapshot, limits);
  return {
    records,
    galleries: galleryMapping.records,
    gallery: galleryMapping.records[0] ?? null,
    galleryIssueCodes: galleryMapping.issueCodes,
    relations
  };
}

export function mapEditorialOutcomes(
  snapshot: EditorialSourceSnapshot,
  limits: EditorialImportLimits,
  fingerprint: (record: string | object) => string
): {
  readonly outcomes: readonly EditorialCandidateOutcome[];
  readonly gallery: EditorialGalleryOutcome | null;
  readonly galleries: readonly EditorialGalleryOutcome[];
  readonly galleryIssueCodes: readonly EditorialIssueCode[];
  readonly relations: EditorialRelations;
} {
  const mapped = mapEditorialCandidates(snapshot, limits);
  const galleries = mapped.galleries.map((record) => ({
    sourceId: record.sourceId,
    sourceKind: record.kind === "wordpress-bwg-gallery-candidate"
      ? "gallery" as const
      : "unassigned-image" as const,
    record,
    fingerprint: fingerprint(record)
  }));
  return {
    outcomes: mapped.records.map((record) => ({
      sourceId: record.sourceId,
      locale: record.locale,
      status: record.status,
      publication: record.publication,
      issueCodes: record.issueCodes,
      record,
      fingerprint: fingerprint(record)
    })),
    gallery: galleries[0] ?? null,
    galleries,
    galleryIssueCodes: mapped.galleryIssueCodes,
    relations: mapped.relations
  };
}

export type { EditorialRelations };
