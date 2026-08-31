import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats
} from "node:fs";
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
  readonly afterInstall?: () => Promise<void> | void;
  readonly beforeInstall?: () => Promise<void> | void;
  readonly beforeDirectorySync?: () => Promise<void> | void;
  readonly stagingDirectory?: string;
};

type ExclusiveLockDependencies = {
  readonly beforeRelease?: (quarantinePath: string) => Promise<void> | void;
};

export class AtomicWriteCommittedError extends Error {
  readonly committed = true;

  constructor(targetPath: string, cause: unknown, rollbackCause?: unknown) {
    super(
      `Atomic write committed "${targetPath}", but cleanup failed and rollback ` +
      "could not be proven. Inspect the target before retrying.",
      {
        cause: rollbackCause === undefined
          ? cause
          : new AggregateError(
            [cause, rollbackCause],
            "Post-commit cleanup and rollback both failed."
          )
      }
    );
    this.name = "AtomicWriteCommittedError";
  }
}

type EntryIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly sha256: string;
  readonly size: bigint;
};

function identityFromOpenFile(
  stats: BigIntStats,
  sha256: string
): EntryIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mtimeNs: stats.mtimeNs,
    sha256,
    size: stats.size
  };
}

function sameEntryIdentity(left: EntryIdentity, right: EntryIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.sha256 === right.sha256
    && left.size === right.size;
}

function sameEntryContentIdentity(left: EntryIdentity, right: EntryIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.sha256 === right.sha256
    && left.size === right.size;
}

function captureEntryIdentity(entryPath: string, label: string) {
  const descriptor = openSync(
    entryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error(`${label} is not a regular file: "${entryPath}".`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const beforeIdentity = identityFromOpenFile(
      before,
      createHash("sha256").update(bytes).digest("hex")
    );
    const afterIdentity = identityFromOpenFile(after, beforeIdentity.sha256);
    if (!sameEntryIdentity(beforeIdentity, afterIdentity)) {
      throw new Error(`${label} changed while its bytes were verified: "${entryPath}".`);
    }
    return afterIdentity;
  } finally {
    closeSync(descriptor);
  }
}

function assertEntryIdentity(
  entryPath: string,
  expected: EntryIdentity,
  label: string
) {
  const current = captureEntryIdentity(entryPath, label);
  if (!sameEntryIdentity(current, expected)) {
    throw new Error(`${label} identity changed: "${entryPath}".`);
  }
}

async function quarantineVerifiedEntry(
  entryPath: string,
  expected: EntryIdentity,
  quarantineDirectory: string,
  label: string,
  beforeRemoval?: (quarantinePath: string) => Promise<void> | void
) {
  const quarantinePath = path.join(
    quarantineDirectory,
    `.recipe-authoring-quarantine-${randomUUID()}.tmp`
  );
  await rename(entryPath, quarantinePath);
  let quarantined: EntryIdentity;
  try {
    quarantined = captureEntryIdentity(quarantinePath, label);
  } catch (verificationError) {
    try {
      await link(quarantinePath, entryPath);
      await unlink(quarantinePath);
      return {
        removedExpected: false,
        cleanupError: new Error(
          `${label} could not be verified after quarantine and was restored.`,
          { cause: verificationError }
        )
      };
    } catch (restoreError) {
      return {
        removedExpected: false,
        cleanupError: new AggregateError(
          [verificationError, restoreError],
          `${label} could not be verified or restored; preserved at ` +
          `"${quarantinePath}".`
        )
      };
    }
  }
  if (!sameEntryIdentity(quarantined, expected)) {
    try {
      await link(quarantinePath, entryPath);
      await unlink(quarantinePath);
    } catch (restoreError) {
      return {
        removedExpected: false,
        cleanupError: new AggregateError(
          [restoreError],
          `${label} changed before quarantine and could not be restored; ` +
          `preserved at "${quarantinePath}".`
        )
      };
    }
    return {
      removedExpected: false,
      cleanupError: new Error(`${label} changed before verified removal.`)
    };
  }

  try {
    await beforeRemoval?.(quarantinePath);
    const beforeUnlink = captureEntryIdentity(quarantinePath, label);
    if (!sameEntryIdentity(beforeUnlink, expected)) {
      return {
        removedExpected: true,
        cleanupError: new Error(
          `${label} quarantine changed before cleanup; preserved replacement at ` +
          `"${quarantinePath}".`
        )
      };
    }
    await unlink(quarantinePath);
    return { removedExpected: true, cleanupError: null };
  } catch (cleanupError) {
    const detail = cleanupError instanceof Error
      ? cleanupError.message
      : String(cleanupError);
    return {
      removedExpected: true,
      cleanupError: new Error(
        `${label} was quarantined but cleanup failed at "${quarantinePath}": ${detail}`,
        { cause: cleanupError }
      )
    };
  }
}

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
  let installed = false;
  let stagedIdentity: EntryIdentity | undefined;
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
    stagedIdentity = captureEntryIdentity(temporary, "Atomic staged file");

    await dependencies.beforeInstall?.();
    assertEntryIdentity(temporary, stagedIdentity, "Atomic staged file");
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
      installed = true;
      assertEntryIdentity(target, stagedIdentity, "Installed atomic target");
    } else {
      await link(temporary, target);
      installed = true;
      assertEntryIdentity(target, stagedIdentity, "Installed atomic target");
      await dependencies.afterInstall?.();
      const stagedCleanup = await quarantineVerifiedEntry(
        temporary,
        stagedIdentity,
        realStagingDirectory,
        "Atomic staged file"
      );
      temporaryExists = !stagedCleanup.removedExpected;
      if (stagedCleanup.cleanupError !== null) {
        throw stagedCleanup.cleanupError;
      }
    }

    await dependencies.beforeDirectorySync?.();
    assertEntryIdentity(target, stagedIdentity, "Installed atomic target");
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
    assertEntryIdentity(target, stagedIdentity, "Installed atomic target");
    return { committed: true as const };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (installed) {
      if (!overwrite && stagedIdentity !== undefined) {
        try {
          const rollback = await quarantineVerifiedEntry(
            target,
            stagedIdentity,
            realStagingDirectory,
            "Installed recipe target"
          );
          installed = false;
          if (rollback.cleanupError !== null) {
            cleanupErrors.push(rollback.cleanupError);
          }
        } catch (rollbackError) {
          throw new AtomicWriteCommittedError(targetPath, error, rollbackError);
        }
      } else {
        throw new AtomicWriteCommittedError(targetPath, error);
      }
    }

    if (temporaryExists) {
      try {
        if (stagedIdentity === undefined) {
          throw new Error("Atomic staged identity was not captured.");
        }
        const stagedCleanup = await quarantineVerifiedEntry(
          temporary,
          stagedIdentity,
          realStagingDirectory,
          "Atomic staged file"
        );
        temporaryExists = !stagedCleanup.removedExpected;
        if (stagedCleanup.cleanupError !== null) {
          cleanupErrors.push(stagedCleanup.cleanupError);
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      const details = cleanupErrors.map((cleanupError) =>
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      ).join("; ");
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Atomic write failed without a committed target, but cleanup also failed: " +
        details
      );
    }
    throw error;
  }
}

export async function withExclusiveFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  dependencies: ExclusiveLockDependencies = {}
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
  const initialLockStats = await handle.stat({ bigint: true });
  let opened = identityFromOpenFile(
    initialLockStats,
    createHash("sha256").update("").digest("hex")
  );
  const release = async () => {
    await handle.close();
    const finalized = captureEntryIdentity(target, "Recipe authoring lock");
    if (!sameEntryContentIdentity(finalized, opened)) {
      throw new Error(`Recipe authoring lock changed while held: "${lockPath}".`);
    }
    const released = await quarantineVerifiedEntry(
      target,
      finalized,
      realParent,
      "Recipe authoring lock",
      dependencies.beforeRelease
    );
    if (released.cleanupError !== null) {
      throw released.cleanupError;
    }
  };
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    const lockStats = await handle.stat({ bigint: true });
    opened = identityFromOpenFile(
      lockStats,
      createHash("sha256").update(`${process.pid}\n`, "utf8").digest("hex")
    );
    await handle.sync();
    const value = await action();
    try {
      await release();
      return { value, cleanupError: null };
    } catch (cleanupError) {
      return {
        value,
        cleanupError: cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError)
      };
    }
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Recipe authoring failed and its exclusive lock could not be released."
      );
    }
    throw error;
  }
}
