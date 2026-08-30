import { z } from "zod";
import {
  editorialPlainTextSchema,
  galleryManagedMediaPrefix,
  mediaIdSchema,
  positiveIntegerSchema,
  publicMediaObjectSchema,
  publicContentLimits,
  type EditorialMediaReference,
  type PublicMediaObject
} from "./editorial-schema";

export const galleryCanonicalPath = "/gallery/";

export const gallerySourceSchema = z.strictObject({
  system: z.literal("wordpress-bwg"),
  galleryId: positiveIntegerSchema
});

export const galleryImageEntrySchema = z.strictObject({
  sourceImageId: positiveIntegerSchema,
  originalMediaId: mediaIdSchema,
  thumbnailMediaId: mediaIdSchema.nullable(),
  caption: editorialPlainTextSchema.nullable(),
  alt: editorialPlainTextSchema.nullable()
});

function galleryMediaMatchesImage(
  media: PublicMediaObject | undefined,
  sourceImageId: number,
  role: "original" | "thumbnail"
) {
  return media?.source.system === "wordpress-bwg"
    && media.source.imageId === sourceImageId
    && media.path.startsWith(
      `${galleryManagedMediaPrefix}${sourceImageId}-${role}.`
    );
}

export const galleryRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("gallery"),
  id: mediaIdSchema,
  locale: z.null(),
  canonicalPath: z.literal(galleryCanonicalPath),
  source: gallerySourceSchema,
  title: editorialPlainTextSchema.nullable(),
  description: editorialPlainTextSchema.nullable(),
  featuredMediaId: mediaIdSchema.nullable(),
  media: z.array(publicMediaObjectSchema)
    .max(publicContentLimits.maxMedia)
    .nullable(),
  images: z.array(galleryImageEntrySchema)
    .max(publicContentLimits.maxGalleryImages)
}).superRefine((record, context) => {
  const mediaIds = new Map<string, number>();
  for (const [index, media] of (record.media ?? []).entries()) {
    if (media.source.system !== "wordpress-bwg") {
      context.addIssue({
        code: "custom",
        message: "Gallery media must use a BWG image source.",
        path: ["media", index, "source"]
      });
    }
    if (mediaIds.has(media.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate gallery media ID: ${media.id}`,
        path: ["media", index]
      });
    } else {
      mediaIds.set(media.id, index);
    }
  }

  const referencedMediaIds = collectGalleryMediaIds(record.images);
  if (record.featuredMediaId !== null) {
    referencedMediaIds.add(record.featuredMediaId);
  }

  for (const mediaId of referencedMediaIds) {
    if (!mediaIds.has(mediaId)) {
      context.addIssue({
        code: "custom",
        message: `Unknown gallery media reference: ${mediaId}`,
        path: ["featuredMediaId"]
      });
    }
  }

  for (const [index, image] of record.images.entries()) {
    if (!galleryMediaMatchesImage(
      mediaIds.has(image.originalMediaId)
        ? (record.media ?? []).find((media) => media.id === image.originalMediaId)
        : undefined,
      image.sourceImageId,
      "original"
    )) {
      context.addIssue({
        code: "custom",
        message: "Gallery original media must match its source image and original role.",
        path: ["images", index, "originalMediaId"]
      });
    }
    if (
      image.thumbnailMediaId !== null
      && !galleryMediaMatchesImage(
        mediaIds.has(image.thumbnailMediaId)
          ? (record.media ?? []).find((media) => media.id === image.thumbnailMediaId)
          : undefined,
        image.sourceImageId,
        "thumbnail"
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Gallery thumbnail media must match its source image and thumbnail role.",
        path: ["images", index, "thumbnailMediaId"]
      });
    }
  }

  for (const [mediaId, index] of mediaIds) {
    if (!referencedMediaIds.has(mediaId)) {
      context.addIssue({
        code: "custom",
        message: `Gallery media reference is not used by featured or an image: ${mediaId}`,
        path: ["media", index]
      });
    }
  }
});

export type GallerySource = z.infer<typeof gallerySourceSchema>;
export type GalleryImageEntry = z.infer<typeof galleryImageEntrySchema>;
export type GalleryRecord = z.infer<typeof galleryRecordSchema>;
export type GalleryMediaReference = EditorialMediaReference;
export type GalleryMediaObject = PublicMediaObject;

export const gallerySchema = galleryRecordSchema;

export function collectGalleryMediaIds(
  images: readonly GalleryImageEntry[]
): Set<string> {
  const mediaIds = new Set<string>();
  for (const image of images) {
    mediaIds.add(image.originalMediaId);
    if (image.thumbnailMediaId !== null) {
      mediaIds.add(image.thumbnailMediaId);
    }
  }
  return mediaIds;
}
