import {
  fingerprintCandidate,
  readFingerprintKey,
  stageWprmCandidates
} from "./wprm-import-stage";
import {
  mapWprmRecipeCandidate,
  WprmMappingError
} from "./wprm-import-map";
import {
  deriveWprmRelations,
  relationIssues
} from "./wprm-import-relations";
import {
  extractWprmSource
} from "./wprm-import-source";
import { resolveWprmUploadArchives } from "./wprm-import-source";
import {
  hashVerifiedOpenUploadArchiveEntry,
  openVerifiedUploadArchive
} from "./uploads-media";
import { uploadIndexContractHash } from "./uploads-inventory";
import {
  classifyWprmCandidateDisposition,
  isInformationalWprmIssueCode,
  sourcePublicationIssueCode,
  WprmImportError,
  mergeWprmImportLimits,
  type CandidateOutcome,
  type WprmImportOptions,
  type WprmBulkImportResult,
  type WprmIssueCode,
  type WprmStagedMediaBindings,
  type WprmSafeManifest
} from "./wprm-import-contracts";
import { normalizeWprmAttachmentFile } from "./wprm-import-map";
import { uploadMatchedAttachmentCount } from "./wprm-import-contracts";
import { resolveWprmRedirects } from "./wprm-import-redirects";
import { loadHandAuthoredStaticWebAppConfig } from "../staticwebapp-config";
import { loadRecipeCatalogWithSources } from "../../src/content/catalog";
import { getStaticPageParams } from "../../src/lib/recipe-routes";

const fatalIssueCodes = new Set<WprmIssueCode>([
  "missing-recipe-locale",
  "unsafe-canonical-slug",
  "canonical-slug-collision",
  "nonpublish-recipe",
  "nonpublish-editorial-parent",
  "unknown-recipe-status",
  "unknown-editorial-parent-status",
  "protected-source-post",
  "protected-editorial-parent",
  "missing-wprm-title",
  "malformed-wprm-rich-text",
  "rich-text-normalization-limit",
  "malformed-wprm-ingredients",
  "malformed-wprm-instructions",
  "duplicate-singular-meta",
  "missing-attachment",
  "unsafe-attachment-path",
  "attachment-archive-missing",
  "duplicate-attachment-archive-path",
  "unsupported-attachment-extension",
  "invalid-attachment-metadata",
  "invalid-taxonomy-membership",
  "unsupported-wprm-post",
  "missing-wprm-metadata",
  "malformed-wprm-meta",
  "source-limit"
]);

const reviewIssueCodes = new Set<WprmIssueCode>([
  "missing-editorial-parent",
  "self-editorial-parent",
  "dangling-editorial-parent",
  "noneditorial-parent",
  "incomplete-parent-translation",
  "multiple-recipes-for-editorial-member",
  "invalid-parent-group-locale",
  "duplicate-parent-group-locale",
  "ambiguous-parent-translation-group",
  "timestamp-without-gmt",
  "unsupported-wprm-field",
  "unsupported-wprm-type",
  "malformed-wprm-type",
  "unsupported-wprm-servings-advanced",
  "malformed-wprm-servings-advanced",
  "malformed-wprm-servings-advanced-enabled",
  "redirect-candidate",
  "old-slug-candidate"
]);

function issueCode(value: string): WprmIssueCode {
  if (
    fatalIssueCodes.has(value as WprmIssueCode)
    || reviewIssueCodes.has(value as WprmIssueCode)
    || isInformationalWprmIssueCode(value as WprmIssueCode)
  ) {
    return value as WprmIssueCode;
  }
  return "malformed-wprm-meta";
}

function sortedCodes(values: Iterable<WprmIssueCode>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber
    ? -1
    : leftNumber > rightNumber
      ? 1
      : left.localeCompare(right);
}

function handAuthoredRoutePaths() {
  const config = loadHandAuthoredStaticWebAppConfig(process.cwd());
  if (
    config === undefined
    || typeof config !== "object"
    || config === null
    || !("routes" in config)
    || !Array.isArray(config.routes)
  ) {
    return [];
  }

  return config.routes.flatMap((route) =>
    typeof route === "object"
      && route !== null
      && !Array.isArray(route)
      && "route" in route
      && typeof route.route === "string"
      ? [route.route]
      : []
  );
}

function currentStaticRoutePaths() {
  const routes = getStaticPageParams(loadRecipeCatalogWithSources().records).map(({ segments }) =>
    segments.length === 0
      ? "/"
      : `/${segments.map((segment, index) =>
        index === segments.length - 1 ? encodeURIComponent(segment) : segment
      ).join("/")}`
  );
  return [
    ...routes,
    "/robots.txt",
    "/sitemap.xml",
    "/_search/en.json",
    "/_search/fr.json",
    "/_search/ru.json"
  ];
}

function outcomeWithStatus(
  recipeId: string,
  record: CandidateOutcome["record"],
  codes: readonly WprmIssueCode[],
  fallbackLocale: CandidateOutcome["locale"],
  fingerprint: string | null = null,
  reviewOnlyCodes: ReadonlySet<WprmIssueCode> = new Set()
): CandidateOutcome {
  const normalizedCodes = sortedCodes(codes);
  const status = normalizedCodes.some(
    (code) => fatalIssueCodes.has(code) && !reviewOnlyCodes.has(code)
  )
    ? "error"
    : normalizedCodes.some(
      (code) => reviewIssueCodes.has(code) || reviewOnlyCodes.has(code)
    )
      ? "review"
      : "ready";
  return {
    recipeId,
    status,
    locale: record?.locale ?? fallbackLocale,
    codes: normalizedCodes,
    record: status === "error" ? null : record,
    fingerprint
  };
}

function mappingCodes(error: unknown): readonly WprmIssueCode[] {
  if (error instanceof WprmMappingError) {
    return error.issueCodes;
  }
  if (error instanceof WprmImportError) {
    return [issueCode(error.code)];
  }
  return ["malformed-wprm-meta"];
}

function sourceBoundaryCodes(
  recipeId: string,
  snapshot: Awaited<ReturnType<typeof extractWprmSource>>,
  relations: ReturnType<typeof deriveWprmRelations>
) {
  const codes = new Set<WprmIssueCode>();
  const recipe = snapshot.graph.posts.get(recipeId);
  if (recipe === undefined) {
    return codes;
  }
  const recipePublicationIssue = sourcePublicationIssueCode(recipe.status, "recipe");
  if (recipePublicationIssue !== null) {
    codes.add(recipePublicationIssue);
  }
  if (recipe.hasPassword) {
    codes.add("protected-source-post");
  }
  const parentLink = relations.parentLinks.get(recipeId);
  if (parentLink?.parentKind !== "usable" || parentLink.parentId === null) {
    return codes;
  }
  const parent = snapshot.graph.posts.get(parentLink.parentId);
  if (parent === undefined) {
    return codes;
  }
  const parentPublicationIssue = sourcePublicationIssueCode(
    parent.status,
    "editorial-parent"
  );
  if (parentPublicationIssue !== null) {
    codes.add(parentPublicationIssue);
  }
  if (parent.hasPassword) {
    codes.add("protected-editorial-parent");
  }
  return codes;
}

function sourceSummary(snapshot: Awaited<ReturnType<typeof extractWprmSource>>) {
  const entries = snapshot.uploads.summaries.reduce(
    (total, summary) => total + summary.entries,
    0
  );
  const uploadFiles = snapshot.uploads.summaries.reduce(
    (total, summary) => total + summary.uploadFiles,
    0
  );
  return {
    format: snapshot.sql.format,
    decompressedBytes: snapshot.sql.decompressedBytes,
    sqlDecompressedSha256: snapshot.sql.sqlDecompressedSha256,
    uploadIndexContractSha256: uploadIndexContractHash(snapshot.uploads),
    sqlRows: snapshot.sql.rows,
    sqlStatements: snapshot.sql.statements,
    uploads: {
      archives: snapshot.uploads.summaries.length,
      entries,
      uploadFiles,
      matchedAttachments: uploadMatchedAttachmentCount(snapshot)
    }
  };
}

function nonLaunchFieldReconciliation(
  snapshot: Awaited<ReturnType<typeof extractWprmSource>>
) {
  let authorNamesExcluded = 0;
  let pinImageFieldsExcluded = 0;
  let pinImageFieldsWithoutReference = 0;
  let resolvedPinImageReferences = 0;
  let unresolvedPinImageReferences = 0;
  let videoFieldsExcluded = 0;
  let opaqueTypesExcluded = 0;
  for (const metadata of snapshot.metadata.wprm.values()) {
    authorNamesExcluded += metadata.excludedAuthorData;
    pinImageFieldsExcluded += metadata.excludedSocialMediaData;
    pinImageFieldsWithoutReference += metadata.pinImageFieldsWithoutReference;
    resolvedPinImageReferences += metadata.resolvedPinImageReferences;
    unresolvedPinImageReferences += metadata.unresolvedPinImageReferences;
    videoFieldsExcluded += metadata.excludedVideoData;
    opaqueTypesExcluded += metadata.excludedWprmType;
  }
  return {
    authorNamesExcluded,
    pinImageFieldsExcluded,
    pinImageFieldsWithoutReference,
    resolvedPinImageReferences,
    unresolvedPinImageReferences,
    videoFieldsExcluded,
    opaqueTypesExcluded
  };
}

function createManifest(
  snapshot: Awaited<ReturnType<typeof extractWprmSource>>,
  relations: ReturnType<typeof deriveWprmRelations>,
  outcomes: readonly CandidateOutcome[],
  redirects = relations.redirects
): WprmSafeManifest {
  const ready = outcomes.filter((outcome) => outcome.status === "ready").length;
  const review = outcomes.filter((outcome) => outcome.status === "review").length;
  const error = outcomes.filter((outcome) => outcome.status === "error").length;
  const safeOutcomes = [...outcomes]
    .sort((left, right) => numericIdSort(left.recipeId, right.recipeId))
    .map((outcome) => ({
      recipeId: outcome.recipeId,
      locale: outcome.locale,
      status: outcome.status,
      codes: outcome.codes,
      fingerprint: outcome.fingerprint
    }));
  const source = sourceSummary(snapshot);
  const nonLaunchFields = nonLaunchFieldReconciliation(snapshot);
  const publicationExcludedCandidates = outcomes.filter((outcome) =>
    classifyWprmCandidateDisposition(outcome.codes) === "publication-excluded"
  ).length;
  const integrityBlockingCandidates = outcomes.filter((outcome) =>
    classifyWprmCandidateDisposition(outcome.codes) === "integrity-blocking"
  ).length;
  return {
    schemaVersion: 5,
    kind: "wprm-bulk-import-manifest",
    source,
    candidates: {
      total: outcomes.length,
      ready,
      review,
      error,
      outcomes: safeOutcomes
    },
    wpurSignals: snapshot.metadata.wpurSignalPosts.size,
    wpurRecordsEmitted: 0,
    redirects,
    aggregate: {
      wprmPosts: outcomes.length,
      nonpublishRecipes: outcomes.filter((outcome) =>
        outcome.codes.includes("nonpublish-recipe")
      ).length,
      publicationExcludedCandidates,
      integrityBlockingCandidates,
      usableParents: relations.usableParentRecipes,
      missingParents: relations.missingParentRecipes,
      provenParentGroups: relations.provenParentGroups,
      incompleteParentGroups: relations.incompleteParentGroups,
      usableParentRecipesOutsideGroups: relations.usableParentRecipesOutsideGroups,
      directWprmGroups: relations.directWprmGroups,
      wpurSignals: snapshot.metadata.wpurSignalPosts.size,
      wpurRecordsEmitted: 0,
      indexedAttachments: snapshot.graph.attachments.size,
      matchedAttachments: source.uploads.matchedAttachments,
      redirectCandidates: redirects.candidates,
      acceptedRedirects: redirects.accepted,
      nonLaunchFields
    },
    privacy: {
      rawValuesEmitted: false,
      sourceWordingEmitted: false,
      sourcePathsEmitted: false,
      timestampsEmitted: false,
      serializedValuesEmitted: false,
      individualValueHashesEmitted: 0
    }
  };
}

function addCollisionErrors(outcomes: readonly CandidateOutcome[]) {
  const byKey = new Map<string, CandidateOutcome[]>();
  for (const outcome of outcomes) {
    if (outcome.record === null || outcome.status === "error") {
      continue;
    }
    const key = `${outcome.record.locale}:${outcome.record.slug}`;
    const values = byKey.get(key) ?? [];
    values.push(outcome);
    byKey.set(key, values);
  }
  const collisions = new Set(
    [...byKey.values()]
      .filter((values) => values.length > 1)
      .flatMap((values) => values.map((value) => value.recipeId))
  );
  return outcomes.map((outcome) => collisions.has(outcome.recipeId)
    ? {
      ...outcome,
      status: "error" as const,
      codes: sortedCodes([...outcome.codes, "canonical-slug-collision"]),
      record: null,
      fingerprint: null
    }
    : outcome);
}

function referencedMediaIds(record: NonNullable<CandidateOutcome["record"]>) {
  return new Set([
    record.recipe.heroMediaId,
    ...record.recipe.instructionGroups.flatMap((group) =>
      group.steps.map((step) => step.mediaId)
    )
  ].filter((value): value is string => value !== null));
}

async function bindStagedMedia(
  outcomes: readonly CandidateOutcome[],
  snapshot: Awaited<ReturnType<typeof extractWprmSource>>,
  archivePaths: readonly string[],
  key: Uint8Array
): Promise<WprmStagedMediaBindings> {
  const required = new Map<string, {
    readonly archiveIndex: number;
    readonly sourcePath: string;
  }>();
  for (const outcome of outcomes) {
    if (outcome.status !== "ready" || outcome.record === null) {
      continue;
    }
    const referenced = referencedMediaIds(outcome.record);
    if (referenced.size !== outcome.record.media.length) {
      throw new WprmImportError("invalid-media-provenance");
    }
    for (const media of outcome.record.media) {
      if (
        !referenced.has(media.id)
        || media.sourceId === null
        || !/^\d+$/u.test(media.sourceId)
        || media.id !== `wordpress-attachment:${media.sourceId}`
      ) {
        throw new WprmImportError("invalid-media-provenance");
      }
      const metadata = snapshot.metadata.attachments.get(media.sourceId);
      const sourcePath = normalizeWprmAttachmentFile(metadata?.attachedFile ?? null);
      const indexes = sourcePath === null
        ? undefined
        : snapshot.uploads.uploadPathArchives.get(sourcePath);
      if (
        snapshot.graph.attachments.get(media.sourceId) === undefined
        || metadata === undefined
        || sourcePath === null
        || snapshot.uploads.uploadPathCounts.get(sourcePath) !== 1
        || indexes === undefined
        || indexes.size !== 1
      ) {
        throw new WprmImportError("invalid-media-provenance");
      }
      const archiveIndex = [...indexes][0];
      if (archiveIndex === undefined || archivePaths[archiveIndex] === undefined) {
        throw new WprmImportError("invalid-media-provenance");
      }
      const previous = required.get(media.sourceId);
      if (
        previous !== undefined
        && (
          previous.archiveIndex !== archiveIndex
          || previous.sourcePath !== sourcePath
        )
      ) {
        throw new WprmImportError("invalid-media-provenance");
      }
      required.set(media.sourceId, { archiveIndex, sourcePath });
    }
  }

  const opened: Awaited<ReturnType<typeof openVerifiedUploadArchive>>[] = [];
  try {
    for (const archivePath of archivePaths) {
      opened.push(await openVerifiedUploadArchive(archivePath));
    }
    const entries = [];
    for (const attachmentId of [...required.keys()].sort(numericIdSort)) {
      const source = required.get(attachmentId);
      if (source === undefined) {
        throw new WprmImportError("invalid-media-provenance");
      }
      const archive = opened[source.archiveIndex];
      if (archive === undefined) {
        throw new WprmImportError("invalid-media-provenance");
      }
      const verified = await hashVerifiedOpenUploadArchiveEntry(
        archive,
        source.sourcePath,
        {
          keyedDigest: {
            key,
            context: attachmentId
          }
        }
      );
      if (verified.keyedSha256 === null) {
        throw new WprmImportError("invalid-media-bindings");
      }
      entries.push({
        attachmentId,
        bytes: verified.bytes,
        keyedSha256: verified.keyedSha256
      });
    }
    return {
      schemaVersion: 1,
      kind: "wprm-staged-media-bindings",
      entries
    };
  } finally {
    await Promise.all(opened.map((archive) => archive.close()));
  }
}

export async function runWprmBulkImport(
  options: WprmImportOptions
): Promise<WprmBulkImportResult> {
  if (typeof options.database !== "string" || options.database.length === 0) {
    throw new WprmImportError("missing-database");
  }
  if (
    typeof options.fingerprintKeyFile !== "string"
    || options.fingerprintKeyFile.length === 0
  ) {
    throw new WprmImportError("missing-fingerprint-key");
  }
  const write = options.write === true;
  const dryRun = options.dryRun === true;
  if (write && dryRun) {
    throw new WprmImportError("conflicting-mode");
  }
  if (write && !options.stagingDir) {
    throw new WprmImportError("missing-staging-dir");
  }
  if (options.resume && !write) {
    throw new WprmImportError("resume-requires-write");
  }
  const limits = mergeWprmImportLimits(options.limits);
  const key = await readFingerprintKey(options.fingerprintKeyFile);
  const archives = await resolveWprmUploadArchives(
    options.uploadsDir,
    options.uploadArchives
  );
  const snapshot = await extractWprmSource({
    database: options.database,
    uploadArchives: archives,
    limits
  });
  const relations = deriveWprmRelations(snapshot.graph, snapshot.metadata, limits);
  const recipeIds = [...snapshot.graph.posts.values()]
    .filter((post) => post.type.toLowerCase() === "wprm_recipe")
    .map((post) => post.id)
    .sort(numericIdSort);
  const mapped: CandidateOutcome[] = [];
  for (const recipeId of recipeIds) {
    const codes = new Set<WprmIssueCode>([
      ...relationIssues(relations, recipeId),
      ...sourceBoundaryCodes(recipeId, snapshot, relations)
    ]);
    let record: CandidateOutcome["record"] = null;
    try {
      const result = mapWprmRecipeCandidate(
        recipeId,
        snapshot.graph,
        snapshot.metadata,
        relations,
        snapshot.uploads,
        limits
      );
      record = result.record;
      for (const code of result.codes) {
        codes.add(code);
      }
    } catch (error) {
      for (const code of mappingCodes(error)) {
        codes.add(code);
      }
    }
    const candidate = outcomeWithStatus(
      recipeId,
      record,
      [...codes],
      relations.locales.get(recipeId) ?? null,
      null,
      record !== null
        && snapshot.metadata.wprm.get(recipeId)?.duplicateKeys.size === 1
        && snapshot.metadata.wprm.get(recipeId)?.duplicateKeys.has("wprm_type")
        ? new Set<WprmIssueCode>(["duplicate-singular-meta"])
        : undefined
    );
    mapped.push({
      ...candidate,
      translationGroupId: relations.translationGroups.get(recipeId) ?? null
    });
  }
  const outcomes = addCollisionErrors(mapped).map((outcome) => ({
    ...outcome,
    fingerprint: outcome.record === null
      ? null
      : fingerprintCandidate(key, outcome.record)
  }));
  const redirectResolution = resolveWprmRedirects({
    graph: snapshot.graph,
    metadata: snapshot.metadata,
    relations,
    outcomes,
    sourceTranslationGroups: relations.translationGroups,
    options: snapshot.options,
    staticRoutePaths: options.staticRoutePaths ?? currentStaticRoutePaths(),
    azureRoutePaths: options.azureRoutePaths ?? handAuthoredRoutePaths(),
    limits
  });
  const redirectedOutcomes = outcomes.map((outcome) => {
    if (outcome.record === null) {
      return outcome;
    }
    const redirectFrom = redirectResolution.byRecipeId.get(outcome.record.id) ?? [];
    const record = redirectFrom.length === 0
      ? outcome.record
      : {
        ...outcome.record,
        redirectFrom: [...redirectFrom]
      };
    return {
      ...outcome,
      record,
      fingerprint: fingerprintCandidate(key, record)
    };
  });
  let manifest = createManifest(snapshot, relations, redirectedOutcomes, redirectResolution.manifest);
  let finalOutcomes = redirectedOutcomes;
  if (write) {
    const mediaBindings = await bindStagedMedia(
      finalOutcomes,
      snapshot,
      archives,
      key
    );
    const staged = await stageWprmCandidates(finalOutcomes, manifest, mediaBindings, {
      stagingDir: options.stagingDir!,
      fingerprintKeyFile: options.fingerprintKeyFile,
      resume: options.resume
    });
    finalOutcomes = staged.outcomes;
    manifest = staged.manifest;
  } else if (!dryRun) {
    // The importer is intentionally safe by default; no mode means dry-run.
    manifest = createManifest(
      snapshot,
      relations,
      finalOutcomes,
      redirectResolution.manifest
    );
  }
  return {
    manifest,
    outcomes: finalOutcomes,
    snapshot,
    sourceTranslationGroups: relations.translationGroups
  };
}

export function serializeWprmManifest(manifest: WprmSafeManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const serializeSafeWprmManifest = serializeWprmManifest;
export const runImporter = runWprmBulkImport;
export const runWprmImport = runWprmBulkImport;
export const runWordPressWprmBulkImport = runWprmBulkImport;
