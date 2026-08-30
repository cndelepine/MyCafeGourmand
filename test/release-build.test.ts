import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { runReleaseBuild } from "../scripts/build-release";
import {
  runStaticBuild,
  runWithDeploymentMetadataInvalidation
} from "../scripts/build-static";
import {
  assertRecipeMediaBuildEnvironment,
  recipeMediaBaseUrlEnvironmentVariable
} from "../src/lib/recipe-media";
import { assertReleaseDeploymentIntegration } from "../src/lib/release-deployment";

type PackageScripts = Readonly<Record<string, string>>;

function withTempDirectory<T>(callback: (directory: string) => T) {
  const directory = mkdtempSync(path.join(process.cwd(), ".release-build-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function seedDeploymentMetadata(projectRoot: string) {
  const metadataRoot = path.join(projectRoot, ".deployment");
  mkdirSync(metadataRoot);
  writeFileSync(
    path.join(metadataRoot, "redirect-manifest.json"),
    "{\"stale\":true}\n"
  );
  return metadataRoot;
}

function packageScripts() {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
  ) as { scripts?: unknown };
  assert.ok(packageJson.scripts !== null && typeof packageJson.scripts === "object");
  return packageJson.scripts as PackageScripts;
}

function environment(overrides: Readonly<Record<string, string>>) {
  return { ...process.env, ...overrides };
}

test("only the guarded release command can produce a deployable static artifact", () => {
  const scripts = packageScripts();
  assert.equal(scripts.build, "npm run build:ci");
  assert.equal(scripts["build:release"], "tsx scripts/build-release.ts");
  assert.equal(scripts["build:static"], "tsx scripts/build-static.ts");
  assert.equal(scripts["build:ci"], "npm run build:static");
  assert.equal(scripts["build:local"], "npm run build:static");
  assert.equal(
    scripts["deployment:generate"],
    "tsx scripts/generate-deployment-artifacts.ts"
  );
  assert.equal(
    scripts["staticwebapp:generate"],
    scripts["deployment:generate"]
  );
  assert.match(
    scripts["release:validate"],
    /validate-release-contact-form/u
  );
  assert.match(
    readFileSync(path.resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8"),
    /npm run build:ci/u
  );
});

test("release builds remain blocked until exact redirects have a deployment adapter", () => {
  assert.throws(
    () => assertReleaseDeploymentIntegration(),
    /blocked until an exact-redirect edge adapter consumes \.deployment\/redirect-manifest\.json/u
  );
  withTempDirectory((projectRoot) => {
    const metadataRoot = seedDeploymentMetadata(projectRoot);
    assert.throws(
      () => runReleaseBuild(
        ["node", "scripts/build-release.ts"],
        { ...process.env, npm_lifecycle_event: "build:release" },
        projectRoot
      ),
      /Release build is blocked/u
    );
    assert.equal(existsSync(metadataRoot), false);
  });
});

test("non-release builds reject a configured public media base before running Next", () => {
  assert.throws(
    () => assertRecipeMediaBuildEnvironment("non-release", environment({
      [recipeMediaBaseUrlEnvironmentVariable]: "https://media.example.test/container"
    })),
    /only permitted/
  );
  assert.throws(
    () => assertRecipeMediaBuildEnvironment("release", environment({
      [recipeMediaBaseUrlEnvironmentVariable]: "https://media.example.test/container"
    })),
    /explicit npm run build:release/
  );
  assert.doesNotThrow(() => assertRecipeMediaBuildEnvironment("release", environment({
    [recipeMediaBaseUrlEnvironmentVariable]: "https://media.example.test/container",
    MY_CAFE_GOURMAND_RELEASE_BUILD: "1",
    npm_lifecycle_event: "build:release"
  })));

  withTempDirectory((projectRoot) => {
    const metadataRoot = seedDeploymentMetadata(projectRoot);
    assert.throws(
      () => runStaticBuild("non-release", environment({
        [recipeMediaBaseUrlEnvironmentVariable]:
          "https://media.example.test/container"
      }), projectRoot),
      /NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL is only permitted/u
    );
    assert.equal(existsSync(metadataRoot), false);
  });
});

test("post-publication validation failures invalidate current deployment metadata", () => {
  withTempDirectory((projectRoot) => {
    const metadataRoot = path.join(projectRoot, ".deployment");
    assert.throws(
      () => runWithDeploymentMetadataInvalidation(() => {
        seedDeploymentMetadata(projectRoot);
        throw new Error("post-publication-validation-failed");
      }, projectRoot),
      /post-publication-validation-failed/u
    );
    assert.equal(existsSync(metadataRoot), false);
  });
});
