import path from "node:path";
import { z } from "zod";
import {
  publicImageMimeTypeSchema,
  publicManagedMediaPathSchema
} from "../../src/content/editorial-schema";
import {
  WprmMediaUploadPlanError,
  stageAuthenticatedMediaUploadPlan,
  type AuthenticatedMediaUploadStagingResult
} from "./wprm-media-upload-plan";
import {
  EditorialPromotionRunnerError,
  withAuthenticatedEditorialMediaPlan,
  type EditorialPromotionOptions
} from "./editorial-promotion-runner";

const maxEntries = 20_000;

const uploadEntrySchema = z.strictObject({
  key: publicManagedMediaPathSchema,
  bytes: z.number().int().positive().max(1_000_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  contentType: publicImageMimeTypeSchema
});

export const editorialGalleryMediaUploadPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("editorial-gallery-media-upload-plan"),
  entries: z.array(uploadEntrySchema).max(maxEntries)
}).superRefine((plan, context) => {
  let previous: string | undefined;
  for (const [index, entry] of plan.entries.entries()) {
    if (previous !== undefined && previous >= entry.key) {
      context.addIssue({
        code: "custom",
        message: `Editorial/gallery upload keys must be strictly sorted and unique: ${entry.key}`,
        path: ["entries", index, "key"]
      });
    }
    previous = entry.key;
  }
});

export type EditorialGalleryMediaUploadPlan = z.infer<
  typeof editorialGalleryMediaUploadPlanSchema
>;

export type EditorialMediaUploadPlanOptions = Omit<
  EditorialPromotionOptions,
  "failureInjection" | "onPromotionLockAcquired" | "write"
> & {
  readonly dryRun?: boolean;
  readonly resume?: boolean;
  readonly uploadDir: string;
  readonly write?: boolean;
};

export type EditorialMediaUploadPlanResult = {
  readonly schemaVersion: 1;
  readonly kind: "editorial-gallery-media-upload-plan-result";
  readonly mode: "dry-run" | "write";
  readonly objects: {
    readonly count: number;
    readonly bytes: number;
    readonly created: number;
    readonly reused: number;
  };
};

export class EditorialMediaUploadPlanError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The editorial/gallery media upload plan failed.");
    this.name = "EditorialMediaUploadPlanError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new EditorialMediaUploadPlanError(code);
}

function contentType(key: string) {
  switch (path.posix.extname(key).toLowerCase()) {
    case ".avif":
      return "image/avif" as const;
    case ".gif":
      return "image/gif" as const;
    case ".jpeg":
    case ".jpg":
      return "image/jpeg" as const;
    case ".png":
      return "image/png" as const;
    case ".webp":
      return "image/webp" as const;
    default:
      fail("unsupported-editorial-media-extension");
  }
}

function uploadManifest(
  entries: Parameters<typeof createEditorialGalleryMediaUploadPlan>[0]
) {
  return `${JSON.stringify(createEditorialGalleryMediaUploadPlan(entries), null, 2)}\n`;
}

export function createEditorialGalleryMediaUploadPlan(
  entries: readonly {
    readonly bytes: number;
    readonly key: string;
    readonly sha256: string;
  }[]
): EditorialGalleryMediaUploadPlan {
  return editorialGalleryMediaUploadPlanSchema.parse({
    schemaVersion: 1,
    kind: "editorial-gallery-media-upload-plan",
    entries: entries
      .map((entry) => ({
        bytes: entry.bytes,
        key: entry.key,
        sha256: entry.sha256,
        contentType: contentType(entry.key)
      }))
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  });
}

function result(staged: AuthenticatedMediaUploadStagingResult): EditorialMediaUploadPlanResult {
  return {
    schemaVersion: 1,
    kind: "editorial-gallery-media-upload-plan-result",
    mode: staged.mode,
    objects: staged.objects
  };
}

export async function createEditorialMediaUploadPlan(
  options: EditorialMediaUploadPlanOptions
): Promise<EditorialMediaUploadPlanResult> {
  const write = options.write === true;
  const dryRun = options.dryRun === true;
  if (write === dryRun || (options.resume === true && !write)) {
    fail("invalid-upload-plan-mode");
  }
  try {
    return await withAuthenticatedEditorialMediaPlan(
      {
        ...options,
        write: false
      },
      async (authenticated) => {
        const manifest = uploadManifest(authenticated.entries);
        let staged: AuthenticatedMediaUploadStagingResult;
        try {
          staged = await stageAuthenticatedMediaUploadPlan(
            {
              repositoryRoot: authenticated.repositoryRoot,
              uploadDir: options.uploadDir,
              dryRun,
              write,
              resume: options.resume,
              uploadManifest: manifest
            },
            authenticated
          );
        } catch (error) {
          if (error instanceof WprmMediaUploadPlanError) {
            throw new EditorialPromotionRunnerError(error.code);
          }
          throw error;
        }
        return result(staged);
      }
    );
  } catch (error) {
    if (error instanceof EditorialPromotionRunnerError) {
      fail(error.code);
    }
    if (error instanceof EditorialMediaUploadPlanError) {
      throw error;
    }
    fail("editorial-media-upload-plan-failed");
  }
}

export function serializeEditorialMediaUploadPlanResult(result: EditorialMediaUploadPlanResult) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
