import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const DIGITAL_SIGNATURE = 0x05054b50;

export interface UploadArchiveLimits {
  maxArchives: number;
  maxArchiveBytes: number;
  maxCentralDirectoryBytes: number;
  maxTotalEntries: number;
  maxEntriesPerArchive: number;
  maxEntryNameBytes: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export const defaultUploadArchiveLimits: UploadArchiveLimits = {
  maxArchives: 64,
  maxArchiveBytes: 2 * 1024 * 1024 * 1024,
  maxCentralDirectoryBytes: 128 * 1024 * 1024,
  maxTotalEntries: 8_000_000,
  maxEntriesPerArchive: 2_000_000,
  maxEntryNameBytes: 16 * 1024,
  maxEntryUncompressedBytes: 1024 * 1024 * 1024,
  maxTotalUncompressedBytes: 16 * 1024 * 1024 * 1024
};

export interface UploadArchiveSummary {
  readonly index: number;
  readonly bytes: number;
  readonly entries: number;
  readonly files: number;
  readonly directories: number;
  readonly uploadFiles: number;
  readonly generatedDerivativeFiles: number;
  readonly invalidEntries: number;
  readonly duplicateUploadFiles: number;
  readonly extensions: readonly {
    extension: string;
    count: number;
  }[];
  readonly yearMonths: readonly {
    yearMonth: string;
    count: number;
  }[];
}

export interface UploadArchiveInventory {
  readonly summaries: readonly UploadArchiveSummary[];
  readonly uploadPathCounts: ReadonlyMap<string, number>;
  readonly uploadPathArchives: ReadonlyMap<string, ReadonlySet<number>>;
}

export class UploadArchiveError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UploadArchiveError";
    this.code = code;
  }
}

function mergeLimits(limits: Partial<UploadArchiveLimits> | undefined) {
  const merged = { ...defaultUploadArchiveLimits, ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Upload archive limit ${key} must be a positive safe integer.`);
    }
  }
  return merged;
}

function readUInt64LE(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 8 > buffer.byteLength) {
    throw new UploadArchiveError("malformed-zip", "A ZIP integer was truncated.");
  }
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UploadArchiveError("zip-size-limit", "A ZIP size exceeds the safe integer limit.");
  }
  return Number(value);
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number
) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
    throw new UploadArchiveError("malformed-zip", "A ZIP range is invalid.");
  }
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new UploadArchiveError("malformed-zip", "A ZIP range was truncated.");
    }
    offset += result.bytesRead;
  }
  return buffer;
}

function findEndOfCentralDirectory(buffer: Buffer) {
  for (let index = buffer.byteLength - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(index + 20);
    if (index + 22 + commentLength <= buffer.byteLength) {
      return index;
    }
  }
  throw new UploadArchiveError(
    "malformed-zip",
    "The upload archive has no valid end-of-central-directory record."
  );
}

function readZip64Extra(
  extra: Buffer,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number
) {
  let position = 0;
  while (position + 4 <= extra.byteLength) {
    const type = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    position += 4;
    if (position + length > extra.byteLength) {
      throw new UploadArchiveError("malformed-zip", "A ZIP extra field was truncated.");
    }
    if (type !== 0x0001) {
      position += length;
      continue;
    }
    const field = extra.subarray(position, position + length);
    let fieldPosition = 0;
    const read = () => {
      const value = readUInt64LE(field, fieldPosition);
      fieldPosition += 8;
      return value;
    };
    return {
      compressedSize: compressedSize === 0xffffffff ? read() : compressedSize,
      uncompressedSize: uncompressedSize === 0xffffffff ? read() : uncompressedSize,
      localOffset: localOffset === 0xffffffff ? read() : localOffset
    };
  }
  if (
    compressedSize === 0xffffffff
    || uncompressedSize === 0xffffffff
    || localOffset === 0xffffffff
  ) {
    throw new UploadArchiveError(
      "malformed-zip",
      "A ZIP64 entry is missing its ZIP64 extra field."
    );
  }
  return { compressedSize, uncompressedSize, localOffset };
}

function decodeEntryName(bytes: Buffer, utf8: boolean) {
  if (utf8) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  let result = "";
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }
  return result;
}

function normalizeUploadEntryPath(name: string) {
  if (
    !name
    || name.includes("\\")
    || name.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(name)
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
  ) {
    return null;
  }
  const directory = name.endsWith("/");
  const segments = name.split("/");
  if (directory) {
    segments.pop();
  }
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const uploadIndex = segments.reduce(
    (last, segment, index) => segment.toLowerCase() === "uploads" ? index : last,
    -1
  );
  const relative = (uploadIndex === -1 ? segments : segments.slice(uploadIndex + 1)).join("/");
  return relative || null;
}

function extensionFor(pathValue: string) {
  const extension = path.posix.extname(pathValue).slice(1).toLowerCase();
  return /^[a-z0-9]{1,16}$/u.test(extension) ? extension : "(none)";
}

function yearMonthFor(pathValue: string) {
  const [year, month] = pathValue.split("/");
  if (year && month && /^\d{4}$/u.test(year) && /^\d{2}$/u.test(month)) {
    return `${year}-${month}`;
  }
  return null;
}

function sortedCounts(values: ReadonlyMap<string, number>) {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => ({ extension: key, count }));
}

function sortedYearMonths(values: ReadonlyMap<string, number>) {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([yearMonth, count]) => ({ yearMonth, count }));
}

async function centralDirectoryRange(
  handle: Awaited<ReturnType<typeof open>>,
  fileBytes: number,
  tail: Buffer,
  tailStart: number,
  endOffsetInTail: number,
  limits: UploadArchiveLimits
) {
  const absoluteEndOffset = tailStart + endOffsetInTail;
  const diskNumber16 = tail.readUInt16LE(endOffsetInTail + 4);
  const centralDirectoryDisk16 = tail.readUInt16LE(endOffsetInTail + 6);
  const entriesOnDisk16 = tail.readUInt16LE(endOffsetInTail + 8);
  const totalEntries16 = tail.readUInt16LE(endOffsetInTail + 10);
  const size32 = tail.readUInt32LE(endOffsetInTail + 12);
  const offset32 = tail.readUInt32LE(endOffsetInTail + 16);
  let entries = totalEntries16;
  let centralSize = size32;
  let centralOffset = offset32;
  let centralDirectoryEndOffset = absoluteEndOffset;

  if (
    diskNumber16 === 0xffff
    || centralDirectoryDisk16 === 0xffff
    || entriesOnDisk16 === 0xffff
    || totalEntries16 === 0xffff
    || size32 === 0xffffffff
    || offset32 === 0xffffffff
  ) {
    const locatorPosition = absoluteEndOffset - 20;
    if (locatorPosition < 0) {
      throw new UploadArchiveError("malformed-zip", "A ZIP64 locator is missing.");
    }
    const locator = await readExact(handle, locatorPosition, 20);
    if (locator.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
      throw new UploadArchiveError("malformed-zip", "A ZIP64 locator is malformed.");
    }
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
      throw new UploadArchiveError(
        "unsupported-zip",
        "Multi-disk ZIP64 archives are not supported."
      );
    }
    const zip64Offset = readUInt64LE(locator, 8);
    const zip64Prefix = await readExact(handle, zip64Offset, 12);
    if (zip64Prefix.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
      throw new UploadArchiveError("malformed-zip", "A ZIP64 directory record is malformed.");
    }
    const zip64RecordSize = readUInt64LE(zip64Prefix, 4);
    if (zip64RecordSize < 44) {
      throw new UploadArchiveError(
        "malformed-zip",
        "A ZIP64 directory record is too small."
      );
    }
    const zip64RecordEnd = zip64Offset + 12 + zip64RecordSize;
    if (
      !Number.isSafeInteger(zip64RecordEnd)
      || zip64RecordEnd !== locatorPosition
    ) {
      throw new UploadArchiveError(
        "malformed-zip",
        "A ZIP64 directory record does not end at its locator."
      );
    }
    const zip64Header = await readExact(handle, zip64Offset, 56);
    if (zip64Header.readUInt32LE(16) !== 0 || zip64Header.readUInt32LE(20) !== 0) {
      throw new UploadArchiveError(
        "unsupported-zip",
        "Multi-disk ZIP64 archives are not supported."
      );
    }
    const entriesOnDisk64 = readUInt64LE(zip64Header, 24);
    const totalEntries64 = readUInt64LE(zip64Header, 32);
    if (entriesOnDisk64 !== totalEntries64) {
      throw new UploadArchiveError(
        "unsupported-zip",
        "Multi-disk ZIP64 archives are not supported."
      );
    }
    entries = totalEntries64;
    centralSize = readUInt64LE(zip64Header, 40);
    centralOffset = readUInt64LE(zip64Header, 48);
    centralDirectoryEndOffset = zip64Offset;
  }

  if (
    (diskNumber16 !== 0 && diskNumber16 !== 0xffff)
    || (centralDirectoryDisk16 !== 0 && centralDirectoryDisk16 !== 0xffff)
  ) {
    throw new UploadArchiveError(
      "unsupported-zip",
      "Multi-disk ZIP archives are not supported."
    );
  }
  if (entriesOnDisk16 !== 0xffff && entriesOnDisk16 !== totalEntries16) {
    throw new UploadArchiveError(
      "unsupported-zip",
      "Multi-disk ZIP archives are not supported."
    );
  }

  if (entries > limits.maxEntriesPerArchive) {
    throw new UploadArchiveError("entry-limit", "The upload archive has too many entries.");
  }
  if (centralSize > limits.maxCentralDirectoryBytes) {
    throw new UploadArchiveError(
      "central-directory-limit",
      "The upload archive central directory exceeded the configured safety limit."
    );
  }

  if (centralOffset + centralSize > fileBytes) {
    throw new UploadArchiveError("malformed-zip", "The ZIP central directory is outside the archive.");
  }
  const expectedEnd = centralOffset + centralSize;
  const adjustedOffset =
    expectedEnd === centralDirectoryEndOffset
      ? centralOffset
      : centralOffset + (centralDirectoryEndOffset - expectedEnd);
  if (adjustedOffset < 0 || adjustedOffset + centralSize > fileBytes) {
    throw new UploadArchiveError("malformed-zip", "The ZIP central directory range is invalid.");
  }
  return {
    entries,
    central: await readExact(handle, adjustedOffset, centralSize)
  };
}

async function inspectArchive(
  archivePath: string,
  index: number,
  limits: UploadArchiveLimits,
  uploadPathCounts: Map<string, number>,
  uploadPathArchives: Map<string, Set<number>>
): Promise<UploadArchiveSummary> {
  const stats = await lstat(archivePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new UploadArchiveError(
      "invalid-archive-input",
      "Each upload archive input must be a regular file."
    );
  }
  if (stats.size > limits.maxArchiveBytes) {
    throw new UploadArchiveError("archive-size-limit", "An upload archive exceeded the configured size limit.");
  }

  const handle = await open(archivePath, "r");
  try {
    const tailLength = Math.min(stats.size, 22 + 65_535 + 20 + 56);
    const tailStart = stats.size - tailLength;
    const tail = await readExact(handle, tailStart, tailLength);
    const endOffsetInTail = findEndOfCentralDirectory(tail);
    const { entries, central } = await centralDirectoryRange(
      handle,
      stats.size,
      tail,
      tailStart,
      endOffsetInTail,
      limits
    );

    let position = 0;
    let files = 0;
    let directories = 0;
    let uploadFiles = 0;
    let generatedDerivativeFiles = 0;
    let invalidEntries = 0;
    let duplicateUploadFiles = 0;
    let parsedEntries = 0;
    let totalUncompressedBytes = 0;
    const archiveUploadPaths = new Set<string>();
    const extensions = new Map<string, number>();
    const yearMonths = new Map<string, number>();
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

    for (let entryIndex = 0; entryIndex < entries; entryIndex += 1) {
      if (position + 46 > central.byteLength) {
        throw new UploadArchiveError("malformed-zip", "A ZIP central directory entry was truncated.");
      }
      if (central.readUInt32LE(position) === DIGITAL_SIGNATURE) {
        break;
      }
      if (central.readUInt32LE(position) !== CENTRAL_DIRECTORY_ENTRY) {
        throw new UploadArchiveError("malformed-zip", "A ZIP central directory entry is malformed.");
      }
      const flags = central.readUInt16LE(position + 8);
      const compressedSize = central.readUInt32LE(position + 20);
      const uncompressedSize = central.readUInt32LE(position + 24);
      const nameLength = central.readUInt16LE(position + 28);
      const extraLength = central.readUInt16LE(position + 30);
      const commentLength = central.readUInt16LE(position + 32);
      const externalAttributes = central.readUInt32LE(position + 38);
      const localOffset = central.readUInt32LE(position + 42);
      if (nameLength > limits.maxEntryNameBytes) {
        throw new UploadArchiveError("entry-name-limit", "A ZIP entry name exceeded the configured safety limit.");
      }
      const entryEnd = position + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > central.byteLength) {
        throw new UploadArchiveError("malformed-zip", "A ZIP central directory entry was truncated.");
      }
      const nameBytes = central.subarray(position + 46, position + 46 + nameLength);
      let name: string;
      try {
        name = (flags & 0x0800) !== 0
          ? utf8Decoder.decode(nameBytes)
          : decodeEntryName(nameBytes, false);
      } catch {
        throw new UploadArchiveError("malformed-zip", "A ZIP entry name is not valid text.");
      }
      const extra = central.subarray(
        position + 46 + nameLength,
        position + 46 + nameLength + extraLength
      );
      const sizes = readZip64Extra(extra, compressedSize, uncompressedSize, localOffset);
      if (
        sizes.compressedSize > limits.maxEntryUncompressedBytes
        || sizes.uncompressedSize > limits.maxEntryUncompressedBytes
      ) {
        throw new UploadArchiveError("entry-size-limit", "A ZIP entry exceeded the configured size limit.");
      }
      if (
        sizes.localOffset > stats.size
        || sizes.compressedSize > stats.size
        || sizes.localOffset + sizes.compressedSize > stats.size
      ) {
        throw new UploadArchiveError("malformed-zip", "A ZIP entry range is outside the archive.");
      }
      totalUncompressedBytes += sizes.uncompressedSize;
      if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
        throw new UploadArchiveError(
          "total-entry-size-limit",
          "The upload archive exceeded the configured uncompressed size limit."
        );
      }

      const isDirectory = name.endsWith("/")
        || (externalAttributes & 0x10) !== 0;
      if (isDirectory) {
        directories += 1;
      } else {
        files += 1;
        const relativePath = normalizeUploadEntryPath(name);
        if (!relativePath) {
          invalidEntries += 1;
        } else {
          uploadFiles += 1;
          if (/-\d+x\d+\.[^./]+$/u.test(relativePath)) {
            generatedDerivativeFiles += 1;
          }
          if (archiveUploadPaths.has(relativePath)) {
            duplicateUploadFiles += 1;
          }
          archiveUploadPaths.add(relativePath);
          uploadPathCounts.set(relativePath, (uploadPathCounts.get(relativePath) ?? 0) + 1);
          const archiveIndexes = uploadPathArchives.get(relativePath) ?? new Set<number>();
          archiveIndexes.add(index);
          uploadPathArchives.set(relativePath, archiveIndexes);
          const extension = extensionFor(relativePath);
          extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
          const yearMonth = yearMonthFor(relativePath);
          if (yearMonth) {
            yearMonths.set(yearMonth, (yearMonths.get(yearMonth) ?? 0) + 1);
          }
        }
      }
      position = entryEnd;
      parsedEntries += 1;
    }

    if (position < central.byteLength && central.readUInt32LE(position) !== DIGITAL_SIGNATURE) {
      throw new UploadArchiveError("malformed-zip", "The ZIP central directory contains trailing data.");
    }
    if (parsedEntries !== entries) {
      throw new UploadArchiveError("malformed-zip", "The ZIP entry count does not match its directory.");
    }
    return {
      index,
      bytes: stats.size,
      entries,
      files,
      directories,
      uploadFiles,
      generatedDerivativeFiles,
      invalidEntries,
      duplicateUploadFiles,
      extensions: sortedCounts(extensions),
      yearMonths: sortedYearMonths(yearMonths)
    };
  } finally {
    await handle.close();
  }
}

export async function inventoryUploadArchives(
  archivePaths: readonly string[],
  inputLimits?: Partial<UploadArchiveLimits>
): Promise<UploadArchiveInventory> {
  const limits = mergeLimits(inputLimits);
  if (archivePaths.length > limits.maxArchives) {
    throw new UploadArchiveError("archive-limit", "Too many upload archives were supplied.");
  }
  const paths = [...archivePaths].sort((left, right) =>
    path.resolve(left).localeCompare(path.resolve(right))
  );
  const summaries: UploadArchiveSummary[] = [];
  const uploadPathCounts = new Map<string, number>();
  const uploadPathArchives = new Map<string, Set<number>>();
  let totalEntries = 0;
  for (const [index, archivePath] of paths.entries()) {
    const summary = await inspectArchive(
      path.resolve(archivePath),
      index,
      limits,
      uploadPathCounts,
      uploadPathArchives
    );
    totalEntries += summary.entries;
    if (totalEntries > limits.maxTotalEntries) {
      throw new UploadArchiveError(
        "total-entry-limit",
        "The upload archives exceeded the configured total entry limit."
      );
    }
    summaries.push(summary);
  }
  return { summaries, uploadPathCounts, uploadPathArchives };
}
