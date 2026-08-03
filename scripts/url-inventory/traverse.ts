import path from "node:path";
import { loadRecipeCatalog } from "../../src/content/catalog";
import {
  compareCandidates,
  compareIssues,
  compareSourceMetadata,
  compareStrings,
  issue,
  uniqueSorted
} from "./common";
import { compareDiscoveredPaths } from "./comparison";
import { defaultFetchDocument, decodeSitemapBody } from "./fetch";
import { assertLocalSitemapSource } from "./local-paths";
import { mergeInventoryLimits } from "./limits";
import {
  canonicalSitemapSource,
  isHttpSource,
  normalizeRecordUrl,
  resolveChildSource,
  resolveLinkedUrl,
  rewriteWaybackChildSource,
  sourceFamily,
  sourceIdentity,
  sourceMetadata,
  sourceMetadataKey,
  sourceName,
  validateRemoteSitemapSource
} from "./sources";
import { parseSitemapDocument } from "./xml";
import type {
  CandidateUrl,
  InventoryIssue,
  InventoryUrlEntry,
  NormalizedRecordUrl,
  ParsedSitemap,
  SitemapFetchResult,
  SitemapSourceMetadata,
  SitemapSourceStatus,
  SourceTask,
  UrlInventoryOptions,
  UrlInventoryOutput
} from "./types";

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

  let comparison = compareDiscoveredPaths(urls, options.catalog ?? []);
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
