import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { createInflateRaw } from "node:zlib";
import {
  defaultUploadArchiveLimits,
  type UploadArchiveLimits
} from "./uploads-inventory";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const DIGITAL_SIGNATURE = 0x05054b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMBOLIC_LINK = 0xa000;

export type VerifiedUploadMedia = {
  readonly bytes: number;
  readonly sha256: string;
  readonly keyedSha256: string | null;
};

export type UploadEntryKeyedDigest = {
  readonly key: Uint8Array;
  readonly context: string;
};

export type UploadEntryVerificationOptions = {
  readonly limits?: Partial<UploadArchiveLimits>;
  readonly keyedDigest?: UploadEntryKeyedDigest;
};

export type CopyUploadEntryVerificationOptions = UploadEntryVerificationOptions & {
  /**
   * Test-only synchronization point after this invocation creates its exclusive
   * destination file.
   */
  readonly onDestinationCreated?: () => void | Promise<void>;
};

export class VerifiedUploadArchive {
  readonly #handle: Awaited<ReturnType<typeof open>>;
  readonly #bytes: number;
  readonly #limits: UploadArchiveLimits;
  #closed = false;

  constructor(
    handle: Awaited<ReturnType<typeof open>>,
    bytes: number,
    limits: UploadArchiveLimits
  ) {
    this.#handle = handle;
    this.#bytes = bytes;
    this.#limits = limits;
  }

  async verifyEntry(
    expectedUploadPath: string,
    writable: Writable,
    options: Omit<UploadEntryVerificationOptions, "limits"> = {}
  ) {
    if (this.#closed) {
      fail("invalid-upload-archive");
    }
    const entry = await findEntry(
      this.#handle,
      this.#bytes,
      expectedUploadPath,
      this.#limits
    );
    return verifyEntryToWritable(
      this.#handle,
      this.#bytes,
      entry,
      writable,
      options.keyedDigest
    );
  }

  async close() {
    if (!this.#closed) {
      this.#closed = true;
      await this.#handle.close();
    }
  }
}

export class UploadMediaError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The upload media entry could not be verified.");
    this.name = "UploadMediaError";
    this.code = code;
  }
}

type ZipEntry = {
  readonly name: Buffer;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
  readonly externalAttributes: number;
};

function fail(code: string): never {
  throw new UploadMediaError(code);
}

function mergeLimits(input: Partial<UploadArchiveLimits> | undefined) {
  const limits = { ...defaultUploadArchiveLimits, ...input };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("invalid-upload-limit");
    }
  }
  return limits;
}

function isMissing(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number
) {
  if (
    !Number.isSafeInteger(position)
    || !Number.isSafeInteger(length)
    || position < 0
    || length < 0
  ) {
    fail("malformed-upload-archive");
  }
  const value = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(value, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      fail("malformed-upload-archive");
    }
    offset += result.bytesRead;
  }
  return value;
}

function readUInt64LE(buffer: Buffer, offset: number) {
  if (offset < 0 || offset + 8 > buffer.byteLength) {
    fail("malformed-upload-archive");
  }
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("upload-size-limit");
  }
  return Number(value);
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
  fail("malformed-upload-archive");
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
      fail("malformed-upload-archive");
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
    fail("malformed-upload-archive");
  }
  return { compressedSize, uncompressedSize, localOffset };
}

function decodeEntryName(bytes: Buffer, utf8: boolean) {
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("malformed-upload-archive");
    }
  }
  let result = "";
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }
  return result;
}

function normalizeUploadEntryPath(name: string) {
  if (
    name.length === 0
    || name.includes("\\")
    || name.includes("\0")
    || /[\u0000-\u001f\u007f]/u.test(name)
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
  ) {
    return null;
  }
  const segments = name.split("/");
  if (
    segments.length === 0
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  const uploadIndex = segments.reduce(
    (last, segment, index) => segment.toLowerCase() === "uploads" ? index : last,
    -1
  );
  const normalized = (uploadIndex === -1 ? segments : segments.slice(uploadIndex + 1)).join("/");
  return normalized.length > 0 ? normalized : null;
}

async function centralDirectoryRange(
  handle: Awaited<ReturnType<typeof open>>,
  archiveBytes: number,
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
      fail("malformed-upload-archive");
    }
    const locator = await readExact(handle, locatorPosition, 20);
    if (locator.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
      fail("malformed-upload-archive");
    }
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
      fail("unsupported-upload-archive");
    }
    const zip64Offset = readUInt64LE(locator, 8);
    const zip64Prefix = await readExact(handle, zip64Offset, 12);
    if (zip64Prefix.readUInt32LE(0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
      fail("malformed-upload-archive");
    }
    const zip64RecordSize = readUInt64LE(zip64Prefix, 4);
    if (zip64RecordSize < 44) {
      fail("malformed-upload-archive");
    }
    const zip64RecordEnd = zip64Offset + 12 + zip64RecordSize;
    if (
      !Number.isSafeInteger(zip64RecordEnd)
      || zip64RecordEnd !== locatorPosition
    ) {
      fail("malformed-upload-archive");
    }
    const zip64Header = await readExact(handle, zip64Offset, 56);
    if (zip64Header.readUInt32LE(16) !== 0 || zip64Header.readUInt32LE(20) !== 0) {
      fail("unsupported-upload-archive");
    }
    const entriesOnDisk64 = readUInt64LE(zip64Header, 24);
    const totalEntries64 = readUInt64LE(zip64Header, 32);
    if (entriesOnDisk64 !== totalEntries64) {
      fail("unsupported-upload-archive");
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
    fail("unsupported-upload-archive");
  }
  if (entriesOnDisk16 !== 0xffff && entriesOnDisk16 !== totalEntries16) {
    fail("unsupported-upload-archive");
  }
  if (entries > limits.maxEntriesPerArchive) {
    fail("upload-entry-limit");
  }
  if (centralSize > limits.maxCentralDirectoryBytes) {
    fail("upload-central-directory-limit");
  }
  if (centralOffset + centralSize > archiveBytes) {
    fail("malformed-upload-archive");
  }
  const expectedEnd = centralOffset + centralSize;
  const adjustedOffset = expectedEnd === centralDirectoryEndOffset
    ? centralOffset
    : centralOffset + (centralDirectoryEndOffset - expectedEnd);
  if (adjustedOffset < 0 || adjustedOffset + centralSize > archiveBytes) {
    fail("malformed-upload-archive");
  }
  return {
    entries,
    central: await readExact(handle, adjustedOffset, centralSize)
  };
}

function isZipSymbolicLink(externalAttributes: number) {
  return ((externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMBOLIC_LINK;
}

async function findEntry(
  handle: Awaited<ReturnType<typeof open>>,
  archiveBytes: number,
  expectedUploadPath: string,
  limits: UploadArchiveLimits
) {
  if (normalizeUploadEntryPath(expectedUploadPath) !== expectedUploadPath) {
    fail("unsafe-upload-path");
  }
  const tailLength = Math.min(archiveBytes, 22 + 65_535 + 20 + 56);
  const tailStart = archiveBytes - tailLength;
  const tail = await readExact(handle, tailStart, tailLength);
  const { entries, central } = await centralDirectoryRange(
    handle,
    archiveBytes,
    tail,
    tailStart,
    findEndOfCentralDirectory(tail),
    limits
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const matches: ZipEntry[] = [];
  let totalUncompressedBytes = 0;
  let position = 0;
  let parsedEntries = 0;

  for (let index = 0; index < entries; index += 1) {
    if (position + 46 > central.byteLength) {
      fail("malformed-upload-archive");
    }
    if (central.readUInt32LE(position) === DIGITAL_SIGNATURE) {
      break;
    }
    if (central.readUInt32LE(position) !== CENTRAL_DIRECTORY_ENTRY) {
      fail("malformed-upload-archive");
    }
    const flags = central.readUInt16LE(position + 8);
    const method = central.readUInt16LE(position + 10);
    const crc32 = central.readUInt32LE(position + 16);
    const compressedSize = central.readUInt32LE(position + 20);
    const uncompressedSize = central.readUInt32LE(position + 24);
    const nameLength = central.readUInt16LE(position + 28);
    const extraLength = central.readUInt16LE(position + 30);
    const commentLength = central.readUInt16LE(position + 32);
    const externalAttributes = central.readUInt32LE(position + 38);
    const localOffset = central.readUInt32LE(position + 42);
    if (nameLength > limits.maxEntryNameBytes) {
      fail("upload-entry-name-limit");
    }
    const entryEnd = position + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > central.byteLength) {
      fail("malformed-upload-archive");
    }
    const name = central.subarray(position + 46, position + 46 + nameLength);
    const extra = central.subarray(
      position + 46 + nameLength,
      position + 46 + nameLength + extraLength
    );
    const sizes = readZip64Extra(extra, compressedSize, uncompressedSize, localOffset);
    if (
      sizes.compressedSize > limits.maxEntryUncompressedBytes
      || sizes.uncompressedSize > limits.maxEntryUncompressedBytes
    ) {
      fail("upload-entry-size-limit");
    }
    if (
      sizes.localOffset > archiveBytes
      || sizes.compressedSize > archiveBytes
      || sizes.localOffset + sizes.compressedSize > archiveBytes
    ) {
      fail("malformed-upload-archive");
    }
    totalUncompressedBytes += sizes.uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      fail("upload-total-entry-size-limit");
    }
    const fileName = (flags & 0x0800) !== 0
      ? (() => {
        try {
          return decoder.decode(name);
        } catch {
          fail("malformed-upload-archive");
        }
      })()
      : decodeEntryName(name, false);
    const isDirectory = fileName.endsWith("/") || (externalAttributes & 0x10) !== 0;
    if (!isDirectory && normalizeUploadEntryPath(fileName) === expectedUploadPath) {
      matches.push({
        name: Buffer.from(name),
        flags,
        method,
        crc32,
        compressedSize: sizes.compressedSize,
        uncompressedSize: sizes.uncompressedSize,
        localOffset: sizes.localOffset,
        externalAttributes
      });
    }
    position = entryEnd;
    parsedEntries += 1;
  }

  if (position < central.byteLength && central.readUInt32LE(position) !== DIGITAL_SIGNATURE) {
    fail("malformed-upload-archive");
  }
  if (parsedEntries !== entries) {
    fail("malformed-upload-archive");
  }
  if (matches.length !== 1) {
    fail(matches.length === 0 ? "missing-upload-entry" : "duplicate-upload-entry");
  }
  const entry = matches[0]!;
  if (
    isZipSymbolicLink(entry.externalAttributes)
    || (entry.flags & 0x0001) !== 0
    || (entry.method !== 0 && entry.method !== 8)
  ) {
    fail("unsupported-upload-entry");
  }
  return entry;
}

async function entryDataOffset(
  handle: Awaited<ReturnType<typeof open>>,
  archiveBytes: number,
  entry: ZipEntry
) {
  const header = await readExact(handle, entry.localOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    fail("malformed-upload-archive");
  }
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  if (flags !== entry.flags || method !== entry.method) {
    fail("malformed-upload-archive");
  }
  const nameOffset = entry.localOffset + 30;
  const dataOffset = nameOffset + nameLength + extraLength;
  if (
    !Number.isSafeInteger(dataOffset)
    || dataOffset < 0
    || dataOffset + entry.compressedSize > archiveBytes
  ) {
    fail("malformed-upload-archive");
  }
  const name = await readExact(handle, nameOffset, nameLength);
  if (!name.equals(entry.name)) {
    fail("malformed-upload-archive");
  }
  return dataOffset;
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(current: number, chunk: Buffer) {
  let value = current;
  for (const byte of chunk) {
    value = crc32Table[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

class EntryVerificationTransform extends Transform {
  private bytes = 0;
  private crc32 = 0xffffffff;
  private readonly hash = createHash("sha256");
  private readonly keyedHash: ReturnType<typeof createHmac> | null;

  constructor(
    private readonly expectedBytes: number,
    private readonly expectedCrc32: number,
    keyedDigest: UploadEntryKeyedDigest | undefined
  ) {
    super();
    if (
      keyedDigest !== undefined
      && (
        keyedDigest.key.byteLength < 32
        || keyedDigest.context.length === 0
        || keyedDigest.context.includes("\0")
      )
    ) {
      fail("invalid-keyed-upload-digest");
    }
    this.keyedHash = keyedDigest === undefined
      ? null
      : createHmac("sha256", keyedDigest.key)
        .update("wprm-media-binding-v1\0", "utf8")
        .update(keyedDigest.context, "utf8")
        .update("\0", "utf8");
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += value.byteLength;
    if (this.bytes > this.expectedBytes) {
      callback(new UploadMediaError("upload-entry-size-mismatch"));
      return;
    }
    this.crc32 = updateCrc32(this.crc32, value);
    this.hash.update(value);
    this.keyedHash?.update(value);
    callback(null, value);
  }

  result(): VerifiedUploadMedia {
    if (this.bytes !== this.expectedBytes || ((this.crc32 ^ 0xffffffff) >>> 0) !== this.expectedCrc32) {
      fail("upload-entry-integrity-failed");
    }
    return {
      bytes: this.bytes,
      sha256: this.hash.digest("hex"),
      keyedSha256: this.keyedHash?.digest("hex") ?? null
    };
  }
}

async function verifyEntryToWritable(
  handle: Awaited<ReturnType<typeof open>>,
  archiveBytes: number,
  entry: ZipEntry,
  writable: Writable,
  keyedDigest: UploadEntryKeyedDigest | undefined
) {
  const dataOffset = await entryDataOffset(handle, archiveBytes, entry);
  const input = Readable.from(entryChunks(handle, dataOffset, entry.compressedSize));
  const verifier = new EntryVerificationTransform(
    entry.uncompressedSize,
    entry.crc32,
    keyedDigest
  );
  if (entry.method === 8) {
    await pipeline(input, createInflateRaw(), verifier, writable);
  } else {
    await pipeline(input, verifier, writable);
  }
  return verifier.result();
}

async function* entryChunks(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  bytes: number
) {
  let position = start;
  let remaining = bytes;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
    const result = await handle.read(buffer, 0, buffer.byteLength, position);
    if (result.bytesRead === 0) {
      fail("malformed-upload-archive");
    }
    position += result.bytesRead;
    remaining -= result.bytesRead;
    yield buffer.subarray(0, result.bytesRead);
  }
}

function writableForHandle(handle: Awaited<ReturnType<typeof open>>) {
  let position = 0;
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const write = async () => {
        let offset = 0;
        while (offset < value.byteLength) {
          const result = await handle.write(
            value,
            offset,
            value.byteLength - offset,
            position + offset
          );
          if (result.bytesWritten === 0) {
            fail("media-copy-failed");
          }
          offset += result.bytesWritten;
        }
        position += value.byteLength;
      };
      void write().then(
        () => callback(),
        (error: unknown) => callback(error instanceof Error ? error : new Error("media-copy-failed"))
      );
    }
  });
}

export async function openVerifiedUploadArchive(
  archivePath: string,
  inputLimits?: Partial<UploadArchiveLimits>
) {
  const limits = mergeLimits(inputLimits);
  let stats;
  try {
    stats = await lstat(archivePath);
  } catch (error) {
    if (isMissing(error)) {
      fail("missing-upload-archive");
    }
    fail("invalid-upload-archive");
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > limits.maxArchiveBytes) {
    fail("invalid-upload-archive");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (
      !handleStats.isFile()
      || handleStats.size !== stats.size
      || handleStats.size > limits.maxArchiveBytes
      || handleStats.dev !== stats.dev
      || handleStats.ino !== stats.ino
    ) {
      fail("invalid-upload-archive");
    }
    const archive = new VerifiedUploadArchive(handle, handleStats.size, limits);
    handle = undefined;
    return archive;
  } catch (error) {
    await handle?.close();
    if (error instanceof UploadMediaError) {
      throw error;
    }
    fail("invalid-upload-archive");
  }
}

export async function hashVerifiedOpenUploadArchiveEntry(
  archive: VerifiedUploadArchive,
  expectedUploadPath: string,
  options: UploadEntryVerificationOptions = {}
) {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  return archive.verifyEntry(expectedUploadPath, sink, {
    ...(options.keyedDigest === undefined
      ? {}
      : { keyedDigest: options.keyedDigest })
  });
}

export async function copyVerifiedOpenUploadArchiveEntry(
  archive: VerifiedUploadArchive,
  expectedUploadPath: string,
  destination: string,
  options: CopyUploadEntryVerificationOptions = {}
) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(
      destination,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    await options.onDestinationCreated?.();
    const stats = await handle.stat();
    if (!stats.isFile()) {
      fail("unsafe-media-destination");
    }
    const writable = writableForHandle(handle);
    const verified = await archive.verifyEntry(expectedUploadPath, writable, {
      ...(options.keyedDigest === undefined
        ? {}
        : { keyedDigest: options.keyedDigest })
    });
    await handle.sync();
    return verified;
  } catch (error) {
    if (created) {
      try {
        await unlink(destination);
      } catch {
        // Preserve the verification or write error.
      }
    }
    if (error instanceof UploadMediaError) {
      throw error;
    }
    fail("media-copy-failed");
  } finally {
    await handle?.close();
  }
}

export async function hashVerifiedUploadArchiveEntry(
  archivePath: string,
  expectedUploadPath: string,
  inputLimits?: Partial<UploadArchiveLimits>
) {
  const archive = await openVerifiedUploadArchive(archivePath, inputLimits);
  try {
    return await hashVerifiedOpenUploadArchiveEntry(archive, expectedUploadPath);
  } finally {
    await archive.close();
  }
}

export async function copyVerifiedUploadArchiveEntry(
  archivePath: string,
  expectedUploadPath: string,
  destination: string,
  inputLimits?: Partial<UploadArchiveLimits>
) {
  const archive = await openVerifiedUploadArchive(archivePath, inputLimits);
  try {
    return await copyVerifiedOpenUploadArchiveEntry(
      archive,
      expectedUploadPath,
      destination
    );
  } finally {
    await archive.close();
  }
}
