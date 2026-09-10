import path from "node:path";
import { parseExactRedirectManifest } from "../content/redirect-manifest";
import { validateLegacyNavigationOutput } from "../../scripts/legacy-navigation";
import { readBoundedDeploymentFile } from "../../scripts/deployment-files";

export function assertReleaseDeploymentIntegration(projectRoot: string = process.cwd()) {
  const manifest: unknown = JSON.parse(readBoundedDeploymentFile(
    projectRoot, ".deployment/redirect-manifest.json", 4 * 1024 * 1024
  ).toString("utf8"));
  validateLegacyNavigationOutput(
    parseExactRedirectManifest(manifest),
    path.join(projectRoot, "out")
  );
}
