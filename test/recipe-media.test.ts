import assert from "node:assert/strict";
import test from "node:test";
import sitemap from "../src/app/sitemap";
import {
  createRecipeMediaManifest,
  validateRecipeMediaManifestClosure
} from "../src/content/media-manifest";
import { recipeRecordSchema } from "../src/content/schema";
import { validateMediaPaths } from "../src/content/validation";
import {
  getRecipeStructuredData
} from "../src/lib/recipe-structured-data";
import {
  getManagedMediaRemotePatterns,
  getRecipeMediaRemotePattern,
  requireRecipeMediaBaseUrl,
  resolveManagedMediaUrl,
  resolveRecipeMediaUrl
} from "../src/lib/recipe-media";
import { getRecipeMetadata } from "../src/lib/site";
import { recipeFixture } from "./fixtures/recipe";

const firstKey = "/recipes/media/wordpress/900.jpg";
const secondKey = "/recipes/media/wordpress/901.png";
const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);

function promotedFixture() {
  return recipeRecordSchema.parse({
    ...recipeFixture,
    recipe: {
      ...recipeFixture.recipe,
      heroMediaId: "wordpress-attachment:900",
      instructionGroups: recipeFixture.recipe.instructionGroups.map((group) => ({
        ...group,
        steps: group.steps.map((step) => ({
          ...step,
          mediaId: "wordpress-attachment:901"
        }))
      }))
    },
    media: [
      {
        ...recipeFixture.media[0]!,
        id: "wordpress-attachment:900",
        sourceId: "900",
        path: firstKey
      },
      {
        ...recipeFixture.media[1]!,
        id: "wordpress-attachment:901",
        sourceId: "901",
        path: secondKey
      }
    ]
  });
}

test("recipe media resolver preserves stable object keys under a safe HTTPS base", () => {
  assert.equal(
    resolveRecipeMediaUrl(firstKey, "https://media.example.test/recipe-container"),
    "https://media.example.test/recipe-container/recipes/media/wordpress/900.jpg"
  );
  assert.equal(
    resolveRecipeMediaUrl(firstKey, "https://media.example.test/recipe-container%2Dpublic/"),
    "https://media.example.test/recipe-container%2Dpublic/recipes/media/wordpress/900.jpg"
  );
  assert.equal(
    resolveRecipeMediaUrl("/recipes/fixture-recipe/hero.png", "https://media.example.test"),
    "/recipes/fixture-recipe/hero.png"
  );
  assert.equal(resolveRecipeMediaUrl(firstKey, undefined), firstKey);
  assert.deepEqual(
    getRecipeMediaRemotePattern("https://media.example.test/recipe-container/"),
    {
      protocol: "https",
      hostname: "media.example.test",
      port: "",
      pathname: "/recipe-container/recipes/media/wordpress/**"
    }
  );
  assert.equal(
    resolveManagedMediaUrl(
      "/editorial/media/wordpress/81.jpg",
      "https://media.example.test/recipe-container"
    ),
    "https://media.example.test/recipe-container/editorial/media/wordpress/81.jpg"
  );
  assert.deepEqual(
    getManagedMediaRemotePatterns("https://media.example.test/recipe-container/").map(
      (pattern) => pattern.pathname
    ),
    [
      "/recipe-container/recipes/media/wordpress/**",
      "/recipe-container/editorial/media/wordpress/**",
      "/recipe-container/gallery/media/wordpress-bwg/**"
    ]
  );
});

test("recipe media resolver rejects path escape and base URL confusion", () => {
  for (const mediaPath of [
    "//attacker.example/image.jpg",
    "/recipes/media/wordpress/900.jpg?x=1",
    "/recipes/media/wordpress/%2e%2e%2f900.jpg",
    "/recipes/media/wordpress/900.svg"
  ]) {
    assert.throws(() => resolveRecipeMediaUrl(mediaPath, "https://media.example.test"));
  }
  assert.throws(
    () => resolveManagedMediaUrl(
      "/editorial/media/wordpress/%2e%2e%2f900.jpg",
      "https://media.example.test"
    ),
    /unsafe separator|traversal/
  );
  for (const baseUrl of [
    "http://media.example.test",
    "https://user:pass@media.example.test",
    "https://media.example.test/container?token=secret",
    "https://media.example.test/container#fragment",
    "https://media.example.test/%2e%2e/private",
    "https://media.example.test@attacker.example/container"
  ]) {
    assert.throws(() => resolveRecipeMediaUrl(firstKey, baseUrl));
  }
  assert.throws(() => requireRecipeMediaBaseUrl(undefined), /required for a release build/);
  assert.equal(
    requireRecipeMediaBaseUrl("https://media.example.test/container").hostname,
    "media.example.test"
  );
});

test("media manifests require canonical entries, hashes, and closed recipe references", () => {
  const manifest = createRecipeMediaManifest([
    {
      key: secondKey,
      bytes: 12,
      sha256: secondHash,
      sourceAttachmentId: "901"
    },
    {
      key: firstKey,
      bytes: 10,
      sha256: firstHash,
      sourceAttachmentId: "900"
    }
  ]);
  assert.deepEqual(manifest.entries.map((entry) => entry.key), [firstKey, secondKey]);
  assert.doesNotThrow(() => validateRecipeMediaManifestClosure([promotedFixture()], manifest));
  assert.doesNotThrow(() => validateMediaPaths([promotedFixture()], process.cwd(), manifest));
  assert.throws(
    () => validateMediaPaths([promotedFixture()], process.cwd()),
    /requires a validated media manifest/
  );

  assert.throws(() => createRecipeMediaManifest([
    {
      key: firstKey,
      bytes: 10,
      sha256: firstHash,
      sourceAttachmentId: "901"
    }
  ]), /attachment ID does not match/);

  const missing = createRecipeMediaManifest([{
    key: firstKey,
    bytes: 10,
    sha256: firstHash,
    sourceAttachmentId: "900"
  }]);
  assert.throws(
    () => validateRecipeMediaManifestClosure([promotedFixture()], missing),
    /absent from the media manifest/
  );

  const unreferenced = createRecipeMediaManifest([
    {
      key: firstKey,
      bytes: 10,
      sha256: firstHash,
      sourceAttachmentId: "900"
    },
    {
      key: secondKey,
      bytes: 12,
      sha256: secondHash,
      sourceAttachmentId: "901"
    },
    {
      key: "/recipes/media/wordpress/902.webp",
      bytes: 9,
      sha256: "c".repeat(64),
      sourceAttachmentId: "902"
    }
  ]);
  assert.throws(
    () => validateRecipeMediaManifestClosure([promotedFixture()], unreferenced),
    /not referenced/
  );
});

test("SEO media consumers use the shared Blob resolver", () => {
  const previous = process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL;
  process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL =
    "https://media.example.test/recipe-container";
  try {
    const recipe = promotedFixture();
    const structured = getRecipeStructuredData(recipe);
    assert.equal(
      structured.image?.[0],
      "https://media.example.test/recipe-container/recipes/media/wordpress/900.jpg"
    );
    assert.equal(
      structured.recipeInstructions[0]?.image,
      "https://media.example.test/recipe-container/recipes/media/wordpress/901.png"
    );
    const metadata = getRecipeMetadata(recipe, [recipe]);
    assert.equal(
      JSON.stringify(metadata.openGraph),
      JSON.stringify({
        type: "article",
        title: recipe.title,
        description: recipe.description,
        url: "https://mycafegourmand.com/recipes/fixture-recipe/",
        siteName: "My Café Gourmand",
        locale: "en_US",
        images: [{
          url: "https://media.example.test/recipe-container/recipes/media/wordpress/900.jpg",
          width: 640,
          height: 480,
          alt: "Sanitized fixture recipe hero"
        }]
      })
    );
    assert.equal(
      JSON.stringify(sitemap()).includes(
        "https://media.example.test/recipe-container/recipes/media/wordpress/"
      ),
      true
    );
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL = previous;
    }
  }
});
