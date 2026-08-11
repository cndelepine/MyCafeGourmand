import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRecipeMediaManifest } from "../src/content/media-manifest";
import {
  ReleaseMediaOutputValidationError,
  validateReleaseMediaOutput
} from "../scripts/validate-release-media-output";

const base = "https://media.example.test/recipe-container";
const absoluteMedia = `${base}/recipes/media/wordpress/900.jpg`;
const localMedia = "/recipes/media/wordpress/900.jpg";
const wrongMedia = "https://other.example.test/recipe-container/recipes/media/wordpress/900.jpg";

function mediaManifest() {
  return createRecipeMediaManifest([{
    key: localMedia,
    bytes: 12,
    sha256: "a".repeat(64),
    sourceAttachmentId: "900"
  }]);
}

function withOutput(
  files: Readonly<Record<string, string>>,
  callback: (outputDirectory: string) => void
) {
  const directory = mkdtempSync(path.join(process.cwd(), ".release-media-output-test-"));
  const outputDirectory = path.join(directory, "out");
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const destination = path.join(outputDirectory, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content, "utf8");
    }
    callback(outputDirectory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("release output validation scans HTML, JSON-LD, Flight payloads, and inline Flight scripts", () => {
  withOutput({
    "index.html": [
      `<link href="${absoluteMedia}">`,
      `<meta content="${absoluteMedia}">`,
      `<img src="${absoluteMedia}">`,
      `<img srcset="${absoluteMedia} 1x, ${absoluteMedia} 2x">`,
      `<script type="application/ld+json">${JSON.stringify({ image: absoluteMedia })}</script>`,
      `<script>self.__next_f.push([1,${JSON.stringify(absoluteMedia)}])</script>`
    ].join(""),
    "assets/site.css": `.hero { background-image: url("${absoluteMedia}"); }`,
    "recipes/example/index.txt": `["$","img",{"src":${JSON.stringify(absoluteMedia)}}]`
  }, (outputDirectory) => {
    assert.deepEqual(
      validateReleaseMediaOutput({
        mediaBaseUrl: base,
        mediaManifest: mediaManifest(),
        outputDirectory
      }),
      { documents: 3, mediaUrls: 9 }
    );
  });
});

test("release output validation rejects wrong media URLs in every runtime payload format", () => {
  const cases: ReadonlyArray<Readonly<Record<string, string>>> = [
    { "index.html": `<img src="${localMedia}">` },
    {
      "index.html":
        `<script type="application/ld+json">${JSON.stringify({ image: localMedia })}</script>`
    },
    { "recipes/example/index.txt": `["$","img",{"src":${JSON.stringify(localMedia)}}]` },
    {
      "index.html":
        `<script>self.__next_f.push([1,${JSON.stringify(wrongMedia).replaceAll("/", "\\/")}])</script>`
    },
    { "assets/site.css": `.hero { background-image: url(${wrongMedia}); }` }
  ];
  for (const files of cases) {
    withOutput(files, (outputDirectory) => {
      assert.throws(
        () => validateReleaseMediaOutput({
          mediaBaseUrl: base,
          mediaManifest: mediaManifest(),
          outputDirectory
        }),
        ReleaseMediaOutputValidationError
      );
    });
  }
});
