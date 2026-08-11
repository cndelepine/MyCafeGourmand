import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RecipeRecord } from "./schema";
import {
  parseWordPressRecipeMediaObjectKey,
  isWordPressRecipeMediaObjectKey
} from "./media";

export const defaultRecipeMediaManifestPath = path.resolve(
  process.cwd(),
  "content",
  "media-manifest.json"
);
export const maxRecipeMediaManifestEntries = 20_000;
const maxRecipeMediaManifestBytes = 8 * 1024 * 1024;

const sha256 = /^[a-f0-9]{64}$/u;
const numericAttachmentId = /^(?:0|[1-9]\d*)$/u;

export const recipeMediaManifestEntrySchema = z.strictObject({
  key: z.string().min(1),
  bytes: z.number().int().positive().max(1_000_000_000),
  sha256: z.string().regex(sha256),
  sourceAttachmentId: z.string().regex(numericAttachmentId)
}).superRefine((entry, context) => {
  try {
    const key = parseWordPressRecipeMediaObjectKey(entry.key, "Media manifest key");
    if (key.attachmentId !== entry.sourceAttachmentId) {
      context.addIssue({
        code: "custom",
        message: `Media manifest attachment ID does not match key: ${entry.key}`,
        path: ["sourceAttachmentId"]
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
      path: ["key"]
    });
  }
});

export const recipeMediaManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("recipe-media-manifest"),
  entries: z.array(recipeMediaManifestEntrySchema).max(maxRecipeMediaManifestEntries)
}).superRefine((manifest, context) => {
  let previous: string | undefined;
  for (const [index, entry] of manifest.entries.entries()) {
    if (previous !== undefined && previous >= entry.key) {
      context.addIssue({
        code: "custom",
        message: `Media manifest keys must be strictly sorted and unique: ${entry.key}`,
        path: ["entries", index, "key"]
      });
    }
    previous = entry.key;
  }
});

export type RecipeMediaManifest = z.infer<typeof recipeMediaManifestSchema>;
export type RecipeMediaManifestEntry = z.infer<typeof recipeMediaManifestEntrySchema>;

function compareObjectKeys(
  left: RecipeMediaManifestEntry,
  right: RecipeMediaManifestEntry
) {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

export function createRecipeMediaManifest(
  entries: readonly RecipeMediaManifestEntry[]
): RecipeMediaManifest {
  return recipeMediaManifestSchema.parse({
    schemaVersion: 1,
    kind: "recipe-media-manifest",
    entries: [...entries].sort(compareObjectKeys)
  });
}

export function parseRecipeMediaManifest(value: unknown) {
  return recipeMediaManifestSchema.parse(value);
}

export function loadRecipeMediaManifest(
  manifestPath: string = defaultRecipeMediaManifestPath
) {
  let bytes: Buffer;
  try {
    const stats = lstatSync(manifestPath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.size > maxRecipeMediaManifestBytes
    ) {
      throw new Error("manifest is not a bounded regular file");
    }
    bytes = readFileSync(manifestPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read recipe media manifest "${manifestPath}": ${message}`, {
      cause: error
    });
  }
  try {
    return parseRecipeMediaManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid recipe media manifest "${manifestPath}": ${message}`, {
      cause: error
    });
  }
}

export function validateRecipeMediaManifestClosure(
  records: readonly RecipeRecord[],
  manifest: RecipeMediaManifest
) {
  const entries = new Map(manifest.entries.map((entry) => [entry.key, entry] as const));
  const referenced = new Set<string>();

  for (const record of records) {
    for (const media of record.media) {
      if (!isWordPressRecipeMediaObjectKey(media.path)) {
        continue;
      }
      if (!entries.has(media.path)) {
        throw new Error(
          `Promoted media for recipe "${record.id}" (${media.id}) is absent from the media manifest: ${media.path}`
        );
      }
      referenced.add(media.path);
    }
  }

  for (const entry of manifest.entries) {
    if (!referenced.has(entry.key)) {
      throw new Error(`Media manifest entry is not referenced by recipe content: ${entry.key}`);
    }
  }
}
