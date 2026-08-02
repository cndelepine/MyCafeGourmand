import type { Locale, RecipeRecord } from "../../src/content/schema";

export type InventoryLimitKey =
  | "maxDepth"
  | "maxDocuments"
  | "maxUrls"
  | "maxDocumentBytes"
  | "requestTimeoutMs";

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
  | "redirect-covered";

export type ComparisonEntry = {
  path: string;
  status: ComparisonStatus;
};

export type InventoryComparison = {
  entries: ComparisonEntry[];
  discoveredOnly: string[];
  currentCovered: string[];
  redirectCovered: string[];
  knownCurrentPaths: string[];
  knownRedirectPaths: string[];
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

export type RawSitemapChild = {
  loc: string;
  lastmod?: string;
};

export type RawSitemapUrl = {
  loc: string;
  lastmod?: string;
  imageUrls: string[];
  alternates: Array<{
    hreflang: string;
    href: string;
  }>;
};

export type ParsedSitemap =
  | {
      kind: "index";
      children: RawSitemapChild[];
    }
  | {
      kind: "urlset";
      urls: RawSitemapUrl[];
    };

export type SourceTask = {
  source: string;
  fetchSource: string;
  effectiveFetchSource?: string;
  depth: number;
  discoveredFrom?: string;
  lineage: string[];
};

export type CandidateUrl = InventoryUrlEntry & {
  sourceKey: string;
};

export type WaybackCapture = {
  prefix: string;
  originalSource: string;
};

export type XmlObject = Record<string, unknown>;

export type NormalizedRecordUrl = {
  originalUrl: string;
  normalizedUrl: string;
  path: string;
  locale: Locale;
};
