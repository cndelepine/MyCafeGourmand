import type { BigIntStats } from "node:fs";

export type FileSystemIdentity = Pick<
  BigIntStats,
  "dev" | "ino" | "mode" | "size" | "mtimeNs" | "ctimeNs"
>;

function sameMetadata(left: FileSystemIdentity, right: FileSystemIdentity) {
  return left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function sameFileSystemIdentity(
  left: FileSystemIdentity,
  right: FileSystemIdentity
) {
  return left.dev === right.dev && sameMetadata(left, right);
}

export function pathMatchesFileDescriptor(
  pathIdentity: FileSystemIdentity,
  descriptorIdentity: FileSystemIdentity,
  platform: NodeJS.Platform = process.platform
) {
  // Node 22.13's libuv win/fs.c uses a 64-bit volume serial for path stats,
  // but FileFsVolumeInformation supplies only 32 bits for descriptor stats.
  // https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/win/fs.c#L1688-L1830
  // Normalize only this cross-API comparison, never same-API snapshots.
  const sameDevice = pathIdentity.dev === descriptorIdentity.dev
    || (
      platform === "win32"
      && (pathIdentity.dev & 0xffffffffn) === descriptorIdentity.dev
    );
  return sameDevice && sameMetadata(pathIdentity, descriptorIdentity);
}
