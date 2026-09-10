import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  pathMatchesFileDescriptor,
  sameFileSystemIdentity
} from "../src/content/file-system-identity";

export function readBoundedDeploymentFile(root: string, relative: string, maximum = 8 * 1024 * 1024) {
  const components = relative.split("/");
  if (components.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error("Unsafe artifact file path.");
  }
  const directories = [root];
  for (const part of components.slice(0, -1)) {
    directories.push(path.join(directories.at(-1)!, part));
  }
  const directoryIdentities = directories.map((directory) => {
    const stats = lstatSync(directory, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Artifact directories must be regular directories.");
    }
    return stats;
  });
  const file = path.join(directories.at(-1)!, components.at(-1)!);
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error("Artifact files must be bounded, unlinked regular files.", { cause: error });
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const initial = lstatSync(file, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || initial.isSymbolicLink() || opened.size > BigInt(maximum)) {
      throw new Error("Artifact files must be bounded, unlinked regular files.");
    }
    if (!pathMatchesFileDescriptor(initial, opened)) {
      throw new Error("Artifact changed before its descriptor was validated.");
    }
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (
      length !== Number(opened.size)
      || !sameFileSystemIdentity(opened, fstatSync(descriptor, { bigint: true }))
      || !sameFileSystemIdentity(initial, lstatSync(file, { bigint: true }))
      || directories.some((directory, index) =>
        !sameFileSystemIdentity(directoryIdentities[index]!, lstatSync(directory, { bigint: true }))
      )
    ) {
      throw new Error("Artifact identity changed while its bytes were read.");
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

export function writeNewDeploymentFile(file: string, contents: string) {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Release metadata already exists; rebuild instead of relabeling output.", { cause: error });
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, contents, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
