import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createRecipeMediaManifest,
  parseRecipeMediaManifest,
  recipeMediaManifestEntrySchema,
  type RecipeMediaManifest
} from "../../src/content/media-manifest";
import { parseWordPressRecipeMediaObjectKey } from "../../src/content/media";
import {
  WprmPromotionError,
  withAuthenticatedWprmMediaPlan,
  type WprmPromotionOptions
} from "./wprm-promotion";

const maxPrivateUploadManifestBytes = 8 * 1024 * 1024;
const maxPrivateObjectBytes = 1_000_000_000;

const uploadManifestEntrySchema = z.strictObject({
  key: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceAttachmentId: z.string().regex(/^(?:0|[1-9]\d*)$/u),
  contentType: z.enum([
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp"
  ])
}).superRefine((entry, context) => {
  const parsed = recipeMediaManifestEntrySchema.safeParse({
    key: entry.key,
    bytes: entry.bytes,
    sha256: entry.sha256,
    sourceAttachmentId: entry.sourceAttachmentId
  });

  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      message: parsed.error.issues.map((issue) => issue.message).join("; ")
    });
  }
});

export const recipeMediaUploadPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("recipe-media-upload-plan"),
  entries: z.array(uploadManifestEntrySchema).max(20_000)
});

export type RecipeMediaUploadPlan = z.infer<typeof recipeMediaUploadPlanSchema>;

export type WprmMediaUploadPlanOptions = Omit<
  WprmPromotionOptions,
  "failureInjection" | "write"
> & {
  readonly dryRun?: boolean;
  readonly resume?: boolean;
  readonly uploadDir: string;
  readonly write?: boolean;
  readonly writePublicManifest?: boolean;
};

export type WprmMediaUploadPlanResult = {
  readonly schemaVersion: 1;
  readonly kind: "wprm-media-upload-plan-result";
  readonly mode: "dry-run" | "write";
  readonly objects: {
    readonly count: number;
    readonly bytes: number;
    readonly created: number;
    readonly reused: number;
  };
  readonly publicManifest: {
    readonly created: number;
    readonly reused: number;
  };
};

export class WprmMediaUploadPlanError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The WPRM media upload plan failed.");
    this.name = "WprmMediaUploadPlanError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new WprmMediaUploadPlanError(code);
}

function isMissing(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

function isWithin(candidate: string, directory: string) {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

function isPrivateOwned(stats: { readonly mode: number; readonly uid?: number }) {
  if ((stats.mode & 0o077) !== 0) {
    return false;
  }
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

function isOwnedByCurrentUser(stats: { readonly uid?: number }) {
  const currentUid = process.getuid?.();
  return currentUid === undefined
    || (typeof stats.uid === "number" && stats.uid === currentUid);
}

async function existingStats(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    fail("upload-staging-inspection-failed");
  }
}

async function ensurePrivateDirectory(target: string) {
  const stats = await existingStats(target);
  if (stats === null) {
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        fail("upload-staging-create-failed");
      }
    }
  }
  const actual = await existingStats(target);
  if (
    actual === null
    || actual.isSymbolicLink()
    || !actual.isDirectory()
    || !isOwnedByCurrentUser(actual)
    || (actual.mode & 0o022) !== 0
  ) {
    fail("unsafe-upload-staging");
  }
  try {
    await chmod(target, 0o700);
  } catch {
    fail("unsafe-upload-staging");
  }
  const verified = await existingStats(target);
  if (
    verified === null
    || verified.isSymbolicLink()
    || !verified.isDirectory()
    || !isPrivateOwned(verified)
    || (verified.mode & 0o777) !== 0o700
  ) {
    fail("unsafe-upload-staging");
  }
}

async function ensurePrivateDirectoryChain(root: string, destination: string) {
  if (!isWithin(destination, root)) {
    fail("unsafe-upload-staging");
  }
  await ensurePrivateDirectory(root);
  const relative = path.relative(root, destination);
  if (relative === "") {
    return;
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part.length === 0 || part === "." || part === "..") {
      fail("unsafe-upload-staging");
    }
    current = path.join(current, part);
    await ensurePrivateDirectory(current);
  }
}

async function resolveUploadDirectories(
  repositoryRoot: string,
  uploadDir: string
) {
  if (path.isAbsolute(uploadDir)) {
    fail("unsafe-upload-staging");
  }
  const migrationOutput = path.join(repositoryRoot, "migration-output");
  const root = path.resolve(repositoryRoot, uploadDir);
  if (!isWithin(root, migrationOutput) || root === migrationOutput) {
    fail("unsafe-upload-staging");
  }
  await ensurePrivateDirectoryChain(migrationOutput, root);
  const objects = path.join(root, "objects");
  await ensurePrivateDirectoryChain(root, objects);
  return {
    root,
    objects,
    manifest: path.join(root, "upload-manifest.json")
  };
}

function objectDestination(objectsRoot: string, objectKey: string) {
  const parsed = parseWordPressRecipeMediaObjectKey(objectKey);
  const destination = path.resolve(objectsRoot, ...parsed.key.slice(1).split("/"));
  if (!isWithin(destination, objectsRoot)) {
    fail("unsafe-upload-staging");
  }
  return destination;
}

function contentType(objectKey: string) {
  const { extension } = parseWordPressRecipeMediaObjectKey(objectKey);
  if (extension === "avif") {
    return "image/avif" as const;
  }
  if (extension === "gif") {
    return "image/gif" as const;
  }
  if (extension === "jpeg" || extension === "jpg") {
    return "image/jpeg" as const;
  }
  if (extension === "png") {
    return "image/png" as const;
  }
  return "image/webp" as const;
}

function buildUploadManifest(manifest: RecipeMediaManifest): RecipeMediaUploadPlan {
  return recipeMediaUploadPlanSchema.parse({
    schemaVersion: 1,
    kind: "recipe-media-upload-plan",
    entries: manifest.entries.map((entry) => ({
      ...entry,
      contentType: contentType(entry.key)
    }))
  });
}

function serialized(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readPrivateFile(target: string) {
  const stats = await existingStats(target);
  if (
    stats === null
    || stats.isSymbolicLink()
    || !stats.isFile()
    || stats.size > maxPrivateUploadManifestBytes
    || !isPrivateOwned(stats)
    || (stats.mode & 0o777) !== 0o600
  ) {
    fail("unsafe-upload-staging");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || !isPrivateOwned(opened)
      || (opened.mode & 0o777) !== 0o600
      || opened.size > maxPrivateUploadManifestBytes
    ) {
      fail("unsafe-upload-staging");
    }
    return {
      bytes: await handle.readFile(),
      stats: opened
    };
  } catch (error) {
    if (error instanceof WprmMediaUploadPlanError) {
      throw error;
    }
    fail("unsafe-upload-staging");
  } finally {
    await handle?.close();
  }
}

async function hashPrivateObject(target: string) {
  const initial = await existingStats(target);
  if (
    initial === null
    || initial.isSymbolicLink()
    || !initial.isFile()
    || initial.size > maxPrivateObjectBytes
    || !isPrivateOwned(initial)
    || (initial.mode & 0o777) !== 0o600
  ) {
    fail("unsafe-upload-staging");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || !isPrivateOwned(opened)
      || (opened.mode & 0o777) !== 0o600
      || opened.size > maxPrivateObjectBytes
      || opened.dev !== initial.dev
      || opened.ino !== initial.ino
      || opened.size !== initial.size
    ) {
      fail("unsafe-upload-staging");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position);
      if (read.bytesRead === 0) {
        fail("unsafe-upload-staging");
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const actual = await existingStats(target);
    if (
      actual === null
      || actual.isSymbolicLink()
      || !actual.isFile()
      || actual.dev !== opened.dev
      || actual.ino !== opened.ino
      || actual.size !== opened.size
    ) {
      fail("unsafe-upload-staging");
    }
    return {
      bytes: opened.size,
      sha256: hash.digest("hex")
    };
  } catch (error) {
    if (error instanceof WprmMediaUploadPlanError) {
      throw error;
    }
    fail("unsafe-upload-staging");
  } finally {
    await handle?.close();
  }
}

async function writePrivateText(
  target: string,
  content: string,
  resume: boolean
) {
  const existing = await existingStats(target);
  if (existing !== null) {
    const value = await readPrivateFile(target);
    if (!resume || value.bytes.toString("utf8") !== content) {
      fail("upload-staging-conflict");
    }
    return false;
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(16).toString("hex")}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the write failure.
    }
    fail("upload-staging-write-failed");
  } finally {
    await handle?.close();
  }
  try {
    await link(temporary, target);
    await unlink(temporary);
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the publication failure.
    }
    fail("upload-staging-conflict");
  }
  return true;
}

async function writePublicManifest(
  repositoryRoot: string,
  manifest: RecipeMediaManifest
) {
  const contentDirectory = path.join(repositoryRoot, "content");
  const directory = await existingStats(contentDirectory);
  if (directory === null || directory.isSymbolicLink() || !directory.isDirectory()) {
    fail("unsafe-public-manifest-destination");
  }
  const target = path.join(contentDirectory, "media-manifest.json");
  const existing = await existingStats(target);
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      fail("unsafe-public-manifest-destination");
    }
    let actual: RecipeMediaManifest;
    try {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        actual = parseRecipeMediaManifest(
          JSON.parse((await handle.readFile()).toString("utf8")) as unknown
        );
      } finally {
        await handle.close();
      }
    } catch {
      fail("public-media-manifest-conflict");
    }
    if (serialized(actual) !== serialized(manifest)) {
      fail("public-media-manifest-conflict");
    }
    return false;
  }
  const temporary = path.join(
    contentDirectory,
    `.media-manifest.${randomBytes(16).toString("hex")}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(serialized(manifest), "utf8");
    await handle.chmod(0o644);
    await handle.sync();
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the write failure.
    }
    fail("public-media-manifest-write-failed");
  } finally {
    await handle?.close();
  }
  try {
    await link(temporary, target);
    await unlink(temporary);
  } catch {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the publication failure.
    }
    fail("public-media-manifest-conflict");
  }
  return true;
}

function assertManifestMatchesAuthenticatedPlan(
  manifest: RecipeMediaManifest,
  entries: readonly {
    readonly bytes: number;
    readonly key: string;
    readonly sha256: string;
    readonly sourceAttachmentId: string;
  }[]
) {
  const expectedEntries = new Map(
    manifest.entries.map((entry) => [entry.key, entry] as const)
  );
  for (const entry of entries) {
    const expected = expectedEntries.get(entry.key);
    if (
      expected === undefined
      || expected.key !== entry.key
      || expected.bytes !== entry.bytes
      || expected.sha256 !== entry.sha256
      || expected.sourceAttachmentId !== entry.sourceAttachmentId
    ) {
      fail("authenticated-media-plan-mismatch");
    }
  }
}

export async function createWprmMediaUploadPlan(
  options: WprmMediaUploadPlanOptions
): Promise<WprmMediaUploadPlanResult> {
  const write = options.write === true;
  const dryRun = options.dryRun === true;
  if (write === dryRun || (options.resume === true && !write) || (
    options.writePublicManifest === true && !write
  )) {
    fail("invalid-upload-plan-mode");
  }
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(path.resolve(options.repositoryRoot));
  } catch {
    fail("invalid-repository-root");
  }

  return withAuthenticatedWprmMediaPlan(
    {
      ...options,
      write: false
    },
    async (authenticated) => {
      assertManifestMatchesAuthenticatedPlan(authenticated.manifest, authenticated.entries);
      const totalBytes = authenticated.entries.reduce((sum, entry) => sum + entry.bytes, 0);
      if (!Number.isSafeInteger(totalBytes)) {
        fail("upload-plan-size-limit");
      }
      if (!write) {
        return {
          schemaVersion: 1,
          kind: "wprm-media-upload-plan-result",
          mode: "dry-run",
          objects: {
            count: authenticated.entries.length,
            bytes: totalBytes,
            created: 0,
            reused: 0
          },
          publicManifest: {
            created: 0,
            reused: 0
          }
        };
      }

      const directories = await resolveUploadDirectories(repositoryRoot, options.uploadDir);
      let created = 0;
      let reused = 0;
      for (const entry of authenticated.entries) {
        const destination = objectDestination(directories.objects, entry.key);
        await ensurePrivateDirectoryChain(directories.objects, path.dirname(destination));
        const existing = await existingStats(destination);
        if (existing !== null) {
          const actual = await hashPrivateObject(destination);
          if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
            fail("upload-staging-conflict");
          }
          if (!options.resume) {
            fail("upload-staging-conflict");
          }
          reused += 1;
          continue;
        }
        try {
          await authenticated.copyToPrivateFile(entry.key, destination);
        } catch (error) {
          if (error instanceof WprmPromotionError) {
            throw new WprmMediaUploadPlanError(error.code);
          }
          throw error;
        }
        const copied = await hashPrivateObject(destination);
        if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) {
          fail("upload-staging-integrity-failed");
        }
        created += 1;
      }

      const uploadManifest = buildUploadManifest(createRecipeMediaManifest(
        authenticated.entries
      ));
      await writePrivateText(
        directories.manifest,
        serialized(uploadManifest),
        options.resume === true
      );
      const manifestCreated = options.writePublicManifest === true
        ? await writePublicManifest(repositoryRoot, authenticated.manifest)
        : false;
      return {
        schemaVersion: 1,
        kind: "wprm-media-upload-plan-result",
        mode: "write",
        objects: {
          count: authenticated.entries.length,
          bytes: totalBytes,
          created,
          reused
        },
        publicManifest: {
          created: manifestCreated ? 1 : 0,
          reused: options.writePublicManifest === true && !manifestCreated ? 1 : 0
        }
      };
    }
  );
}

export function serializeWprmMediaUploadPlanResult(result: WprmMediaUploadPlanResult) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
