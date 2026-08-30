import {
  SourceEvidenceError,
  type SourceEvidenceBaseline,
  type SourceEvidenceBaselineMetrics,
  type SourceEvidenceComparison,
  type SourceEvidenceReconciliation,
  type SourceEvidenceReport
} from "./source-evidence-contracts";

function unknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function baselineCount(value: unknown) {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new SourceEvidenceError("invalid-baseline");
  }
  return value;
}

function baselineRecord(value: unknown) {
  if (!unknownRecord(value)) {
    throw new SourceEvidenceError("invalid-baseline");
  }
  return value;
}

function baselineArray(value: unknown) {
  if (!Array.isArray(value)) {
    throw new SourceEvidenceError("invalid-baseline");
  }
  return value;
}

export function metricsFromReport(report: SourceEvidenceReport): SourceEvidenceBaselineMetrics {
  return {
    posts: report.evidence.posts.postRecords,
    pages: report.evidence.posts.pageRecords,
    wprmPostRecords: report.evidence.wprm.recipePostRecords,
    wpurMetadataSignalPosts: report.evidence.wpur.metadataSignalPosts,
    postTranslationGroups: report.evidence.polylang.posts.translationGroups,
    termTranslationGroups: report.evidence.polylang.terms.translationGroups,
    redirectionPluginRecords: report.evidence.redirects.records,
    legacyOldSlugRecords: 0,
    matchedAttachments: report.evidence.media.archiveCoverage.matched,
    bwgImageRecords: report.evidence.galleries.images
  };
}

export function parseSourceEvidenceBaseline(input: unknown): SourceEvidenceBaseline {
  const root = baselineRecord(input);
  if (
    root.kind !== "wordpress-source-inventory"
    || root.schemaVersion !== 3
  ) {
    throw new SourceEvidenceError("invalid-baseline");
  }
  const posts = baselineRecord(root.posts);
  const pages = baselineRecord(posts.pages);
  const byType = baselineArray(posts.byType);
  const postType = byType
    .map((entry) => baselineRecord(entry))
    .find((entry) => entry.postType === "post");
  if (postType === undefined) {
    throw new SourceEvidenceError("invalid-baseline");
  }

  const recipes = baselineRecord(root.recipes);
  const wprm = baselineRecord(recipes.wprm);
  const ultimateRecipe = baselineRecord(recipes.ultimateRecipe);
  const locales = baselineRecord(root.locales);
  const localePosts = baselineRecord(locales.posts);
  const localeTerms = baselineRecord(locales.terms);
  const redirects = baselineRecord(root.redirects);
  const media = baselineRecord(root.media);
  const archive = baselineRecord(media.archive);
  const galleries = baselineRecord(root.galleries);
  const bwg = baselineRecord(galleries.bwg);

  return {
    kind: "wordpress-source-inventory",
    schemaVersion: 3,
    metrics: {
      posts: baselineCount(postType.count),
      pages: baselineCount(pages.count),
      wprmPostRecords: baselineCount(wprm.postRecords),
      wpurMetadataSignalPosts: baselineArray(ultimateRecipe.metadataSignalPosts).length,
      postTranslationGroups: baselineArray(localePosts.translationGroups).length,
      termTranslationGroups: baselineArray(localeTerms.translationGroups).length,
      redirectionPluginRecords: baselineCount(redirects.redirectionItems),
      legacyOldSlugRecords: baselineCount(redirects.oldSlugMetadata),
      matchedAttachments: baselineCount(archive.matchedAttachedFiles),
      bwgImageRecords: baselineCount(bwg.images)
    }
  };
}

export function compareSourceEvidenceBaseline(
  report: SourceEvidenceReport,
  baseline: SourceEvidenceBaseline
): SourceEvidenceReconciliation {
  const actualValues = metricsFromReport(report);
  const probedMetrics: readonly (keyof Omit<
    SourceEvidenceBaselineMetrics,
    "legacyOldSlugRecords"
  >)[] = [
    "posts",
    "pages",
    "wprmPostRecords",
    "wpurMetadataSignalPosts",
    "postTranslationGroups",
    "termTranslationGroups",
    "redirectionPluginRecords",
    "matchedAttachments",
    "bwgImageRecords"
  ];
  const comparisons: SourceEvidenceComparison[] = [...probedMetrics]
    .sort((left, right) => left.localeCompare(right))
    .map((metric) => {
      const expected = baseline.metrics[metric];
      const actual = actualValues[metric];
      return {
        metric,
        expected,
        actual,
        status: actual === expected ? "match" : "mismatch"
      };
    });
  return {
    baselineSupplied: true,
    comparisons,
    passed: comparisons.every((comparison) => comparison.status === "match"),
    informational: {
      legacyOldSlugRecords: {
        expected: baseline.metrics.legacyOldSlugRecords,
        status: "not-probed"
      }
    }
  };
}
