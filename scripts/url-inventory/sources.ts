import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedLiveSitemapHosts,
  allowedRecordHosts,
  waybackHost
} from "./constants";
import type {
  NormalizedRecordUrl,
  SourceTask,
  SitemapSourceMetadata,
  WaybackCapture
} from "./types";
import type { Locale } from "../../src/content/schema";

export function isHttpSource(source: string) {
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

export function canonicalSitemapSource(value: string) {
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

export function sourceIdentity(source: string) {
  if (isHttpSource(source)) {
    return source;
  }
  return path.normalize(path.resolve(source));
}

export function sourceName(source: string) {
  if (isHttpSource(source)) {
    const url = new URL(source);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.at(-1) ?? url.hostname;
  }
  return path.basename(source);
}

export function sourceFamily(source: string) {
  const name = sourceName(source);
  const stem = name.replace(/(?:\.xml)?\.gz$/i, "").replace(/\.xml$/i, "");
  const withoutIndex = stem.replace(/(?:[-_]index)$/i, "");
  const withoutNumber = withoutIndex.replace(/[-_]\d+$/u, "");
  return withoutNumber || stem || name;
}

export function sourceMetadata(
  task: SourceTask,
  status: SitemapSourceMetadata["status"],
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

export function sourceMetadataKey(task: SourceTask) {
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

export function validateRemoteSitemapSource(source: string) {
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

export function resolveChildSource(
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

export function resolveLinkedUrl(value: string, source: string) {
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
