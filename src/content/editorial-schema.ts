import { z } from "zod";
import { localeSchema, localeValues } from "./schema";
import { localPathKey, validateSafeLocalPath } from "./url-path";
import {
  editorialManagedMediaPrefix,
  galleryManagedMediaPrefix,
  validatePublicManagedMediaPath
} from "./editorial-media-path";

export { localeSchema, localeValues };
export {
  editorialManagedMediaPrefix,
  galleryManagedMediaPrefix
} from "./editorial-media-path";
export type { Locale } from "./schema";
/**
 * Public content is deliberately bounded at the content boundary. These
 * limits keep malformed exports and hand-authored records predictable before
 * they reach a renderer.
 */
export const publicContentLimits = Object.freeze({
  maxFileBytes: 1_048_576,
  maxRecords: 256,
  maxBlocks: 256,
  maxInlineDepth: 3, // leaf -> styled -> link
  maxBlockquoteDepth: 1, // blockquote children exclude blockquotes
  maxInlineChildren: 256,
  maxListItems: 128,
  maxImageGridImages: 128,
  maxCardGridItems: 512,
  maxGalleryImages: 512,
  maxMedia: 512,
  maxRedirects: 256,
  maxStringLength: 4_096
});

export type PublicContentLimits = typeof publicContentLimits;

const renderableHtmlMarkup =
  /(?:<!--|<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?\/?\s*>)/u;
const boundedStringSchema = z.string().max(publicContentLimits.maxStringLength);
const nonEmptyStringSchema = boundedStringSchema.min(1);
export const mediaIdSchema = nonEmptyStringSchema;
export const positiveIntegerSchema = z.number().int().positive().safe();
function customIssue(message: string, path?: PropertyKey[]) {
  return path === undefined
    ? { code: "custom" as const, message }
    : { code: "custom" as const, message, path };
}
function validationIssue(error: unknown) {
  return customIssue(error instanceof Error ? error.message : String(error));
}
export const editorialPlainTextSchema = nonEmptyStringSchema.superRefine((value, context) => {
  if (renderableHtmlMarkup.test(value)) {
    context.addIssue(customIssue("Rich-text values must not contain raw HTML markup."));
  }
});
function validateCanonicalEditorialPath(value: string, label: string) {
  validateSafeLocalPath(value, label);
  if (value.includes("%")) {
    throw new Error(`${label} must use raw Unicode and must not be percent-encoded: ${value}`);
  }
  if (value.startsWith("//")) {
    throw new Error(`${label} must have exactly one leading separator: ${value}`);
  }
  if (value !== "/" && (!value.endsWith("/") || value.endsWith("//"))) {
    throw new Error(`${label} must have a trailing slash: ${value}`);
  }
  const interiorSegments = value.split("/").slice(1, -1);
  if (interiorSegments.some((segment) => segment.length === 0)) {
    throw new Error(`${label} must not contain empty interior segments: ${value}`);
  }
}
function validatedPathSchema(
  label: string,
  validate: (value: string, label: string) => void
) {
  return boundedStringSchema.min(1).superRefine((value, context) => {
    try {
      validate(value, label);
    } catch (error) {
      context.addIssue(validationIssue(error));
    }
  });
}
export const editorialCanonicalPathSchema = validatedPathSchema(
  "Editorial canonical path",
  validateCanonicalEditorialPath
);
export const editorialRedirectFromPathSchema = validatedPathSchema(
  "Editorial redirect source",
  (value, label) => {
    validateSafeLocalPath(value, label);
    if (value === "/") {
      throw new Error("Editorial redirect source cannot be the site root.");
    }
  }
);
export const editorialLinkHrefSchema = boundedStringSchema.min(1).superRefine((value, context) => {
  if (value.startsWith("/")) {
    try {
      validateSafeLocalPath(value, "Editorial link");
    } catch (error) {
      context.addIssue(validationIssue(error));
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue(customIssue(`Editorial link is not a valid URL: ${value}`));
    return;
  }

  if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
    context.addIssue(customIssue(`Editorial link uses an unsafe URL scheme: ${url.protocol}`));
  }
});

const richTextTextNodeSchema = z.strictObject({
  type: z.literal("text"),
  value: editorialPlainTextSchema
});
const richTextCodeNodeSchema = z.strictObject({
  type: z.literal("code"),
  value: editorialPlainTextSchema
});
const richTextBreakNodeSchema = z.strictObject({
  type: z.literal("break")
});
const richTextLeafSchema = z.discriminatedUnion("type", [
  richTextTextNodeSchema,
  richTextCodeNodeSchema,
  richTextBreakNodeSchema
]);
const boundedLeafChildrenSchema = z.array(richTextLeafSchema)
  .min(1)
  .max(publicContentLimits.maxInlineChildren);
const richTextEmphasisNodeSchema = z.strictObject({
  type: z.literal("emphasis"),
  children: boundedLeafChildrenSchema
});
const richTextStrongNodeSchema = z.strictObject({
  type: z.literal("strong"),
  children: boundedLeafChildrenSchema
});
const richTextLinkChildSchema = z.discriminatedUnion("type", [
  richTextTextNodeSchema,
  richTextCodeNodeSchema,
  richTextBreakNodeSchema,
  richTextEmphasisNodeSchema,
  richTextStrongNodeSchema
]);
const boundedLinkChildrenSchema = z.array(richTextLinkChildSchema)
  .min(1)
  .max(publicContentLimits.maxInlineChildren);
const richTextLinkNodeSchema = z.strictObject({
  type: z.literal("link"),
  href: editorialLinkHrefSchema,
  children: boundedLinkChildrenSchema
});
export const richTextInlineSchema = z.discriminatedUnion("type", [
  richTextTextNodeSchema,
  richTextCodeNodeSchema,
  richTextBreakNodeSchema,
  richTextEmphasisNodeSchema,
  richTextStrongNodeSchema,
  richTextLinkNodeSchema
]);
const boundedInlineChildrenSchema = z.array(richTextInlineSchema)
  .min(1)
  .max(publicContentLimits.maxInlineChildren);
const richTextParagraphSchema = z.strictObject({
  type: z.literal("paragraph"),
  children: boundedInlineChildrenSchema
});
const richTextHeadingSchema = z.strictObject({
  type: z.literal("heading"),
  level: z.number().int().min(1).max(6),
  children: boundedInlineChildrenSchema
});
const richTextListItemSchema = z.strictObject({
  children: boundedInlineChildrenSchema
});
const richTextListSchema = z.strictObject({
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(richTextListItemSchema)
    .min(1)
    .max(publicContentLimits.maxListItems)
});
const richTextBlockquoteChildSchema = z.discriminatedUnion("type", [
  richTextParagraphSchema,
  richTextListSchema
]);
const richTextBlockquoteSchema = z.strictObject({
  type: z.literal("blockquote"),
  children: z.array(richTextBlockquoteChildSchema)
    .min(1)
    .max(publicContentLimits.maxBlocks)
});
const richTextImageFields = {
  mediaId: editorialPlainTextSchema,
  alt: editorialPlainTextSchema.nullable(),
  caption: editorialPlainTextSchema.nullable()
};
const richTextImageSchema = z.strictObject({
  type: z.literal("image"),
  ...richTextImageFields
});
const richTextImageGridEntrySchema = z.strictObject(richTextImageFields);
const richTextImageGridSchema = z.strictObject({
  type: z.literal("imageGrid"),
  images: z.array(richTextImageGridEntrySchema)
    .min(1)
    .max(publicContentLimits.maxImageGridImages)
});
export const emptyCardGridReasonSchema = z.enum([
  "source-category-missing"
]);
export type EmptyCardGridReason = z.infer<typeof emptyCardGridReasonSchema>;
export const emptyCardGridSchema = z.strictObject({
  type: z.literal("emptyCardGrid"),
  reason: emptyCardGridReasonSchema
});
function uniqueReferenceIds(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  label: string
) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue(customIssue(
        `Duplicate ${label} reference: ${value}`,
        [...path, index]
      ));
    }
    seen.add(value);
  }
}
const recipeCardGridSchema = z.strictObject({
  type: z.literal("recipeCardGrid"),
  recipeIds: z.array(mediaIdSchema)
    .min(1)
    .max(publicContentLimits.maxCardGridItems)
}).superRefine((block, context) => {
  uniqueReferenceIds(block.recipeIds, context, ["recipeIds"], "recipe card");
});
const editorialPageCardGridSchema = z.strictObject({
  type: z.literal("editorialPageCardGrid"),
  pageIds: z.array(mediaIdSchema)
    .min(1)
    .max(publicContentLimits.maxCardGridItems)
}).superRefine((block, context) => {
  uniqueReferenceIds(block.pageIds, context, ["pageIds"], "editorial page card");
});
const galleryCalloutSchema = z.strictObject({
  type: z.literal("galleryCallout"),
  galleryId: mediaIdSchema
});
const contactFormSchema = z.strictObject({
  type: z.literal("contactForm")
});
export const richTextBlockSchema = z.discriminatedUnion("type", [
  richTextParagraphSchema,
  richTextHeadingSchema,
  richTextListSchema,
  richTextBlockquoteSchema,
  richTextImageSchema,
  richTextImageGridSchema,
  emptyCardGridSchema,
  recipeCardGridSchema,
  editorialPageCardGridSchema,
  galleryCalloutSchema,
  contactFormSchema
]);
export type RichTextInline = z.infer<typeof richTextInlineSchema>;
export type RichTextBlock = z.infer<typeof richTextBlockSchema>;

const supportedImageMimeTypes = [
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
] as const;
export const publicImageMimeTypeSchema = z.enum(supportedImageMimeTypes);
export const publicManagedMediaPathSchema = boundedStringSchema.min(1).superRefine((value, context) => {
  try {
    validatePublicManagedMediaPath(value, "Public media path");
  } catch (error) {
    context.addIssue(validationIssue(error));
  }
});
function mediaPathWithPrefixSchema(prefix: string, label: string) {
  return publicManagedMediaPathSchema.superRefine((value, context) => {
    if (!value.startsWith(prefix)) {
      context.addIssue(customIssue(`${label} must use ${prefix}.`));
    }
  });
}
export const editorialManagedMediaPathSchema = mediaPathWithPrefixSchema(
  editorialManagedMediaPrefix,
  "Editorial media path"
);
export const galleryManagedMediaPathSchema = mediaPathWithPrefixSchema(
  galleryManagedMediaPrefix,
  "Gallery media path"
);

export const publicMediaSourceSchema = z.discriminatedUnion("system", [
  z.strictObject({
    system: z.literal("wordpress"),
    attachmentId: positiveIntegerSchema
  }),
  z.strictObject({
    system: z.literal("wordpress-bwg"),
    imageId: positiveIntegerSchema
  })
]);
export const publicMediaObjectSchema = z.strictObject({
  id: mediaIdSchema,
  path: publicManagedMediaPathSchema,
  source: publicMediaSourceSchema,
  mimeType: publicImageMimeTypeSchema,
  width: positiveIntegerSchema.nullable(),
  height: positiveIntegerSchema.nullable()
}).superRefine((media, context) => {
  const prefix = media.source.system === "wordpress"
    ? editorialManagedMediaPrefix
    : galleryManagedMediaPrefix;
  if (!media.path.startsWith(prefix)) {
    context.addIssue(customIssue(
      `Public media path must match its source system prefix ${prefix}.`,
      ["path"]
    ));
  }
});
export type PublicMediaSource = z.infer<typeof publicMediaSourceSchema>;
export type PublicMediaObject = z.infer<typeof publicMediaObjectSchema>;
export type EditorialMediaReference = PublicMediaObject;
export const editorialMediaReferenceSchema = publicMediaObjectSchema;
export function editorialMediaReferenceId(reference: EditorialMediaReference) {
  return reference.id;
}

export const editorialSourceSchema = z.strictObject({
  system: z.literal("wordpress"),
  postId: positiveIntegerSchema,
  sourcePath: editorialCanonicalPathSchema,
  sourceSlug: nonEmptyStringSchema.nullable(),
  createdAt: boundedStringSchema.datetime({ offset: true }).nullable(),
  modifiedAt: boundedStringSchema.datetime({ offset: true }).nullable()
});
export const editorialPageRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("editorial-page"),
  id: mediaIdSchema,
  locale: localeSchema,
  canonicalPath: editorialCanonicalPathSchema,
  translationGroupId: mediaIdSchema.nullable(),
  source: editorialSourceSchema,
  title: editorialPlainTextSchema.nullable(),
  excerpt: editorialPlainTextSchema.nullable(),
  publishedAt: boundedStringSchema.datetime({ offset: true }).nullable(),
  modifiedAt: boundedStringSchema.datetime({ offset: true }).nullable(),
  content: z.array(richTextBlockSchema)
    .max(publicContentLimits.maxBlocks)
    .nullable(),
  featuredMediaId: mediaIdSchema.nullable(),
  featuredMediaAlt: editorialPlainTextSchema.nullable(),
  media: z.array(publicMediaObjectSchema)
    .max(publicContentLimits.maxMedia)
    .nullable(),
  redirectFrom: z.array(editorialRedirectFromPathSchema)
    .max(publicContentLimits.maxRedirects)
    .nullable()
}).superRefine((record, context) => {
  const addIssue = (message: string, path?: PropertyKey[]) =>
    context.addIssue(customIssue(message, path));
  const localePrefix = `/${record.locale}/`;
  if (record.locale === "en") {
    if (localeValues.some((locale) =>
      record.canonicalPath.startsWith(`/${locale}/`)
    )) {
      addIssue(
        "English editorial canonical paths must not start with a locale prefix.",
        ["canonicalPath"]
      );
    }
  } else if (!record.canonicalPath.startsWith(localePrefix)) {
    addIssue(
      `Editorial ${record.locale} canonical paths must start with ${localePrefix}.`,
      ["canonicalPath"]
    );
  }

  if (record.source.sourcePath !== record.canonicalPath) {
    addIssue(
      "Editorial sourcePath must match canonicalPath.",
      ["source", "sourcePath"]
    );
  }

  const blockCount = countRichTextBlocks(record.content);
  if (blockCount > publicContentLimits.maxBlocks) {
    addIssue(
      `Rich-text block count exceeds maximum ${publicContentLimits.maxBlocks}.`,
      ["content"]
    );
  }

  const mediaIds = new Map<string, number>();
  for (const [index, media] of (record.media ?? []).entries()) {
    if (media.source.system !== "wordpress") {
      addIssue(
        "Editorial media must use a WordPress attachment source.",
        ["media", index, "source"]
      );
    }
    if (mediaIds.has(media.id)) {
      addIssue(
        `Duplicate editorial media ID: ${media.id}`,
        ["media", index]
      );
    } else {
      mediaIds.set(media.id, index);
    }
  }

  const referencedMediaIds = collectRichTextMediaIds(record.content);
  if (record.featuredMediaId !== null) {
    referencedMediaIds.add(record.featuredMediaId);
  }

  for (const mediaId of referencedMediaIds) {
    if (!mediaIds.has(mediaId)) {
      addIssue(
        `Unknown editorial media reference: ${mediaId}`,
        ["featuredMediaId"]
      );
    }
  }

  for (const [mediaId, index] of mediaIds) {
    if (!referencedMediaIds.has(mediaId)) {
      addIssue(
        `Editorial media reference is not used by featured or content usage: ${mediaId}`,
        ["media", index]
      );
    }
  }

  let canonicalKey: string | undefined;
  try {
    canonicalKey = localPathKey(record.canonicalPath);
  } catch {
    // The path schema reports an unsafe canonical route.
  }
  const redirectKeys = new Set<string>();
  for (const [index, redirectFrom] of (record.redirectFrom ?? []).entries()) {
    let redirectKey: string | undefined;
    try {
      redirectKey = localPathKey(redirectFrom);
    } catch {
      // The path schema reports the unsafe redirect source.
      continue;
    }
    if (canonicalKey !== undefined && redirectKey === canonicalKey) {
      addIssue(
        `Editorial redirect source must not equal the canonical route: ${redirectFrom}`,
        ["redirectFrom", index]
      );
    }
    if (redirectKeys.has(redirectKey)) {
      addIssue(
        `Duplicate editorial redirect source: ${redirectFrom}`,
        ["redirectFrom", index]
      );
    }
    redirectKeys.add(redirectKey);
  }
});

export type EditorialSource = z.infer<typeof editorialSourceSchema>;
export type EditorialPageRecord = z.infer<typeof editorialPageRecordSchema>;
export type EditorialRecord = EditorialPageRecord;

export const editorialRecordSchema = editorialPageRecordSchema;

export function collectRichTextMediaIds(
  blocks: readonly RichTextBlock[] | null
): Set<string> {
  const mediaIds = new Set<string>();
  for (const block of blocks ?? []) {
    if (block.type === "image") {
      mediaIds.add(block.mediaId);
    } else if (block.type === "imageGrid") {
      for (const image of block.images) {
        mediaIds.add(image.mediaId);
      }
    }
  }
  return mediaIds;
}

export type EditorialBlockReferences = {
  readonly recipeIds: Set<string>;
  readonly pageIds: Set<string>;
  readonly galleryIds: Set<string>;
};

export function collectEditorialBlockReferences(
  blocks: readonly RichTextBlock[] | null
): EditorialBlockReferences {
  const recipeIds = new Set<string>();
  const pageIds = new Set<string>();
  const galleryIds = new Set<string>();
  for (const block of blocks ?? []) {
    if (block.type === "recipeCardGrid") {
      for (const recipeId of block.recipeIds) {
        recipeIds.add(recipeId);
      }
    } else if (block.type === "editorialPageCardGrid") {
      for (const pageId of block.pageIds) {
        pageIds.add(pageId);
      }
    } else if (block.type === "galleryCallout") {
      galleryIds.add(block.galleryId);
    }
  }
  return { recipeIds, pageIds, galleryIds };
}

function countRichTextBlocks(
  blocks: readonly RichTextBlock[] | null
) {
  let count = 0;
  for (const block of blocks ?? []) {
    count += 1;
    if (block.type === "blockquote") {
      count += block.children.length;
    }
  }
  return count;
}
