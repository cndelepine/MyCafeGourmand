import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStaticBuild, runWithDeploymentMetadataInvalidation } from "./build-static";
import { writeFamilyTestArtifact } from "./family-test-artifact";
import { writeNewDeploymentFile } from "./deployment-files";
import { validateSiteOrigin } from "./verify-deployed-site";

export function buildFamilyBootstrap(root: string, origin: string) {
  validateSiteOrigin(origin, "staging");
  if (existsSync(path.join(root, "out")) || existsSync(path.join(root, ".deployment"))) {
    throw new Error("Bootstrap needs a fresh checkout without output or deployment metadata.");
  }
  return runWithDeploymentMetadataInvalidation(() => {
    mkdirSync(path.join(root, "out"));
    mkdirSync(path.join(root, ".deployment"));
    copyFileSync(path.join(root, "config/staticwebapp.config.json"), path.join(root, "out/staticwebapp.config.json"));
    writeNewDeploymentFile(path.join(root, ".deployment/redirect-manifest.json"),
      JSON.stringify({ schemaVersion: 2, mechanism: "html-refresh", redirects: [] }));
    return writeFamilyTestArtifact(root, origin, null, "bootstrap");
  }, root);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    if (process.argv.length !== 2) throw new Error("Family builds do not accept arguments.");
    if (process.env.npm_lifecycle_event === "family-test:bootstrap") {
      buildFamilyBootstrap(process.cwd(), process.env.FAMILY_TEST_SITE_ORIGIN ?? "");
    } else {
      runStaticBuild("family-test");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Family test build failed.");
    process.exitCode = 1;
  }
}
