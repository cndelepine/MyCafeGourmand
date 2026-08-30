import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertRecipeMediaBuildEnvironment,
  recipeMediaBaseUrlEnvironmentVariable
} from "../src/lib/recipe-media";
import { assertReleaseDeploymentIntegration } from "../src/lib/release-deployment";

type PackageScripts = Readonly<Record<string, string>>;

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

  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build:release"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /release-build-failed: Release build is blocked/u
  );
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

  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "build:static"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        [recipeMediaBaseUrlEnvironmentVariable]: "https://media.example.test/container"
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL is only permitted/u
  );
});
