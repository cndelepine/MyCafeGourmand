import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  maxImageDimensionProbeBytes,
  parseImageDimensions
} from "../scripts/wordpress/image-dimensions";

test("image dimensions are read from bounded authenticated image bytes", async () => {
  const png = await sharp({
    create: {
      width: 592,
      height: 800,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png().toBuffer();
  const jpeg = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).jpeg().toBuffer();
  const avif = await sharp({
    create: {
      width: 592,
      height: 800,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).avif().toBuffer();
  const orientedJpeg = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const falseAvifBrand = Buffer.alloc(16);
  falseAvifBrand.writeUInt32BE(16, 0);
  falseAvifBrand.write("ftyp", 4, "ascii");
  falseAvifBrand.write("mif1", 8, "ascii");
  falseAvifBrand.write("avif", 12, "ascii");

  assert.deepEqual(await parseImageDimensions(png, "image/png"), {
    width: 592,
    height: 800
  });
  assert.deepEqual(await parseImageDimensions(jpeg, "image/jpeg"), {
    width: 1200,
    height: 800
  });
  assert.deepEqual(await parseImageDimensions(avif, "image/avif"), {
    width: 592,
    height: 800
  });
  assert.deepEqual(await parseImageDimensions(orientedJpeg, "image/jpeg"), {
    width: 20,
    height: 40
  });
  assert.equal(await parseImageDimensions(falseAvifBrand, "image/avif"), null);
  assert.equal(await parseImageDimensions(avif, "image/png"), null);
  assert.equal(await parseImageDimensions(Buffer.from("not an image"), "image/jpeg"), null);
  assert.equal(
    await parseImageDimensions(Buffer.alloc(maxImageDimensionProbeBytes + 1), "image/png"),
    null
  );
});
