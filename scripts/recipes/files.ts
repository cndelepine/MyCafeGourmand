import { randomUUID } from "node:crypto";
import { constants, openSync, readFileSync, closeSync, fstatSync, lstatSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { parseJsonAtBoundary } from "../../src/content/json-boundary";

function isMissing(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

export function serializeJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function readBoundedJsonFile(
  filePath: string,
  label: string,
  maxBytes: number,
  maxDepth: number
) {
  const initial = lstatSync(filePath, { bigint: true });
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: "${filePath}".`);
  }
  if (initial.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds the maximum size of ${maxBytes} bytes: "${filePath}".`);
  }

  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== initial.dev
      || opened.ino !== initial.ino
      || opened.size !== initial.size
      || opened.mtimeNs !== initial.mtimeNs
    ) {
      throw new Error(`${label} changed before it was read: "${filePath}".`);
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} exceeds the maximum size of ${maxBytes} bytes: "${filePath}".`);
    }
    const contents = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true
    }).decode(bytes);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
    ) {
      throw new Error(`${label} changed while it was read: "${filePath}".`);
    }
    return {
      contents,
      value: parseJsonAtBoundary(contents, { maxDepth })
    };
  } finally {
    closeSync(descriptor);
  }
}

type AtomicWriteDependencies = {
  readonly beforeInstall?: () => Promise<void> | void;
  readonly stagingDirectory?: string;
};

export async function ensureDirectory(directory: string) {
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Output parent must be a regular directory: "${directory}".`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await mkdir(directory, { recursive: true });
  }
}

export async function writeAtomicFile(
  targetPath: string,
  contents: string,
  overwrite: boolean,
  dependencies: AtomicWriteDependencies = {}
) {
  const parent = path.dirname(targetPath);
  const parentStats = lstatSync(parent, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`Output parent must be a regular non-symlink directory: "${parent}".`);
  }
  const realParent = await realpath(parent);
  const target = path.join(realParent, path.basename(targetPath));
  try {
    const targetStats = lstatSync(target);
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      throw new Error(`Output target must be a regular non-symlink file: "${targetPath}".`);
    }
    if (!overwrite) {
      throw new Error(`Output already exists: "${targetPath}".`);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

  const stagingDirectory = dependencies.stagingDirectory ?? realParent;
  const stagingStats = lstatSync(stagingDirectory, { bigint: true });
  if (
    stagingStats.isSymbolicLink()
    || !stagingStats.isDirectory()
    || stagingStats.dev !== parentStats.dev
  ) {
    throw new Error(
      `Atomic staging directory must be a non-symlink directory on the target filesystem: ` +
      `"${stagingDirectory}".`
    );
  }
  const realStagingDirectory = await realpath(stagingDirectory);
  const temporary = path.join(
    realStagingDirectory,
    `.recipe-authoring-${randomUUID()}.tmp`
  );
  let temporaryExists = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644
    );
    temporaryExists = true;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await dependencies.beforeInstall?.();
    const currentParent = lstatSync(parent, { bigint: true });
    const currentStaging = lstatSync(stagingDirectory, { bigint: true });
    if (
      currentParent.isSymbolicLink()
      || !currentParent.isDirectory()
      || currentParent.dev !== parentStats.dev
      || currentParent.ino !== parentStats.ino
      || await realpath(parent) !== realParent
      || currentStaging.isSymbolicLink()
      || !currentStaging.isDirectory()
      || currentStaging.dev !== stagingStats.dev
      || currentStaging.ino !== stagingStats.ino
      || await realpath(stagingDirectory) !== realStagingDirectory
    ) {
      throw new Error("Output or staging parent changed before installation.");
    }

    if (overwrite) {
      await rename(temporary, target);
      temporaryExists = false;
    } else {
      await link(temporary, target);
      await unlink(temporary);
      temporaryExists = false;
    }

    if (process.platform !== "win32") {
      const directoryHandle = await open(
        realParent,
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  action: () => Promise<T>
) {
  const parent = path.dirname(lockPath);
  const parentStats = lstatSync(parent, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`Lock parent must be a regular non-symlink directory: "${parent}".`);
  }
  const realParent = await realpath(parent);
  const target = path.join(realParent, path.basename(lockPath));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if (
      error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "EEXIST"
    ) {
      throw new Error(
        `Recipe authoring is locked: "${lockPath}". ` +
        "Confirm the owning process is no longer running before removing a stale lock."
      );
    }
    throw error;
  }
  const opened = await handle.stat({ bigint: true });
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    await handle.sync();
    return await action();
  } finally {
    await handle.close();
    const current = lstatSync(target, { bigint: true });
    if (
      current.isSymbolicLink()
      || !current.isFile()
      || current.dev !== opened.dev
      || current.ino !== opened.ino
    ) {
      throw new Error(`Recipe authoring lock changed while held: "${lockPath}".`);
    }
    await unlink(target);
  }
}
