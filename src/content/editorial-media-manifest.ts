import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  editorialManagedMediaPrefix,
  galleryManagedMediaPrefix,
  publicManagedMediaPathSchema,
  publicMediaSourceSchema,
  type EditorialPageRecord,
  type PublicMediaSource
} from "./editorial-schema";
import type { GalleryRecord } from "./gallery-schema";

export const defaultEditorialGalleryMediaManifestPath = path.resolve(
  process.cwd(),
  "content",
  "editorial-gallery-media-manifest.json"
);
export const maxEditorialGalleryMediaManifestEntries = 20_000;
const maxEditorialGalleryMediaManifestBytes = 8 * 1024 * 1024;
const sha256 = /^[a-f0-9]{64}$/u;

function sourceMatchesPath(pathValue: string, source: PublicMediaSource) {
  const editorial = new RegExp(
    `^${editorialManagedMediaPrefix}(?<id>[1-9]\\d*)\\.(?:avif|gif|jpe?g|png|webp)$`,
    "u"
  ).exec(pathValue);
  if (editorial !== null) {
    return source.system === "wordpress"
      && editorial.groups?.id === String(source.attachmentId);
  }
  const gallery = new RegExp(
    `^${galleryManagedMediaPrefix}(?<id>[1-9]\\d*)-(?:original|thumbnail)\\.(?:avif|gif|jpe?g|png|webp)$`,
    "u"
  ).exec(pathValue);
  return gallery !== null
    && source.system === "wordpress-bwg"
    && gallery.groups?.id === String(source.imageId);
}

export const editorialGalleryMediaManifestEntrySchema = z.strictObject({
  key: publicManagedMediaPathSchema,
  bytes: z.number().int().positive().max(1_000_000_000),
  sha256: z.string().regex(sha256),
  source: publicMediaSourceSchema
}).superRefine((entry, context) => {
  if (!sourceMatchesPath(entry.key, entry.source)) {
    context.addIssue({
      code: "custom",
      message: `Editorial/gallery media manifest source does not match key: ${entry.key}`,
      path: ["source"]
    });
  }
});

export const editorialGalleryMediaManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("editorial-gallery-media-manifest"),
  entries: z.array(editorialGalleryMediaManifestEntrySchema)
    .max(maxEditorialGalleryMediaManifestEntries)
}).superRefine((manifest, context) => {
  let previous: string | undefined;
  for (const [index, entry] of manifest.entries.entries()) {
    if (previous !== undefined && previous >= entry.key) {
      context.addIssue({
        code: "custom",
        message: `Editorial/gallery media manifest keys must be strictly sorted and unique: ${entry.key}`,
        path: ["entries", index, "key"]
      });
    }
    previous = entry.key;
  }
});

export type EditorialGalleryMediaManifest = z.infer<
  typeof editorialGalleryMediaManifestSchema
>;
export type EditorialGalleryMediaManifestEntry = z.infer<
  typeof editorialGalleryMediaManifestEntrySchema
>;

export function createEditorialGalleryMediaManifest(
  entries: readonly EditorialGalleryMediaManifestEntry[]
): EditorialGalleryMediaManifest {
  return editorialGalleryMediaManifestSchema.parse({
    schemaVersion: 1,
    kind: "editorial-gallery-media-manifest",
    entries: [...entries].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0
    )
  });
}

export function parseEditorialGalleryMediaManifest(value: unknown) {
  return editorialGalleryMediaManifestSchema.parse(value);
}

export function loadEditorialGalleryMediaManifest(
  manifestPath: string = defaultEditorialGalleryMediaManifestPath
) {
  let bytes: Buffer;
  try {
    const stats = lstatSync(manifestPath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.size > maxEditorialGalleryMediaManifestBytes
    ) {
      throw new Error("manifest is not a bounded regular file");
    }
    bytes = readFileSync(manifestPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read editorial/gallery media manifest "${manifestPath}": ${message}`,
      { cause: error }
    );
  }
  try {
    return parseEditorialGalleryMediaManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid editorial/gallery media manifest "${manifestPath}": ${message}`,
      { cause: error }
    );
  }
}

function sameSource(left: PublicMediaSource, right: PublicMediaSource) {
  return left.system === right.system
    && (
      left.system === "wordpress"
        ? right.system === "wordpress" && left.attachmentId === right.attachmentId
        : right.system === "wordpress-bwg" && left.imageId === right.imageId
    );
}

export function validateEditorialGalleryMediaManifestClosure(
  editorialRecords: readonly EditorialPageRecord[],
  galleryRecords: readonly GalleryRecord[],
  manifest: EditorialGalleryMediaManifest
) {
  const entries = new Map(manifest.entries.map((entry) => [entry.key, entry] as const));
  const referenced = new Set<string>();
  const media = [
    ...editorialRecords.flatMap((record) => record.media ?? []),
    ...galleryRecords.flatMap((record) => record.media ?? [])
  ];

  for (const object of media) {
    const entry = entries.get(object.path);
    if (entry === undefined || !sameSource(entry.source, object.source)) {
      throw new Error(
        `Promoted editorial/gallery media is absent from the media manifest: ${object.path}`
      );
    }
    referenced.add(object.path);
  }
  for (const entry of manifest.entries) {
    if (!referenced.has(entry.key)) {
      throw new Error(
        `Editorial/gallery media manifest entry is not referenced by public content: ${entry.key}`
      );
    }
  }
}
