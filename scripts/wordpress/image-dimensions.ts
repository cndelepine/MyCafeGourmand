import sharp from "sharp";

export const maxImageDimensionProbeBytes = 1024 * 1024;

export type ImageDimensions = {
  readonly width: number;
  readonly height: number;
};

type SupportedImageMimeType =
  | "image/avif"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

function hasSignature(bytes: Buffer, mimeType: SupportedImageMimeType) {
  switch (mimeType) {
    case "image/jpeg":
      return bytes.length >= 3
        && bytes[0] === 0xff
        && bytes[1] === 0xd8
        && bytes[2] === 0xff;
    case "image/png":
      return bytes.length >= 8
        && bytes.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );
    case "image/gif":
      return bytes.length >= 6
        && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
    case "image/webp":
      return bytes.length >= 12
        && bytes.toString("ascii", 0, 4) === "RIFF"
        && bytes.toString("ascii", 8, 12) === "WEBP";
    case "image/avif": {
      if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") {
        return false;
      }
      const boxSize = bytes.readUInt32BE(0);
      if (boxSize < 16 || boxSize > bytes.length || boxSize % 4 !== 0) {
        return false;
      }
      if (["avif", "avis"].includes(bytes.toString("ascii", 8, 12))) {
        return true;
      }
      for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        if (["avif", "avis"].includes(bytes.toString("ascii", offset, offset + 4))) {
          return true;
        }
      }
      return false;
    }
  }
}

export async function parseImageDimensions(
  bytes: Buffer,
  mimeType: SupportedImageMimeType
): Promise<ImageDimensions | null> {
  if (
    bytes.length === 0
    || bytes.length > maxImageDimensionProbeBytes
    || !hasSignature(bytes, mimeType)
  ) {
    return null;
  }
  try {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    return Number.isSafeInteger(metadata.autoOrient.width)
      && metadata.autoOrient.width > 0
      && Number.isSafeInteger(metadata.autoOrient.height)
      && metadata.autoOrient.height > 0
      ? {
          width: metadata.autoOrient.width,
          height: metadata.autoOrient.height
        }
      : null;
  } catch {
    return null;
  }
}
