import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  parseExactRedirectManifest,
  type ExactRedirect,
  type ExactRedirectManifest
} from "../src/content/redirect-manifest";
import {
  portablePathComponentKey,
  validateSafeLocalPath
} from "../src/content/url-path";

export const productionSiteOrigin = "https://mycafegourmand.com";
const legacyMarker = '<meta name="generator" content="mycafegourmand-legacy-navigation">';
const copy = {
  en: { title: "Page moved", link: "Continue to the page" },
  fr: { title: "Page déplacée", link: "Continuer vers la page" },
  ru: { title: "Страница перемещена", link: "Перейти на страницу" }
};

export function getLegacyPageOutputPath(source: string) {
  validateSafeLocalPath(source, "Legacy navigation source");
  if (source === "/" || source.includes("//")) {
    throw new Error(`Unsupported legacy navigation source: ${source}`);
  }
  const segments = source.replace(/\/$/u, "").slice(1).split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (
      decoded.includes("%")
      || decoded !== decoded.normalize("NFC")
      || /\s/u.test(decoded)
    ) {
      throw new Error(`Ambiguous legacy navigation path component: ${segment}`);
    }
    portablePathComponentKey(decoded, "Legacy navigation path");
    return decoded;
  });
  return `${segments.join("/")}/index.html`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

export function renderLegacyPage(redirect: ExactRedirect) {
  validateSafeLocalPath(redirect.destination, "Legacy navigation destination");
  if (!redirect.destination.endsWith("/")) {
    throw new Error("Legacy navigation destination must be a canonical directory path.");
  }
  const locale = redirect.destination.startsWith("/fr/")
    ? "fr"
    : redirect.destination.startsWith("/ru/") ? "ru" : "en";
  const text = copy[locale];
  const destination = escapeHtml(new URL(redirect.destination, productionSiteOrigin).href);
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${legacyMarker}
<meta http-equiv="refresh" content="0;url=${destination}">
<link rel="canonical" href="${destination}">
<title>${text.title}</title>
</head>
<body><h1>${text.title}</h1><p><a href="${destination}">${text.link}</a></p></body>
</html>
`;
}

function portableKey(relativePath: string) {
  return relativePath.split("/").map((segment) =>
    portablePathComponentKey(segment, "Static export path")
  ).join("/");
}

function inspectOutput(root: string) {
  const entries = new Map<string, { relative: string; directory: boolean }>();
  const visit = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const fullPath = path.join(directory, entry.name);
      const stats = lstatSync(fullPath);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        throw new Error(`Static output must contain only regular files/directories: ${relative}`);
      }
      const key = portableKey(relative);
      if (entries.has(key)) {
        throw new Error(`Portable static output path collision: ${relative}`);
      }
      entries.set(key, { relative, directory: stats.isDirectory() });
      if (stats.isDirectory()) {
        visit(fullPath, `${relative}/`);
      }
    }
  };
  const stats = lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Legacy navigation output must be a regular directory.");
  }
  visit(root, "");
  return entries;
}

function plannedPages(manifest: ExactRedirectManifest) {
  const validated = parseExactRedirectManifest(manifest);
  const pages = new Map<string, { relative: string; contents: string }>();
  const directories = new Map<string, string>();
  for (const redirect of validated.redirects) {
    const relative = getLegacyPageOutputPath(redirect.source);
    const key = portableKey(relative);
    if (pages.has(key)) {
      throw new Error(`Legacy navigation output collision: ${redirect.source}`);
    }
    const segments = relative.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const directory = segments.slice(0, length).join("/");
      const directoryKey = portableKey(directory);
      const previous = directories.get(directoryKey);
      if (previous !== undefined && previous !== directory) {
        throw new Error(`Portable legacy navigation directory collision: ${directory}`);
      }
      directories.set(directoryKey, directory);
    }
    pages.set(key, { relative, contents: renderLegacyPage(redirect) });
  }
  for (const directory of directories.keys()) {
    if (pages.has(directory)) {
      throw new Error("Legacy navigation file/directory conflict.");
    }
  }
  return pages;
}

export function generateLegacyNavigation(
  manifest: ExactRedirectManifest,
  outputDirectory: string
) {
  const root = path.resolve(outputDirectory);
  const pages = plannedPages(manifest);
  const existing = inspectOutput(root);
  for (const [key, page] of pages) {
    const occupied = existing.get(key);
    if (occupied !== undefined) {
      throw new Error(`Legacy navigation would overwrite static output: ${page.relative}`);
    }
    const segments = page.relative.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const prefix = portableKey(segments.slice(0, length).join("/"));
      const ancestor = existing.get(prefix);
      if (ancestor !== undefined && (
        !ancestor.directory || ancestor.relative !== segments.slice(0, length).join("/")
      )) {
        throw new Error(`Legacy navigation path conflicts with static output: ${page.relative}`);
      }
      if (pages.has(prefix)) {
        throw new Error(`Legacy navigation file/directory conflict: ${page.relative}`);
      }
    }
  }
  for (const page of pages.values()) {
    const file = path.join(root, page.relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, page.contents, { encoding: "utf8", flag: "wx" });
  }
  validateLegacyNavigationOutput(manifest, root);
}

export function validateLegacyNavigationOutput(
  manifest: ExactRedirectManifest,
  outputDirectory: string
) {
  const root = path.resolve(outputDirectory);
  const pages = plannedPages(manifest);
  const existing = inspectOutput(root);
  for (const [key, page] of pages) {
    const actual = existing.get(key);
    if (actual === undefined || actual.directory || actual.relative !== page.relative) {
      throw new Error(`Missing or conflicting legacy navigation output: ${page.relative}`);
    }
    if (readFileSync(path.join(root, page.relative), "utf8") !== page.contents) {
      throw new Error(`Modified legacy navigation output: ${page.relative}`);
    }
  }
  for (const [key, entry] of existing) {
    if (
      !entry.directory && entry.relative.endsWith(".html")
      && !pages.has(key)
      && readFileSync(path.join(root, entry.relative), "utf8").includes(legacyMarker)
    ) {
      throw new Error(`Stale legacy navigation output: ${entry.relative}`);
    }
  }
}

export function assertFreshLegacyOutput(outputDirectory: string) {
  if (!existsSync(outputDirectory)) {
    return;
  }
  const existing = inspectOutput(path.resolve(outputDirectory));
  for (const entry of existing.values()) {
    if (
      !entry.directory && entry.relative.endsWith(".html")
      && readFileSync(path.join(outputDirectory, entry.relative), "utf8").includes(legacyMarker)
    ) {
      throw new Error("Legacy pages already exist; run a fresh static build before generation.");
    }
  }
}
