import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExactRedirectManifest } from "../src/content/redirect-manifest";
import { generateLegacyNavigation } from "../scripts/legacy-navigation";
import { writeReleaseArtifactMetadata } from "../scripts/release-artifact";

export function releaseFixture() {
  const base = path.join(process.cwd(), `.artifact-test-${randomUUID()}`);
  const root = path.join(base, "production");
  mkdirSync(path.join(root, "out"), { recursive: true });
  mkdirSync(path.join(root, ".deployment"));
  const manifest: ExactRedirectManifest = {
    schemaVersion: 2,
    mechanism: "html-refresh",
    redirects: [
      { source: "/old", destination: "/recipes/new/" },
      { source: "/ru/%d0%ba%d0%be%d1%82/", destination: "/ru/recipes/кот/" },
      { source: "/fr/café/", destination: "/fr/recipes/café/" }
    ]
  };
  const pages = [
    "/", "/recipes/new/", "/ru/recipes/кот/", "/fr/recipes/café/",
    "/archive/"
  ];
  for (const route of pages) {
    const directory = path.join(root, "out", route);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "index.html"),
      `<!doctype html><html><head>${route === "/archive/"
        ? '<meta name="robots" content="noindex, follow">' : ""}</head><body>${route}</body></html>`);
  }
  writeFileSync(path.join(root, "out", "staticwebapp.config.json"),
    JSON.stringify({ trailingSlash: "always", globalHeaders: { "X-Content-Type-Options": "nosniff" } }));
  writeFileSync(path.join(root, "out", "app.js"), "console.log('fixture');\n");
  writeFileSync(path.join(root, "out", "style.css"), "body { color: black; }\n");
  writeFileSync(path.join(root, ".deployment", "redirect-manifest.json"), JSON.stringify(manifest));
  generateLegacyNavigation(manifest, path.join(root, "out"));
  writeReleaseArtifactMetadata(root);
  return { base, root, manifest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
