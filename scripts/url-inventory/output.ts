import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";

function outputPathIsProtected(outputPath: string) {
  const root = path.resolve(process.cwd());
  const protectedRoots = ["public", "src", "content"].map((directory) =>
    path.resolve(root, directory)
  );
  return protectedRoots.some(
    (protectedRoot) =>
      outputPath === protectedRoot || outputPath.startsWith(`${protectedRoot}${path.sep}`)
  );
}

function isMissingFileError(error: unknown) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function ensureOutputParent(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to write through a directory symlink: "${current}".`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Output parent is not a directory: "${current}".`);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (
          !mkdirError
          || typeof mkdirError !== "object"
          || !("code" in mkdirError)
          || mkdirError.code !== "EEXIST"
        ) {
          throw mkdirError;
        }
      }
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to write through a directory symlink: "${current}".`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Output parent is not a directory: "${current}".`);
      }
    }
  }
}

async function verifiedOutputParent(outputPath: string) {
  const parent = path.dirname(outputPath);
  const parentStats = await lstat(parent);
  if (parentStats.isSymbolicLink()) {
    throw new Error(`Refusing to write through a directory symlink: "${parent}".`);
  }
  if (!parentStats.isDirectory()) {
    throw new Error(`Output parent is not a directory: "${parent}".`);
  }
  const realParent = await realpath(parent);
  if (outputPathIsProtected(realParent)) {
    throw new Error(
      "Refusing to write through a directory symlink into public/, src/, or content/."
    );
  }
  return realParent;
}

type WritableOutput = {
  outputPath: string;
  targetPath: string;
  realParent: string;
};

export async function assertWritableOutput(
  outputPath: string,
  overwrite: boolean
): Promise<WritableOutput> {
  if (outputPathIsProtected(outputPath)) {
    throw new Error(
      "Refusing to write inventory output under public/, src/, or content/. " +
      "Use migration-output/ or another migration-only directory."
    );
  }

  await ensureOutputParent(path.dirname(outputPath));
  const realParent = await verifiedOutputParent(outputPath);
  const targetPath = path.join(realParent, path.basename(outputPath));

  try {
    const outputStats = await lstat(targetPath);
    if (outputStats.isSymbolicLink()) {
      throw new Error(`Refusing to write through symbolic link: "${outputPath}".`);
    }
    if (!outputStats.isFile()) {
      throw new Error(`Refusing to replace non-file output: "${outputPath}".`);
    }
    if (!overwrite) {
      throw new Error(
        `Output already exists: "${outputPath}". Pass --overwrite to replace it explicitly.`
      );
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  return { outputPath, targetPath, realParent };
}

export async function writeInventoryOutput(
  outputPath: string,
  serialized: string,
  overwrite: boolean
) {
  const initial = await assertWritableOutput(outputPath, overwrite);
  let temporaryPath: string | undefined;
  try {
    const verified = await assertWritableOutput(outputPath, overwrite);
    if (verified.realParent !== initial.realParent) {
      throw new Error("Output parent changed while preparing the atomic write.");
    }

    temporaryPath = path.join(
      verified.realParent,
      `.${path.basename(outputPath)}.${randomUUID()}.tmp`
    );
    const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const fileHandle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    );
    try {
      await fileHandle.writeFile(serialized, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    const beforeRename = await assertWritableOutput(outputPath, overwrite);
    if (
      beforeRename.realParent !== verified.realParent
      || beforeRename.targetPath !== verified.targetPath
    ) {
      throw new Error("Output parent changed before the atomic rename.");
    }
    // Node does not expose renameat/dirfd operations. Using the verified real
    // parent for both paths narrows the remaining race to replacement of that
    // directory itself; overwrite renames replace entries, never follow them,
    // while non-overwrite installs below fail if the entry already exists.
    await installInventoryTempFile(temporaryPath, beforeRename.targetPath, overwrite);
    temporaryPath = undefined;
  } finally {
    if (temporaryPath) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function installInventoryTempFile(
  temporaryPath: string,
  targetPath: string,
  overwrite: boolean
) {
  if (overwrite) {
    await rename(temporaryPath, targetPath);
    return;
  }
  await link(temporaryPath, targetPath);
  await unlink(temporaryPath);
}
