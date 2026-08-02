#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  loadRecipeCatalog
} from "../src/content/catalog";
import type { Locale, RecipeRecord } from "../src/content/schema";
import {
  getLocaleHomePath,
  getRecipePath,
  supportedLocales
} from "../src/lib/recipe-routes";

const allowedRecordHosts = new Set([
  "mycafegourmand.com",
  "www.mycafegourmand.com"
]);
const allowedLiveSitemapHosts = allowedRecordHosts;
const waybackHost = "web.archive.org";
const maxRedirects = 3;

export const defaultInventoryLimits = {
  maxDepth: 5,
  maxDocuments: 100,
  maxUrls: 10_000,
  maxDocumentBytes: 5_000_000,
  requestTimeoutMs: 30_000
} as const;

type InventoryLimitKey = keyof typeof defaultInventoryLimits;

export type InventoryLimits = {
  [Key in InventoryLimitKey]: number;
};

export type InventoryIssue = {
  code:
    | "comparison-failed"
    | "duplicate-sitemap"
    | "duplicate-url"
    | "fetch-failed"
    | "invalid-record-url"
    | "invalid-sitemap-source"
    | "malformed-xml"
    | "missing-location"
    | "off-domain-url"
    | "sitemap-cycle"
    | "sitemap-depth-limit"
    | "sitemap-document-limit"
    | "sitemap-url-limit"
    | "unexpected-root"
    | "unsupported-xml";
  message: string;
  source?: string;
  url?: string;
};

export type SitemapSourceStatus =
  | "cycle"
  | "duplicate"
  | "fetch-failed"
  | "limit"
  | "malformed-xml"
  | "parsed"
  | "queued"
  | "unexpected-root";

export type SitemapSourceMetadata = {
  source: string;
  fetchSource: string;
  effectiveFetchSource?: string;
  depth: number;
  family: string;
  name: string;
  status: SitemapSourceStatus;
  discoveredFrom?: string;
};

export type HreflangAlternate = {
  hreflang: string;
  originalUrl: string;
  normalizedUrl?: string;
  path?: string;
};

export type InventoryUrlEntry = {
  originalUrl: string;
  normalizedUrl: string;
  path: string;
  locale: Locale;
  sourceSitemap: {
    family: string;
    name: string;
  };
  lastmod?: string;
  imageUrls: string[];
  hreflangAlternates: HreflangAlternate[];
};

export type ComparisonStatus =
  | "discovered-only"
  | "current-covered"
  | "legacy-covered";

export type ComparisonEntry = {
  path: string;
  status: ComparisonStatus;
};

export type InventoryComparison = {
  entries: ComparisonEntry[];
  discoveredOnly: string[];
  currentCovered: string[];
  legacyCovered: string[];
  knownCurrentPaths: string[];
  knownLegacyPaths: string[];
};

export type UrlInventoryOutput = {
  schemaVersion: 1;
  discoveryOnly: true;
  purpose: string;
  rootSource: SitemapSourceMetadata;
  childSitemapSources: SitemapSourceMetadata[];
  urls: InventoryUrlEntry[];
  errors: InventoryIssue[];
  comparison: InventoryComparison;
};

export type SitemapFetchResult = {
  body: string | Uint8Array;
  status?: number;
  finalSource?: string;
  contentEncoding?: string;
  contentType?: string;
};

export type SitemapFetcher = (
  source: string,
  limits: InventoryLimits
) => Promise<string | SitemapFetchResult> | string | SitemapFetchResult;

export type UrlInventoryOptions = {
  sitemap: string;
  limits?: Partial<InventoryLimits>;
  catalog?: readonly RecipeRecord[];
  recipesRoot?: string;
  compare?: boolean;
  fetch?: SitemapFetcher;
  fetchDocument?: SitemapFetcher;
};

type RawSitemapChild = {
  loc: string;
  lastmod?: string;
};

type RawSitemapUrl = {
  loc: string;
  lastmod?: string;
  imageUrls: string[];
  alternates: Array<{
    hreflang: string;
    href: string;
  }>;
};

type ParsedSitemap =
  | {
      kind: "index";
      children: RawSitemapChild[];
    }
  | {
      kind: "urlset";
      urls: RawSitemapUrl[];
    };

type SourceTask = {
  source: string;
  fetchSource: string;
  effectiveFetchSource?: string;
  depth: number;
  discoveredFrom?: string;
  lineage: string[];
};

type CandidateUrl = InventoryUrlEntry & {
  sourceKey: string;
};

type WaybackCapture = {
  prefix: string;
  originalSource: string;
};

type XmlObject = Record<string, unknown>;

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  isArray: (name: string) =>
    ["image", "link", "sitemap", "url"].includes(name.replace(/^.*:/, "")),
  parseTagValue: false,
  removeNSPrefix: true,
  textNodeName: "#text",
  trimValues: true
});

function isRecord(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

function childValues(parent: XmlObject, name: string): unknown[] {
  return asValues(parent[name]);
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const text = textValue(child);
      if (text) {
        return text;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    return textValue(value["#text"]);
  }
  return undefined;
}

function attributeValue(parent: XmlObject, name: string): string | undefined {
  const direct = parent[`@_${name}`];
  if (typeof direct === "string" || typeof direct === "number") {
    const value = String(direct).trim();
    return value.length > 0 ? value : undefined;
  }

  const matchingKey = Object.keys(parent).find(
    (key) => key.toLowerCase() === `@_${name.toLowerCase()}`
  );
  if (!matchingKey) {
    return undefined;
  }
  return textValue(parent[matchingKey]);
}

function localName(name: string) {
  return name.replace(/^.*:/, "");
}

function formatValidationError(value: unknown) {
  if (isRecord(value)) {
    const message = textValue(value.msg) ?? "XML validation failed";
    const line = textValue(value.line);
    const col = textValue(value.col);
    return [message, line && `line ${line}`, col && `column ${col}`]
      .filter((part): part is string => Boolean(part))
      .join(" at ");
  }
  return String(value);
}

function parseXmlDocument(xml: string, source: string): XmlObject {
  if (xml.trim().length === 0) {
    throw new Error(`Malformed XML in "${source}": document is empty.`);
  }
  if (/<!doctype\b/i.test(xml)) {
    throw new Error(`XML with a DOCTYPE is not supported in "${source}".`);
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Malformed XML in "${source}": ${formatValidationError(validation)}.`);
  }

  try {
    const parsed: unknown = parser.parse(xml);
    if (!isRecord(parsed)) {
      throw new Error("XML document has no object root.");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed XML in "${source}": ${message}`, { cause: error });
  }
}

export function parseSitemapDocument(xml: string, source = "<xml>"): ParsedSitemap {
  const parsed = parseXmlDocument(xml, source);
  const rootKeys = Object.keys(parsed).filter(
    (key) => !key.startsWith("?") && !key.startsWith("@_")
  );

  if (rootKeys.length !== 1) {
    throw new Error(
      `Unexpected XML root in "${source}": expected one sitemap root, found ${rootKeys.length}.`
    );
  }

  const rootKey = rootKeys[0];
  if (!rootKey) {
    throw new Error(`Unexpected XML root in "${source}": document has no sitemap root.`);
  }

  const root = localName(rootKey);
  const rootValue = parsed[rootKey];
  if (!isRecord(rootValue)) {
    throw new Error(`Unexpected XML root in "${source}": "${rootKey}" is not an element.`);
  }

  if (root === "sitemapindex") {
    const children: RawSitemapChild[] = [];
    for (const [index, rawChild] of childValues(rootValue, "sitemap").entries()) {
      if (!isRecord(rawChild)) {
        throw new Error(
          `Unexpected sitemap entry ${index + 1} in "${source}": expected an element.`
        );
      }
      const loc = textValue(rawChild.loc);
      if (!loc) {
        throw new Error(
          `Sitemap entry ${index + 1} in "${source}" is missing a <loc> element.`
        );
      }
      const lastmod = textValue(rawChild.lastmod);
      children.push({
        loc,
        ...(lastmod ? { lastmod } : {})
      });
    }
    return { kind: "index", children };
  }

  if (root === "urlset") {
    const urls: RawSitemapUrl[] = [];
    for (const [index, rawUrl] of childValues(rootValue, "url").entries()) {
      if (!isRecord(rawUrl)) {
        throw new Error(
          `Unexpected URL entry ${index + 1} in "${source}": expected an element.`
        );
      }
      const loc = textValue(rawUrl.loc);
      if (!loc) {
        throw new Error(
          `URL entry ${index + 1} in "${source}" is missing a <loc> element.`
        );
      }

      const imageUrls = childValues(rawUrl, "image").flatMap((rawImage) => {
        if (!isRecord(rawImage)) {
          return [];
        }
        const imageLoc = textValue(rawImage.loc);
        return imageLoc ? [imageLoc] : [];
      });
      const alternates = childValues(rawUrl, "link").flatMap((rawLink) => {
        if (!isRecord(rawLink)) {
          return [];
        }
        const rel = attributeValue(rawLink, "rel")?.toLowerCase();
        const hreflang = attributeValue(rawLink, "hreflang");
        const href = attributeValue(rawLink, "href");
        return rel?.split(/\s+/u).includes("alternate") && hreflang && href
          ? [{ hreflang, href }]
          : [];
      });

      const lastmod = textValue(rawUrl.lastmod);
      urls.push({
        loc,
        ...(lastmod ? { lastmod } : {}),
        imageUrls,
        alternates
      });
    }
    return { kind: "urlset", urls };
  }

  throw new Error(
    `Unexpected XML root in "${source}": expected <sitemapindex> or <urlset>, found <${rootKey}>.`
  );
}

function isHttpSource(source: string) {
  return /^https?:\/\//i.test(source);
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
  ) {
    return true;
  }

  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    const [first, second] = octets;
    if (
      octets.length !== 4
      || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return true;
    }
    return (
      first === 0
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0)
      || (first === 198 && second !== undefined && second >= 18 && second <= 19)
      || (first === 100 && second !== undefined && second >= 64 && second <= 127)
      || (first !== undefined && first >= 224)
    );
  }

  if (version === 6) {
    const normalized = host;
    if (
      normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb")
      || normalized.startsWith("ff")
    ) {
      return true;
    }
    const mappedIpv4 = normalized.match(/^(?:0*:){5,6}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/u);
    return mappedIpv4 ? isPrivateHostname(mappedIpv4[1]) : false;
  }

  return false;
}

function hasCredentialsOrFragment(value: string, url: URL) {
  const schemeEnd = value.indexOf("://");
  const rest = schemeEnd >= 0 ? value.slice(schemeEnd + 3) : "";
  const authorityEnd = rest.search(/[/?#]/u);
  const authority = rest.slice(0, authorityEnd === -1 ? rest.length : authorityEnd);
  return Boolean(url.username || url.password || authority.includes("@") || value.includes("#"));
}

function validateAllowedLiveSitemapUrl(source: string, url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Sitemap sources must use HTTP(S): "${source}".`);
  }
  if (hasCredentialsOrFragment(source, url)) {
    throw new Error("Sitemap sources cannot contain credentials or fragments.");
  }
  if (url.port) {
    throw new Error(`Sitemap sources cannot contain a port: "${source}".`);
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(`Sitemap source targets a loopback or private host: "${source}".`);
  }
  if (!allowedLiveSitemapHosts.has(url.hostname.toLowerCase())) {
    throw new Error(
      `Sitemap source is outside the allowed mycafegourmand.com hosts: "${source}".`
    );
  }
}

function canonicalSitemapSource(value: string) {
  const trimmed = value.trim();
  if (isHttpSource(trimmed)) {
    const url = new URL(trimmed);
    const canonical = url.toString();
    validateRemoteSitemapSource(canonical);
    return canonical;
  }
  if (/^[a-z][a-z\d+\-.]*:/i.test(trimmed)) {
    if (trimmed.toLowerCase().startsWith("file://")) {
      return path.resolve(fileURLToPath(trimmed));
    }
    throw new Error(`Unsupported sitemap source protocol: ${trimmed}`);
  }
  if (trimmed.length === 0) {
    throw new Error("The sitemap source cannot be empty.");
  }
  return path.resolve(trimmed);
}

function sourceIdentity(source: string) {
  if (isHttpSource(source)) {
    return source;
  }
  return path.normalize(path.resolve(source));
}

function sourceName(source: string) {
  if (isHttpSource(source)) {
    const url = new URL(source);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? url.hostname;
  }
  return path.basename(source);
}

function sourceFamily(source: string) {
  const name = sourceName(source);
  const stem = name.replace(/(?:\.xml)?\.gz$/i, "").replace(/\.xml$/i, "");
  const withoutIndex = stem.replace(/(?:[-_]index)$/i, "");
  const withoutNumber = withoutIndex.replace(/[-_]\d+$/u, "");
  return withoutNumber || stem || name;
}

function sourceMetadata(
  task: SourceTask,
  status: SitemapSourceStatus,
  effectiveFetchSource = task.effectiveFetchSource
): SitemapSourceMetadata {
  return {
    source: task.source,
    fetchSource: task.fetchSource,
    ...(effectiveFetchSource && effectiveFetchSource !== task.fetchSource
      ? { effectiveFetchSource }
      : {}),
    depth: task.depth,
    family: sourceFamily(task.source),
    name: sourceName(task.source),
    status,
    ...(task.discoveredFrom ? { discoveredFrom: task.discoveredFrom } : {})
  };
}

function sourceMetadataKey(task: SourceTask) {
  return `${sourceIdentity(task.fetchSource)}\u0000${task.source}`;
}

function getWaybackCapture(source: string): WaybackCapture | undefined {
  if (!isHttpSource(source)) {
    return undefined;
  }
  const url = new URL(source);
  if (url.hostname.toLowerCase() !== waybackHost) {
    return undefined;
  }
  if (url.port || hasCredentialsOrFragment(source, url)) {
    return undefined;
  }

  const match = url.pathname.match(/^\/web\/([^/]+)\/(https?:\/\/.+)$/i);
  if (!match || !match[1] || !match[2]) {
    return undefined;
  }

  let originalUrl: URL;
  try {
    originalUrl = new URL(match[2]);
    validateAllowedLiveSitemapUrl(match[2], originalUrl);
  } catch {
    return undefined;
  }

  return {
    prefix: `${url.origin}/web/${match[1]}/`,
    originalSource: originalUrl.toString()
  };
}

export function rewriteWaybackChildSource(indexSource: string, childSource: string) {
  const capture = getWaybackCapture(indexSource);
  if (!capture || !isHttpSource(childSource)) {
    return childSource;
  }
  if (/^https?:\/\/(?:[^/]+\.)?web\.archive\.org\//i.test(childSource)) {
    return childSource;
  }

  const childUrl = new URL(childSource);
  if (!allowedRecordHosts.has(childUrl.hostname.toLowerCase())) {
    return childSource;
  }
  return `${capture.prefix}${childUrl.toString()}`;
}

function validateRemoteSitemapSource(source: string) {
  const url = new URL(source);
  if (hasCredentialsOrFragment(source, url)) {
    throw new Error("Sitemap sources cannot contain credentials or fragments.");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(`Sitemap source targets a loopback or private host: "${source}".`);
  }
  if (url.hostname.toLowerCase() === waybackHost) {
    if (url.port || !getWaybackCapture(source)) {
      throw new Error(
        `Sitemap source must be a web.archive.org capture of an allowed host: "${source}".`
      );
    }
    return url.toString();
  }

  validateAllowedLiveSitemapUrl(source, url);
  return url.toString();
}

function resolveChildSource(
  parentSource: string,
  effectiveFetchSource: string,
  value: string
) {
  const trimmed = value.trim();
  const scheme = trimmed.match(/^([a-z][a-z\d+\-.]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "file") {
    throw new Error(`Unsupported sitemap source protocol: ${trimmed}`);
  }
  if (isHttpSource(parentSource)) {
    if (isHttpSource(trimmed)) {
      return new URL(trimmed).toString();
    }
    if (scheme === "file") {
      throw new Error(`Remote sitemap cannot reference a local child: ${trimmed}`);
    }
    const effectiveWayback = getWaybackCapture(effectiveFetchSource);
    const base = effectiveWayback?.originalSource ?? effectiveFetchSource;
    return new URL(trimmed, base).toString();
  }

  if (isHttpSource(trimmed)) {
    return new URL(trimmed).toString();
  }
  if (trimmed.toLowerCase().startsWith("file://")) {
    return path.resolve(fileURLToPath(trimmed));
  }
  return path.resolve(path.dirname(parentSource), trimmed);
}

function resolveLinkedUrl(value: string, source: string) {
  const trimmed = value.trim();
  if (isHttpSource(source)) {
    return new URL(trimmed, source).toString();
  }
  if (isHttpSource(trimmed)) {
    return new URL(trimmed).toString();
  }
  if (trimmed.toLowerCase().startsWith("file://")) {
    return path.resolve(fileURLToPath(trimmed));
  }
  return path.resolve(path.dirname(source), trimmed);
}

export type NormalizedRecordUrl = {
  originalUrl: string;
  normalizedUrl: string;
  path: string;
  locale: Locale;
};

function recordUrlError(
  code: "invalid-record-url" | "off-domain-url",
  message: string
): Error & { code: typeof code } {
  const error = new Error(message) as Error & { code: typeof code };
  error.code = code;
  return error;
}

export function normalizeRecordUrl(value: string): NormalizedRecordUrl {
  const originalUrl = value.trim();
  let url: URL;
  try {
    url = new URL(originalUrl);
  } catch {
    throw recordUrlError(
      "invalid-record-url",
      `Record URL is not a valid HTTP(S) URL: "${originalUrl}".`
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw recordUrlError(
      "invalid-record-url",
      `Record URL must use HTTP(S): "${originalUrl}".`
    );
  }
  if (hasCredentialsOrFragment(originalUrl, url)) {
    throw recordUrlError(
      "invalid-record-url",
      `Record URL must not contain credentials or a fragment: "${originalUrl}".`
    );
  }
  if (url.port) {
    throw recordUrlError(
      "invalid-record-url",
      `Record URL must not contain a port: "${originalUrl}".`
    );
  }
  if (!allowedRecordHosts.has(url.hostname.toLowerCase())) {
    throw recordUrlError(
      "off-domain-url",
      `Record URL is outside the allowed mycafegourmand.com hosts: "${originalUrl}".`
    );
  }

  const normalizedPath = `${url.pathname || "/"}${url.search}`;
  const localeSegment = normalizedPath.slice(1).split(/[/?]/u)[0];
  const locale: Locale = localeSegment === "fr" || localeSegment === "ru"
    ? localeSegment
    : "en";

  return {
    originalUrl,
    normalizedUrl: `https://mycafegourmand.com${normalizedPath}`,
    path: normalizedPath,
    locale
  };
}

function issue(
  code: InventoryIssue["code"],
  message: string,
  details: Pick<InventoryIssue, "source" | "url"> = {}
): InventoryIssue {
  return {
    code,
    message,
    ...details
  };
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIssues(left: InventoryIssue, right: InventoryIssue) {
  return (
    compareStrings(left.code, right.code)
    || compareStrings(left.source ?? "", right.source ?? "")
    || compareStrings(left.url ?? "", right.url ?? "")
    || compareStrings(left.message, right.message)
  );
}

function compareSourceMetadata(left: SitemapSourceMetadata, right: SitemapSourceMetadata) {
  return (
    compareStrings(left.source, right.source)
    || compareStrings(left.fetchSource, right.fetchSource)
    || left.depth - right.depth
    || compareStrings(left.status, right.status)
  );
}

function compareCandidates(left: CandidateUrl, right: CandidateUrl) {
  return (
    compareStrings(left.normalizedUrl, right.normalizedUrl)
    || compareStrings(left.sourceKey, right.sourceKey)
    || compareStrings(left.originalUrl, right.originalUrl)
  );
}

function uniqueSorted(values: Iterable<string>) {
  return [...new Set(values)].sort(compareStrings);
}

function getCatalogPaths(catalog: readonly RecipeRecord[]) {
  const currentPaths = [
    "/",
    ...supportedLocales.map(getLocaleHomePath),
    ...catalog.map(getRecipePath)
  ];
  const legacyPaths = catalog.flatMap((record) => record.legacyUrls.map(({ path: value }) => value));
  return {
    currentPaths: uniqueSorted(currentPaths),
    legacyPaths: uniqueSorted(legacyPaths)
  };
}

function comparisonPathKey(value: string) {
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);
  const equivalentPathname =
    pathname.length > 1 ? pathname.replace(/\/+$/u, "") || "/" : pathname;
  return `${equivalentPathname}${query}`;
}

export function compareDiscoveredPaths(
  discovered: readonly (Pick<InventoryUrlEntry, "path"> | string)[],
  catalog: readonly RecipeRecord[]
): InventoryComparison {
  const { currentPaths, legacyPaths } = getCatalogPaths(catalog);
  const current = new Set(currentPaths.map(comparisonPathKey));
  const legacy = new Set(legacyPaths.map(comparisonPathKey));
  const entries = uniqueSorted(
    discovered.map((entry) => typeof entry === "string" ? entry : entry.path)
  ).map((pathValue) => {
    const status: ComparisonStatus = current.has(comparisonPathKey(pathValue))
      ? "current-covered"
      : legacy.has(comparisonPathKey(pathValue))
        ? "legacy-covered"
        : "discovered-only";
    return { path: pathValue, status };
  });

  return {
    entries,
    discoveredOnly: entries
      .filter((entry) => entry.status === "discovered-only")
      .map((entry) => entry.path),
    currentCovered: entries
      .filter((entry) => entry.status === "current-covered")
      .map((entry) => entry.path),
    legacyCovered: entries
      .filter((entry) => entry.status === "legacy-covered")
      .map((entry) => entry.path),
    knownCurrentPaths: currentPaths,
    knownLegacyPaths: legacyPaths
  };
}

export const compareInventoryToCatalog = compareDiscoveredPaths;

function isPathWithinDirectory(directory: string, candidate: string) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function rejectSymlinkComponents(source: string) {
  const absolute = path.resolve(source);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing symlinked local sitemap source: "${source}".`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
}

async function assertLocalSitemapSource(source: string, rootDirectory: string) {
  if (!isPathWithinDirectory(rootDirectory, source)) {
    throw new Error(
      `Local sitemap child escapes the initial sitemap directory tree: "${source}".`
    );
  }
  await rejectSymlinkComponents(source);
}

async function cancelResponseBody(response: Response) {
  if (!response.body) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {
    // The body may already have been canceled by its reader.
  }
}

function responseContentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readResponseBody(
  response: Response,
  source: string,
  maxBytes: number
): Promise<Buffer> {
  const contentLength = responseContentLength(response);
  if (contentLength !== undefined && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error(
      `Sitemap response "${source}" exceeds the ${maxBytes}-byte compressed input document limit.`
    );
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(
          `Sitemap response "${source}" exceeds the ${maxBytes}-byte compressed input document limit.`
        );
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Cancellation is best effort after a stream failure.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function hasGzipMagic(bytes: Uint8Array) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function looksLikeXml(bytes: Uint8Array) {
  const prefix = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  return prefix.startsWith("<");
}

function hasGzipCue(source: string, contentEncoding?: string, contentType?: string) {
  return (
    /\.gz(?:[?#]|$)/iu.test(source)
    || /\bgzip\b/iu.test(contentEncoding ?? "")
    || /(?:application|content)\/(?:x-)?gzip/iu.test(contentType ?? "")
  );
}

async function decompressGzip(
  compressed: Buffer,
  source: string,
  maxBytes: number
) {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const collect = (async () => {
    for await (const chunk of gunzip) {
      const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += output.byteLength;
      if (bytes > maxBytes) {
        throw new Error(
          `Gzip sitemap "${source}" exceeds the ${maxBytes}-byte decompressed document limit.`
        );
      }
      chunks.push(output);
    }
  })();

  try {
    gunzip.end(compressed);
    await collect;
  } catch (error) {
    gunzip.destroy();
    if (
      error instanceof Error
      && error.message.includes("decompressed document limit")
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to decompress gzip sitemap "${source}": ${message}`, {
      cause: error
    });
  }

  return Buffer.concat(chunks, bytes);
}

async function decodeSitemapBody(
  body: string | Uint8Array,
  source: string,
  maxBytes: number,
  metadata: Pick<SitemapFetchResult, "contentEncoding" | "contentType"> = {}
) {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const gzipMagic = hasGzipMagic(bytes);
  const gzipCue = hasGzipCue(source, metadata.contentEncoding, metadata.contentType);
  if (gzipMagic || (gzipCue && !looksLikeXml(bytes))) {
    return (await decompressGzip(bytes, source, maxBytes)).toString("utf8");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `Sitemap document "${source}" exceeds the ${maxBytes}-byte decompressed document limit.`
    );
  }
  return bytes.toString("utf8");
}

async function defaultFetchDocument(
  source: string,
  limits: InventoryLimits
): Promise<SitemapFetchResult> {
  if (!isHttpSource(source)) {
    let fileStats;
    try {
      const sourceStats = await lstat(source);
      if (sourceStats.isSymbolicLink()) {
        throw new Error(`Refusing symlinked local sitemap source: "${source}".`);
      }
      fileStats = await stat(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read sitemap file "${source}": ${message}`, { cause: error });
    }
    if (!fileStats.isFile()) {
      throw new Error(`Unable to read sitemap file "${source}": not a regular file.`);
    }
    if (fileStats.size > limits.maxDocumentBytes) {
      throw new Error(
        `Sitemap file "${source}" exceeds the ${limits.maxDocumentBytes}-byte compressed input document limit.`
      );
    }
    try {
      return { body: await readFile(source) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read sitemap file "${source}": ${message}`, { cause: error });
    }
  }

  let currentSource = validateRemoteSitemapSource(source);
  let redirects = 0;
  while (true) {
    const controller = new AbortController();
    let timedOut = false;
    let response: Response | undefined;
    let bodyCanceled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.requestTimeoutMs);
    const cancelBody = async () => {
      if (response && !bodyCanceled) {
        bodyCanceled = true;
        await cancelResponseBody(response);
      }
    };

    try {
      response = await fetch(currentSource, {
        headers: {
          accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
          "user-agent": "MyCafeGourmand URL inventory (read-only)"
        },
        redirect: "manual",
        signal: controller.signal
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await cancelBody();
        if (redirects >= maxRedirects) {
          throw new Error(`Sitemap redirect limit of ${maxRedirects} was exceeded.`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Sitemap redirect from "${currentSource}" has no Location header.`);
        }
        let nextSource: string;
        try {
          nextSource = new URL(location, currentSource).toString();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Invalid sitemap redirect target "${location}": ${message}`, {
            cause: error
          });
        }
        currentSource = validateRemoteSitemapSource(nextSource);
        redirects += 1;
        continue;
      }

      if (!response.ok) {
        await cancelBody();
        throw new Error(`Unable to fetch sitemap "${source}": HTTP ${response.status}.`);
      }

      const body = await readResponseBody(response, source, limits.maxDocumentBytes);
      const contentEncoding = response.headers.get("content-encoding");
      const contentType = response.headers.get("content-type");
      return {
        body,
        status: response.status,
        finalSource: currentSource,
        ...(contentEncoding ? { contentEncoding } : {}),
        ...(contentType ? { contentType } : {})
      };
    } catch (error) {
      await cancelBody();
      if (timedOut) {
        throw new Error(
          `Unable to fetch sitemap "${source}": request timed out after ` +
          `${limits.requestTimeoutMs} ms.`,
          { cause: error }
        );
      }
      if (
        error instanceof Error
        && (
          error.message.includes("document limit")
          || error.message.includes("redirect")
          || error.message.includes("Location")
          || error.message.includes("allowed")
          || error.message.includes("private")
          || error.message.includes("credentials")
          || error.message.includes("port")
          || error.message.includes("HTTP ")
        )
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to fetch sitemap "${source}": ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mergeInventoryLimits(input: Partial<InventoryLimits> | undefined): InventoryLimits {
  const limits = {
    ...defaultInventoryLimits,
    ...input
  };
  for (const key of Object.keys(defaultInventoryLimits) as InventoryLimitKey[]) {
    const value = limits[key];
    const minimum = key === "maxDepth" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(
        `Inventory limit "${key}" must be an integer greater than or equal to ${minimum}.`
      );
    }
  }
  return limits;
}

export async function inventorySitemaps(
  options: UrlInventoryOptions
): Promise<UrlInventoryOutput> {
  const limits = mergeInventoryLimits(options.limits);
  const rootSource = canonicalSitemapSource(options.sitemap);
  const localRootDirectory = isHttpSource(rootSource)
    ? undefined
    : path.dirname(rootSource);
  if (localRootDirectory) {
    await assertLocalSitemapSource(rootSource, localRootDirectory);
  }
  const rootTask: SourceTask = {
    source: rootSource,
    fetchSource: rootSource,
    depth: 0,
    lineage: [sourceIdentity(rootSource)]
  };
  const fetchDocument = options.fetchDocument ?? options.fetch ?? defaultFetchDocument;
  const errors: InventoryIssue[] = [];
  const candidates: CandidateUrl[] = [];
  const childSources = new Map<string, SitemapSourceMetadata>();
  const scheduled = new Set<string>(rootTask.lineage);
  const queue: SourceTask[] = [rootTask];
  let processedDocuments = 0;
  let processedUrls = 0;
  let urlLimitReported = false;

  let rootMetadata = sourceMetadata(rootTask, "queued");
  const setTaskStatus = (
    task: SourceTask,
    status: SitemapSourceStatus,
    effectiveFetchSource = task.effectiveFetchSource
  ) => {
    const metadata = sourceMetadata(task, status, effectiveFetchSource);
    if (task === rootTask) {
      rootMetadata = metadata;
      return;
    }
    const metadataKey = sourceMetadataKey(task);
    if (childSources.has(metadataKey)) {
      childSources.set(metadataKey, metadata);
    }
  };
  const addSkippedChildMetadata = (
    metadataKey: string,
    metadata: SitemapSourceMetadata,
    status: SitemapSourceStatus
  ) => {
    let uniqueKey = metadataKey;
    let suffix = 1;
    while (childSources.has(uniqueKey)) {
      uniqueKey = `${metadataKey}\u0000${status}-${suffix}`;
      suffix += 1;
    }
    childSources.set(uniqueKey, { ...metadata, status });
  };

  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) {
      break;
    }
    processedDocuments += 1;
    if (processedDocuments > limits.maxDocuments) {
      setTaskStatus(task, "limit");
      errors.push(issue(
        "sitemap-document-limit",
        `Skipped sitemap because the ${limits.maxDocuments}-document limit was reached.`,
        { source: task.source }
      ));
      continue;
    }

    let effectiveFetchSource = task.fetchSource;
    let fetched: string | SitemapFetchResult;
    try {
      fetched = await fetchDocument(task.fetchSource, limits);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskStatus(task, "fetch-failed");
      errors.push(issue("fetch-failed", message, { source: task.source }));
      continue;
    }

    if (
      typeof fetched !== "string"
      && fetched.status !== undefined
      && (fetched.status < 200 || fetched.status >= 300)
    ) {
      const message = `Unable to fetch sitemap "${task.fetchSource}": HTTP ${fetched.status}.`;
      setTaskStatus(task, "fetch-failed");
      errors.push(issue("fetch-failed", message, { source: task.source }));
      continue;
    }

    if (typeof fetched !== "string" && fetched.finalSource !== undefined) {
      try {
        if (fetched.finalSource.trim().length === 0) {
          throw new Error("Fetcher returned an empty final source.");
        }
        const candidateSource = canonicalSitemapSource(fetched.finalSource);
        if (isHttpSource(task.fetchSource)) {
          if (!isHttpSource(candidateSource)) {
            throw new Error("Fetcher returned a local final source for a remote sitemap.");
          }
          effectiveFetchSource = validateRemoteSitemapSource(candidateSource);
        } else {
          if (isHttpSource(candidateSource) || !localRootDirectory) {
            throw new Error("Fetcher returned a remote final source for a local sitemap.");
          }
          await assertLocalSitemapSource(candidateSource, localRootDirectory);
          effectiveFetchSource = candidateSource;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setTaskStatus(task, "fetch-failed");
        errors.push(issue("fetch-failed", message, { source: task.source }));
        continue;
      }
    }

    let xml: string;
    try {
      xml = await decodeSitemapBody(
        typeof fetched === "string" ? fetched : fetched.body,
        task.fetchSource,
        limits.maxDocumentBytes,
        typeof fetched === "string" ? {} : fetched
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTaskStatus(task, "fetch-failed", effectiveFetchSource);
      errors.push(issue("fetch-failed", message, { source: task.source }));
      continue;
    }

    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemapDocument(xml, task.source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code: InventoryIssue["code"] = /DOCTYPE/i.test(message)
        ? "unsupported-xml"
        : /Unexpected XML root/i.test(message)
          ? "unexpected-root"
          : /missing a <loc>/i.test(message)
            ? "missing-location"
          : "malformed-xml";
      const status: SitemapSourceStatus = code === "unexpected-root"
        ? "unexpected-root"
        : "malformed-xml";
      setTaskStatus(task, status, effectiveFetchSource);
      errors.push(issue(code, message, { source: task.source }));
      continue;
    }

    setTaskStatus(task, "parsed", effectiveFetchSource);

    if (parsed.kind === "urlset") {
      for (const rawUrl of parsed.urls) {
        if (processedUrls >= limits.maxUrls) {
          if (!urlLimitReported) {
            errors.push(issue(
              "sitemap-url-limit",
              `Skipped URL entries after reaching the ${limits.maxUrls}-URL limit.`,
              { source: task.source }
            ));
            urlLimitReported = true;
          }
          break;
        }
        processedUrls += 1;

        let normalized: NormalizedRecordUrl;
        try {
          normalized = normalizeRecordUrl(rawUrl.loc);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code: InventoryIssue["code"] =
            error && typeof error === "object" && "code" in error
              && error.code === "off-domain-url"
              ? "off-domain-url"
              : "invalid-record-url";
          errors.push(issue(code, message, { source: task.source, url: rawUrl.loc }));
          continue;
        }

        const imageUrls = uniqueSorted(
          rawUrl.imageUrls.flatMap((imageUrl) => {
            try {
              return [resolveLinkedUrl(imageUrl, task.source)];
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(issue(
                "invalid-record-url",
                `Invalid image URL: ${message}`,
                { source: task.source, url: imageUrl }
              ));
              return [];
            }
          })
        );
        const hreflangAlternates = rawUrl.alternates
          .map(({ hreflang, href }) => {
            let originalUrl: string;
            try {
              originalUrl = resolveLinkedUrl(href, task.source);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(issue(
                "invalid-record-url",
                `Invalid hreflang alternate (${hreflang}): ${message}`,
                { source: task.source, url: href }
              ));
              return {
                hreflang,
                originalUrl: href
              };
            }
            try {
              const alternate = normalizeRecordUrl(originalUrl);
              return {
                hreflang,
                originalUrl,
                normalizedUrl: alternate.normalizedUrl,
                path: alternate.path
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(issue(
                error && typeof error === "object" && "code" in error
                  && error.code === "off-domain-url"
                  ? "off-domain-url"
                  : "invalid-record-url",
                `Invalid hreflang alternate (${hreflang}): ${message}`,
                { source: task.source, url: originalUrl }
              ));
              return {
                hreflang,
                originalUrl
              };
            }
          })
          .sort((left, right) =>
            compareStrings(left.hreflang, right.hreflang)
            || compareStrings(left.originalUrl, right.originalUrl)
          );

        candidates.push({
          originalUrl: normalized.originalUrl,
          normalizedUrl: normalized.normalizedUrl,
          path: normalized.path,
          locale: normalized.locale,
          sourceSitemap: {
            family: sourceFamily(task.source),
            name: sourceName(task.source)
          },
          ...(rawUrl.lastmod ? { lastmod: rawUrl.lastmod } : {}),
          imageUrls,
          hreflangAlternates,
          sourceKey: `${task.source}\u0000${task.fetchSource}`
        });
      }
      continue;
    }

    const childTasks: SourceTask[] = [];
    for (const child of parsed.children) {
      try {
        const childSource = resolveChildSource(task.source, effectiveFetchSource, child.loc);
        if (isHttpSource(childSource)) {
          validateRemoteSitemapSource(childSource);
        } else if (localRootDirectory) {
          await assertLocalSitemapSource(childSource, localRootDirectory);
        } else {
          throw new Error(`Remote sitemap cannot reference a local child: "${childSource}".`);
        }
        const fetchSource = isHttpSource(childSource)
          ? validateRemoteSitemapSource(
            rewriteWaybackChildSource(effectiveFetchSource, childSource)
          )
          : childSource;
        childTasks.push({
          source: childSource,
          fetchSource,
          depth: task.depth + 1,
          discoveredFrom: task.source,
          lineage: [...task.lineage, sourceIdentity(fetchSource)]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(issue("invalid-sitemap-source", message, {
          source: task.source,
          url: child.loc
        }));
      }
    }
    childTasks.sort((left, right) =>
      compareStrings(left.fetchSource, right.fetchSource)
      || compareStrings(left.source, right.source)
    );

    for (const childTask of childTasks) {
      const childKey = sourceIdentity(childTask.fetchSource);
      const metadata = sourceMetadata(childTask, "queued");
      const metadataKey = sourceMetadataKey(childTask);
      if (childTask.depth > limits.maxDepth) {
        if (!childSources.has(metadataKey)) {
          childSources.set(metadataKey, { ...metadata, status: "limit" });
        }
        errors.push(issue(
          "sitemap-depth-limit",
          `Skipped sitemap at depth ${childTask.depth}; maximum depth is ${limits.maxDepth}.`,
          { source: childTask.source }
        ));
        continue;
      }
      if (childTask.lineage.slice(0, -1).includes(childKey)) {
        errors.push(issue(
          "sitemap-cycle",
          `Skipped cyclic sitemap reference to "${childTask.source}".`,
          { source: childTask.source }
        ));
        addSkippedChildMetadata(metadataKey, metadata, "cycle");
        continue;
      }
      if (scheduled.has(childKey)) {
        errors.push(issue(
          "duplicate-sitemap",
          `Skipped duplicate sitemap reference to "${childTask.source}".`,
          { source: childTask.source }
        ));
        addSkippedChildMetadata(metadataKey, metadata, "duplicate");
        continue;
      }
      if (scheduled.size >= limits.maxDocuments) {
        errors.push(issue(
          "sitemap-document-limit",
          `Skipped sitemap because the ${limits.maxDocuments}-document limit was reached.`,
          { source: childTask.source }
        ));
        if (!childSources.has(metadataKey)) {
          childSources.set(metadataKey, { ...metadata, status: "limit" });
        }
        continue;
      }

      scheduled.add(childKey);
      queue.push(childTask);
      childSources.set(metadataKey, metadata);
    }
  }

  const byNormalizedUrl = new Map<string, CandidateUrl[]>();
  for (const candidate of candidates.sort(compareCandidates)) {
    const group = byNormalizedUrl.get(candidate.normalizedUrl) ?? [];
    group.push(candidate);
    byNormalizedUrl.set(candidate.normalizedUrl, group);
  }

  const urls: InventoryUrlEntry[] = [];
  for (const [normalizedUrl, group] of [...byNormalizedUrl.entries()].sort(([left], [right]) =>
    compareStrings(left, right)
  )) {
    const [first, ...duplicates] = group;
    if (!first) {
      continue;
    }
    for (const duplicate of duplicates) {
      errors.push(issue(
        "duplicate-url",
        `Duplicate record URL normalized to "${normalizedUrl}".`,
        { source: duplicate.sourceKey.split("\u0000")[0], url: duplicate.originalUrl }
      ));
    }
    const mergedImages = uniqueSorted(group.flatMap((candidate) => candidate.imageUrls));
    const mergedAlternates = group
      .flatMap((candidate) => candidate.hreflangAlternates)
      .filter((alternate, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.hreflang === alternate.hreflang
            && candidate.originalUrl === alternate.originalUrl
        ) === index
      )
      .sort((left, right) =>
        compareStrings(left.hreflang, right.hreflang)
        || compareStrings(left.originalUrl, right.originalUrl)
      );
    const lastmod = first.lastmod ?? group.find((candidate) => candidate.lastmod)?.lastmod;
    urls.push({
      originalUrl: first.originalUrl,
      normalizedUrl: first.normalizedUrl,
      path: first.path,
      locale: first.locale,
      sourceSitemap: first.sourceSitemap,
      ...(lastmod ? { lastmod } : {}),
      imageUrls: mergedImages,
      hreflangAlternates: mergedAlternates
    });
  }

  let comparison: InventoryComparison = compareDiscoveredPaths(urls, options.catalog ?? []);
  if (options.compare !== false && options.catalog === undefined) {
    try {
      const catalog = loadRecipeCatalog(options.recipesRoot);
      comparison = compareDiscoveredPaths(urls, catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(issue("comparison-failed", message));
    }
  }

  const sortedChildSources = [...childSources.values()]
    .sort(compareSourceMetadata);
  errors.sort(compareIssues);

  return {
    schemaVersion: 1,
    discoveryOnly: true,
    purpose:
      "Discovery aid only: this inventory is not a source of truth and does not make redirect decisions.",
    rootSource: rootMetadata,
    childSitemapSources: sortedChildSources,
    urls,
    errors,
    comparison
  };
}

export const inventoryUrls = inventorySitemaps;
export const compareInventoryPaths = compareDiscoveredPaths;

type CliArguments = Record<string, string | boolean>;

const supportedCliOptions = new Set([
  "dry-run",
  "max-depth",
  "max-document-bytes",
  "max-documents",
  "request-timeout-ms",
  "max-urls",
  "no-compare",
  "output",
  "overwrite",
  "recipes-root",
  "sitemap",
  "write"
]);

function parseArguments(values: string[]): CliArguments {
  const parsed: CliArguments = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument ?? "<missing>"}`);
    }
    const key = argument.slice(2);
    if (!key) {
      throw new Error("Empty command-line option.");
    }
    if (!supportedCliOptions.has(key)) {
      throw new Error(`Unknown command-line option: --${key}`);
    }
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (parsed[key] !== undefined) {
        throw new Error(`Duplicate command-line option: --${key}`);
      }
      parsed[key] = next;
      index += 1;
    } else {
      if (parsed[key] !== undefined) {
        throw new Error(`Duplicate command-line option: --${key}`);
      }
      parsed[key] = true;
    }
  }
  return parsed;
}

function requiredOption(args: CliArguments, key: string) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option: --${key}`);
  }
  return value;
}

function numericOption(args: CliArguments, key: string) {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  const description = key === "max-depth" ? "non-negative" : "positive";
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`--${key} must be a ${description} integer.`);
  }
  const parsed = Number(value);
  const minimum = key === "max-depth" ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `--${key} must be an integer greater than or equal to ${minimum}.`
    );
  }
  return parsed;
}

function outputPathIsProtected(outputPath: string) {
  const root = path.resolve(process.cwd());
  const protectedRoots = ["public", "src", "content"].map((directory) =>
    path.resolve(root, directory)
  );
  return protectedRoots.some(
    (protectedRoot) =>
      outputPath === protectedRoot || outputPath.startsWith(`${protectedRoot}${path.sep}`)
  );
}

function isMissingFileError(error: unknown) {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function ensureOutputParent(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to write through a directory symlink: "${current}".`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Output parent is not a directory: "${current}".`);
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!mkdirError || typeof mkdirError !== "object" || !("code" in mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing to write through a directory symlink: "${current}".`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Output parent is not a directory: "${current}".`);
      }
    }
  }
}

async function verifiedOutputParent(outputPath: string) {
  const parent = path.dirname(outputPath);
  const parentStats = await lstat(parent);
  if (parentStats.isSymbolicLink()) {
    throw new Error(`Refusing to write through a directory symlink: "${parent}".`);
  }
  if (!parentStats.isDirectory()) {
    throw new Error(`Output parent is not a directory: "${parent}".`);
  }
  const realParent = await realpath(parent);
  if (outputPathIsProtected(realParent)) {
    throw new Error(
      "Refusing to write through a directory symlink into public/, src/, or content/."
    );
  }
  return realParent;
}

type WritableOutput = {
  outputPath: string;
  targetPath: string;
  realParent: string;
};

async function assertWritableOutput(
  outputPath: string,
  overwrite: boolean
): Promise<WritableOutput> {
  if (outputPathIsProtected(outputPath)) {
    throw new Error(
      "Refusing to write inventory output under public/, src/, or content/. " +
      "Use migration-output/ or another migration-only directory."
    );
  }

  await ensureOutputParent(path.dirname(outputPath));
  const realParent = await verifiedOutputParent(outputPath);
  const targetPath = path.join(realParent, path.basename(outputPath));

  try {
    const outputStats = await lstat(targetPath);
    if (outputStats.isSymbolicLink()) {
      throw new Error(`Refusing to write through symbolic link: "${outputPath}".`);
    }
    if (!outputStats.isFile()) {
      throw new Error(`Refusing to replace non-file output: "${outputPath}".`);
    }
    if (!overwrite) {
      throw new Error(
        `Output already exists: "${outputPath}". Pass --overwrite to replace it explicitly.`
      );
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  return { outputPath, targetPath, realParent };
}

async function writeInventoryOutput(
  outputPath: string,
  serialized: string,
  overwrite: boolean
) {
  const initial = await assertWritableOutput(outputPath, overwrite);
  let temporaryPath: string | undefined;
  try {
    const verified = await assertWritableOutput(outputPath, overwrite);
    if (verified.realParent !== initial.realParent) {
      throw new Error("Output parent changed while preparing the atomic write.");
    }

    temporaryPath = path.join(
      verified.realParent,
      `.${path.basename(outputPath)}.${randomUUID()}.tmp`
    );
    const noFollow = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    const fileHandle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    );
    try {
      await fileHandle.writeFile(serialized, "utf8");
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    const beforeRename = await assertWritableOutput(outputPath, overwrite);
    if (
      beforeRename.realParent !== verified.realParent
      || beforeRename.targetPath !== verified.targetPath
    ) {
      throw new Error("Output parent changed before the atomic rename.");
    }
    // Node does not expose renameat/dirfd operations. Using the verified real
    // parent for both paths narrows the remaining race to replacement of that
    // directory itself; overwrite renames replace entries, never follow them,
    // while non-overwrite installs below fail if the entry already exists.
    await installInventoryTempFile(temporaryPath, beforeRename.targetPath, overwrite);
    temporaryPath = undefined;
  } finally {
    if (temporaryPath) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function installInventoryTempFile(
  temporaryPath: string,
  targetPath: string,
  overwrite: boolean
) {
  if (overwrite) {
    await rename(temporaryPath, targetPath);
    return;
  }
  await link(temporaryPath, targetPath);
  await unlink(temporaryPath);
}

export async function runUrlInventory(argv: string[]) {
  const args = parseArguments(argv);
  const sitemap = requiredOption(args, "sitemap");
  const write = args.write === true;
  const dryRun = args["dry-run"] === true;
  const overwrite = args.overwrite === true;
  const outputOption = args.output;
  const outputPath = typeof outputOption === "string" ? path.resolve(outputOption) : undefined;

  if (write && !outputPath) {
    throw new Error("--write requires an explicit --output path.");
  }
  if (!write && outputPath) {
    throw new Error("--output is only valid together with --write.");
  }
  if (write && dryRun) {
    throw new Error("--dry-run and --write cannot be used together.");
  }
  if (overwrite && !write) {
    throw new Error("--overwrite is only valid together with --write.");
  }
  if (outputPath) {
    await assertWritableOutput(outputPath, overwrite);
  }

  const limits: Partial<InventoryLimits> = {};
  const maxDepth = numericOption(args, "max-depth");
  const maxDocuments = numericOption(args, "max-documents");
  const requestTimeoutMs = numericOption(args, "request-timeout-ms");
  const maxUrls = numericOption(args, "max-urls");
  const maxDocumentBytes = numericOption(args, "max-document-bytes");
  const recipesRoot = args["recipes-root"];
  if (recipesRoot !== undefined && typeof recipesRoot !== "string") {
    throw new Error("--recipes-root requires a path.");
  }
  if (maxDepth !== undefined) {
    limits.maxDepth = maxDepth;
  }
  if (maxDocuments !== undefined) {
    limits.maxDocuments = maxDocuments;
  }
  if (requestTimeoutMs !== undefined) {
    limits.requestTimeoutMs = requestTimeoutMs;
  }
  if (maxUrls !== undefined) {
    limits.maxUrls = maxUrls;
  }
  if (maxDocumentBytes !== undefined) {
    limits.maxDocumentBytes = maxDocumentBytes;
  }

  const output = await inventorySitemaps({
    sitemap,
    limits,
    compare: args["no-compare"] !== true,
    ...(typeof recipesRoot === "string" ? { recipesRoot } : {})
  });
  const serialized = `${JSON.stringify(output, null, 2)}\n`;

  if (outputPath) {
    await writeInventoryOutput(outputPath, serialized, overwrite);
    console.log(`Created ${outputPath}`);
    if (output.errors.length > 0) {
      console.error(`Inventory completed with ${output.errors.length} reported issue(s).`);
    }
  } else {
    process.stdout.write(serialized);
    console.error("Dry run only; add --write --output migration-output/urls.json to write a file.");
  }

  return output;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  runUrlInventory(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
