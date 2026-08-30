import {
  defaultWprmImportLimits,
  type CandidateOutcome,
  type RedirectManifest,
  type WprmImportLimits,
  type WprmSourceGraph,
  type WprmSourceMetadata
} from "./wprm-import-contracts";
import type { WprmRelations } from "./wprm-import-relations";
import type { WprmWordPressOptions } from "./wprm-import-options";
import { collectTargetStrings, readJsonValue, withinStructuredLimits } from "./source-evidence-structured";
import { parsePhpSerialized } from "./php-serialize";
import {
  decodeLocalPath,
  localPathKey,
  validateSafeLocalPath
} from "../../src/content/url-path";
import { getRecipePath } from "../../src/lib/recipe-routes";
import { type Locale, type RecipeRecord } from "../../src/content/schema";
import {
  isIntentionallyPartialOutcome,
  selectPromotionEligibleRecords
} from "./wprm-promotion-eligibility";

export type WprmRedirectIssue = {
  readonly code: string;
  readonly count: number;
};

export type WprmResolvedRedirect = {
  readonly source: string;
  readonly destination: string;
  readonly recipeId: string;
  readonly locale: Locale;
  readonly kind: "canonical" | "old-slug" | "plugin";
};

export type WprmRedirectResolverInput = {
  readonly graph: WprmSourceGraph;
  readonly metadata: Pick<WprmSourceMetadata, "wprm">;
  readonly relations: Pick<WprmRelations, "locales" | "parentLinks"> & {
    readonly translationGroups?: ReadonlyMap<string, string | null>;
  };
  readonly outcomes?: readonly CandidateOutcome[];
  readonly promotedRecords?: readonly RecipeRecord[];
  readonly eligibleRecords?: readonly RecipeRecord[];
  readonly sourceTranslationGroups?: ReadonlyMap<string, string | null>;
  readonly options: WprmWordPressOptions;
  readonly staticRoutePaths?: readonly string[];
  readonly azureRoutePaths?: readonly string[];
  readonly limits?: WprmImportLimits;
};

export type WprmRedirectResolution = {
  readonly redirects: readonly WprmResolvedRedirect[];
  readonly byRecipeId: ReadonlyMap<string, readonly string[]>;
  readonly manifest: RedirectManifest;
  readonly issues: readonly WprmRedirectIssue[];
};

type Identity = {
  readonly record: RecipeRecord;
  readonly locale: Locale;
  readonly currentPath: string;
  readonly currentKey: string;
};

type AliasCandidate = {
  readonly source: string;
  readonly key: string;
  readonly identity: Identity;
  readonly kind: "canonical" | "old-slug";
};

type ParsedPluginRow = {
  readonly rowIndex: number;
  readonly source: string;
  readonly sourceKey: string;
  readonly target: string;
  readonly targetKey: string;
};

const localeDefaults: Readonly<Record<Locale, number>> = {
  en: 0,
  fr: 0,
  ru: 0
};

function numericIdSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber
    ? -1
    : leftNumber > rightNumber
      ? 1
      : left.localeCompare(right);
}

function sourceOrder(left: string, right: string) {
  try {
    return localPathKey(left).localeCompare(localPathKey(right))
      || left.localeCompare(right);
  } catch {
    return left.localeCompare(right);
  }
}

function addIssue(issues: Map<string, number>, code: string, count = 1) {
  if (count <= 0) {
    return;
  }
  issues.set(code, (issues.get(code) ?? 0) + count);
}

function issueList(issues: ReadonlyMap<string, number>) {
  return [...issues.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

function safeKey(value: string, label: string) {
  validateSafeLocalPath(value, label);
  return localPathKey(value);
}

function editorialPath(
  value: string | null,
  locale: Locale,
  label: string
) {
  if (value === null || value.length === 0) {
    throw new Error(`${label} is missing.`);
  }
  if (/%25(?=[0-9a-f]{2})/iu.test(value)) {
    throw new Error(`${label} uses ambiguous repeated encoding.`);
  }
  const decoded = decodeLocalPath(value);
  if (
    decoded.length === 0
    || /\s|[\/\\?#*\u0000-\u001f\u007f]/u.test(decoded)
    || decoded === "."
    || decoded === ".."
  ) {
    throw new Error(`${label} contains an unsafe path segment.`);
  }
  const prefix = locale === "en" ? "" : `/${locale}`;
  const path = `${prefix}/${value}/`;
  validateSafeLocalPath(path, label);
  return {
    path,
    key: localPathKey(path)
  };
}

function currentPath(record: RecipeRecord) {
  const path = getRecipePath(record);
  const destination = path.endsWith("/") ? path : `${path}/`;
  validateSafeLocalPath(destination, "current recipe path");
  return {
    path: destination,
    key: localPathKey(destination)
  };
}

function normalizedRouteKeys(
  paths: readonly string[] | undefined,
  issues: Map<string, number>,
  issueCode: string
) {
  const keys = new Set<string>();
  for (const path of paths ?? []) {
    try {
      keys.add(safeKey(path, "static route"));
    } catch {
      addIssue(issues, issueCode);
    }
  }
  return keys;
}

function isPublished(post: { readonly status: string } | undefined) {
  return post?.status.trim().toLowerCase() === "publish";
}

function sourceValidIdentity(
  record: RecipeRecord,
  graph: WprmSourceGraph,
  relations: Pick<WprmRelations, "locales" | "parentLinks">
) {
  const recipeId = record.source.recipeId;
  const recipe = graph.posts.get(recipeId);
  const link = relations.parentLinks.get(recipeId);
  if (
    recipe === undefined
    || !isPublished(recipe)
    || link === undefined
    || link.parentKind !== "usable"
    || link.parentId === null
    || record.source.editorialPostId !== link.parentId
    || !isPublished(graph.posts.get(link.parentId))
    || relations.locales.get(recipeId) !== record.locale
  ) {
    return null;
  }
  let path: ReturnType<typeof currentPath>;
  try {
    path = currentPath(record);
  } catch {
    return null;
  }
  return {
    record,
    locale: record.locale,
    currentPath: path.path,
    currentKey: path.key
  } satisfies Identity;
}

function sortedRecords(records: readonly RecipeRecord[]) {
  return [...records].sort((left, right) =>
    numericIdSort(left.source.recipeId, right.source.recipeId)
  );
}

function sourceTranslationGroupEvidence(input: WprmRedirectResolverInput) {
  const supplied = input.sourceTranslationGroups ?? input.relations.translationGroups;
  if (supplied !== undefined) {
    return supplied;
  }
  if (input.outcomes === undefined) {
    return undefined;
  }
  if (input.outcomes.some((outcome) =>
    outcome.translationGroupId === undefined
    && outcome.record?.translationGroupId === undefined
  )) {
    return null;
  }
  return new Map(
    input.outcomes.map((outcome) => [
      outcome.recipeId,
      outcome.translationGroupId
        ?? outcome.record?.translationGroupId
        ?? null
    ] as const)
  );
}

function outcomeRecordsEligibleForRedirects(
  outcomes: readonly CandidateOutcome[],
  sourceTranslationGroups: ReadonlyMap<string, string | null>
) {
  return outcomes.flatMap((outcome) =>
    outcome.record !== null
    && (
      outcome.status === "ready"
      || isIntentionallyPartialOutcome(
        outcome,
        sourceTranslationGroups.get(outcome.recipeId)
      )
    )
      ? [outcome.record]
      : []
  );
}

function redirectEligibleRecords(input: WprmRedirectResolverInput) {
  const explicit = input.promotedRecords ?? input.eligibleRecords;
  if (input.outcomes === undefined) {
    const records = sortedRecords(explicit ?? []);
    return { candidates: records, selected: records };
  }

  const sourceTranslationGroups = sourceTranslationGroupEvidence(input);
  if (sourceTranslationGroups === null || sourceTranslationGroups === undefined) {
    return { candidates: [], selected: [] };
  }

  const outcomeCandidates = outcomeRecordsEligibleForRedirects(
    input.outcomes,
    sourceTranslationGroups
  );
  const eligibleOutcomeIds = new Set(
    outcomeCandidates.map((record) => record.source.recipeId)
  );
  const candidates = sortedRecords(
    explicit === undefined
      ? outcomeCandidates
      : explicit.filter((record) => eligibleOutcomeIds.has(record.source.recipeId))
  );
  return {
    candidates,
    selected: selectPromotionEligibleRecords(
      candidates,
      input.outcomes,
      sourceTranslationGroups
    ).selected
  };
}

function targetFromActionData(
  value: string | null,
  limits: WprmImportLimits
) {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > limits.evidence.maxMetaValueBytes) {
    return null;
  }
  const structured = /^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed)
    || /^N;/u.test(trimmed)
    || /^[\[{]/u.test(trimmed);
  if (!structured && trimmed !== value) {
    return null;
  }
  if (
    /^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed)
    || /^N;/u.test(trimmed)
  ) {
    try {
      const parsed = parsePhpSerialized(trimmed, {
        maxInputBytes: limits.evidence.maxMetaValueBytes,
        maxDepth: limits.evidence.maxSerializedDepth,
        maxEntries: limits.evidence.maxSerializedEntries,
        maxStringBytes: limits.evidence.maxMetaValueBytes
      });
      const targets = collectTargetStrings(parsed);
      return targets.length === 1 ? targets[0] ?? null : null;
    } catch {
      return null;
    }
  }
  if (/^[\[{]/u.test(trimmed)) {
    const parsed = readJsonValue(trimmed);
    if (
      parsed === null
      || !withinStructuredLimits(parsed, limits.evidence)
    ) {
      return null;
    }
    const targets = collectTargetStrings(parsed);
    return targets.length === 1 ? targets[0] ?? null : null;
  }
  return trimmed;
}

function normalizeTarget(
  value: string | null,
  options: WprmWordPressOptions,
  limits: WprmImportLimits
) {
  const target = targetFromActionData(value, limits);
  if (target === null || target.length === 0) {
    return { kind: "invalid" as const };
  }
  if (/%25(?=[0-9a-f]{2})/iu.test(target)) {
    return { kind: "invalid" as const };
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(target) || target.startsWith("//")) {
    const absoluteTarget = /^(?:https?):\/\/[^/?#]*([^?#]*)$/iu.exec(target);
    if (
      absoluteTarget === null
      || target.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(target)
    ) {
      return { kind: "external" as const };
    }
    const rawPath = absoluteTarget[1] || "/";
    try {
      safeKey(rawPath, "redirect target");
    } catch {
      return { kind: "invalid" as const };
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return { kind: "external" as const };
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin !== options.homeOrigin
      || target.includes("?")
      || target.includes("#")
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
    ) {
      return { kind: "external" as const };
    }
    try {
      const path = parsed.pathname;
      return {
        kind: "local" as const,
        path,
        key: safeKey(path, "redirect target")
      };
    } catch {
      return { kind: "invalid" as const };
    }
  }
  try {
    return {
      kind: "local" as const,
      path: target,
      key: safeKey(target, "redirect target")
    };
  } catch {
    return { kind: "invalid" as const };
  }
}

function normalizeSource(value: string | null) {
  if (value === null || value.length === 0) {
    return null;
  }
  if (/%25(?=[0-9a-f]{2})/iu.test(value)) {
    return null;
  }
  try {
    const key = safeKey(value, "redirect source");
    if (key === "/") {
      return null;
    }
    return {
      source: value,
      key
    };
  } catch {
    return null;
  }
}

function enabled(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "enabled" || normalized === "1" || normalized === "true";
}

function exactPluginShape(redirect: WprmSourceGraph["redirects"][number]) {
  const matcher = redirect.matchType?.trim().toLowerCase() ?? "";
  const regex = redirect.regex?.trim().toLowerCase() ?? "";
  return {
    regex: matcher === "regex" || regex === "1" || regex === "true",
    exact: matcher === "url" && (regex.length === 0 || regex === "0")
  };
}

function addIdentity(
  map: Map<string, Set<Identity>>,
  key: string,
  identity: Identity
) {
  const identities = map.get(key) ?? new Set<Identity>();
  identities.add(identity);
  map.set(key, identities);
}

function identityFor(
  map: ReadonlyMap<string, ReadonlySet<Identity>>,
  key: string
): Identity | null | "ambiguous" {
  const identities = map.get(key);
  if (identities === undefined || identities.size === 0) {
    return null;
  }
  if (identities.size !== 1) {
    return "ambiguous";
  }
  return [...identities][0] ?? null;
}

function canonicalDestination(identity: Identity) {
  return identity.currentPath;
}

function resolveWprmRedirectsInternal(
  input: WprmRedirectResolverInput
): WprmRedirectResolution {
  const limits = input.limits ?? defaultWprmImportLimits;
  const issues = new Map<string, number>();
  const eligibility = redirectEligibleRecords(input);
  const candidateRecords = eligibility.candidates;
  const sourceValidRecords = candidateRecords.filter((record) =>
    sourceValidIdentity(record, input.graph, input.relations) !== null
  );
  const identities: Identity[] = [];
  const eligibleRecords = eligibility.selected;
  const eligibleIds = new Set(
    eligibleRecords.map((record) => record.source.recipeId)
  );
  for (const record of sourceValidRecords) {
    if (!eligibleIds.has(record.source.recipeId)) {
      continue;
    }
    const identity = sourceValidIdentity(record, input.graph, input.relations);
    if (identity !== null) {
      identities.push(identity);
    }
  }
  identities.sort((left, right) =>
    numericIdSort(left.record.source.recipeId, right.record.source.recipeId)
  );

  const aliases = new Map<string, Set<Identity>>();
  const terminalIdentities = new Map<string, Set<Identity>>();
  const currentRoutes = normalizedRouteKeys(
    input.staticRoutePaths,
    issues,
    "redirect-static-route-invalid"
  );
  const azureRoutes = normalizedRouteKeys(
    input.azureRoutePaths,
    issues,
    "redirect-azure-route-invalid"
  );
  for (const identity of identities) {
    currentRoutes.add(identity.currentKey);
    addIdentity(terminalIdentities, identity.currentKey, identity);
  }

  const canonicalCandidates: AliasCandidate[] = [];
  const oldSlugCandidates: AliasCandidate[] = [];
  let oldSlugCandidateCount = 0;
  for (const identity of identities) {
    const parentId = input.relations.parentLinks.get(identity.record.source.recipeId)?.parentId;
    const parent = parentId === null || parentId === undefined
      ? undefined
      : input.graph.posts.get(parentId);
    try {
      const canonical = editorialPath(
        parent?.slug ?? null,
        identity.locale,
        "editorial post_name"
      );
      const candidate = {
        source: canonical.path,
        key: canonical.key,
        identity,
        kind: "canonical"
      } satisfies AliasCandidate;
      canonicalCandidates.push(candidate);
      addIdentity(aliases, candidate.key, identity);
    } catch {
      addIssue(issues, "redirect-unsafe-canonical-source");
    }

    const oldSlugs = parentId === null || parentId === undefined
      ? []
      : input.metadata.wprm.get(parentId)?.oldSlugs ?? [];
    oldSlugCandidateCount += oldSlugs.length;
    for (const oldSlug of oldSlugs) {
      try {
        const oldPath = editorialPath(oldSlug, identity.locale, "_wp_old_slug");
        const candidate = {
          source: oldPath.path,
          key: oldPath.key,
          identity,
          kind: "old-slug"
        } satisfies AliasCandidate;
        oldSlugCandidates.push(candidate);
        addIdentity(aliases, candidate.key, identity);
      } catch {
        addIssue(issues, "redirect-unsafe-old-slug");
      }
    }
  }

  const acceptedByKey = new Map<string, WprmResolvedRedirect>();
  const acceptedAliases = new Map<string, AliasCandidate>();
  const addAlias = (candidate: AliasCandidate) => {
    const mapped = aliases.get(candidate.key);
    if (
      mapped === undefined
      || mapped.size !== 1
      || mapped.has(candidate.identity) === false
    ) {
      if (mapped !== undefined && mapped.size > 1) {
        addIssue(issues, "redirect-cross-locale-conflict");
      }
      addIssue(issues, "redirect-conflicting-identity");
      return false;
    }
    if (
      currentRoutes.has(candidate.key)
      || azureRoutes.has(candidate.key)
    ) {
      addIssue(issues, "redirect-route-shadowing");
      return false;
    }
    if (candidate.key === candidate.identity.currentKey) {
      addIssue(issues, "redirect-self");
      return false;
    }
    const previous = acceptedAliases.get(candidate.key);
    if (previous !== undefined) {
      if (previous.identity.record.id !== candidate.identity.record.id) {
        addIssue(issues, "redirect-destination-conflict");
        return false;
      }
      addIssue(issues, "redirect-duplicate-semantic-source");
      return true;
    }
    acceptedAliases.set(candidate.key, candidate);
    addIdentity(terminalIdentities, candidate.key, candidate.identity);
    acceptedByKey.set(candidate.key, {
      source: candidate.source,
      destination: canonicalDestination(candidate.identity),
      recipeId: candidate.identity.record.id,
      locale: candidate.identity.locale,
      kind: candidate.kind
    });
    return true;
  };

  let canonicalAccepted = 0;
  for (const candidate of canonicalCandidates) {
    const before = acceptedAliases.size;
    if (addAlias(candidate) && acceptedAliases.size > before) {
      canonicalAccepted += 1;
    }
  }
  let oldSlugAccepted = 0;
  for (const candidate of oldSlugCandidates) {
    const before = acceptedAliases.size;
    if (addAlias(candidate) && acceptedAliases.size > before) {
      oldSlugAccepted += 1;
    }
  }

  const parsedRows: ParsedPluginRow[] = [];
  const duplicateSources = new Set<string>();
  const bySource = new Map<string, ParsedPluginRow[]>();
  let exactSafe = 0;
  let regex = 0;
  let unsupported = 0;
  let externalOrAmbiguous = 0;
  let unresolved = 0;
  let conflict = 0;
  let cycle = 0;
  let pluginDeduplicated = 0;
  for (const [rowIndex, redirect] of input.graph.redirects.entries()) {
    if (rowIndex >= limits.maxRedirectRecords) {
      unsupported += 1;
      addIssue(issues, "redirect-edge-limit");
      continue;
    }
    const shape = exactPluginShape(redirect);
    const source = normalizeSource(redirect.source);
    if (shape.regex) {
      regex += 1;
      addIssue(issues, "redirect-regex");
      continue;
    }
    if (
      !shape.exact
      || !enabled(redirect.status)
      || redirect.actionType?.trim().toLowerCase() !== "url"
      || redirect.actionCode?.trim() !== "301"
      || source === null
    ) {
      unsupported += 1;
      addIssue(issues, "redirect-unsupported");
      continue;
    }
    exactSafe += 1;
    const target = normalizeTarget(redirect.actionData, input.options, limits);
    if (target.kind === "external") {
      externalOrAmbiguous += 1;
      addIssue(issues, "redirect-external-or-ambiguous");
      continue;
    }
    if (target.kind === "invalid") {
      unresolved += 1;
      addIssue(issues, "redirect-unresolved");
      continue;
    }
    const row = {
      rowIndex,
      source: source.source,
      sourceKey: source.key,
      target: target.path,
      targetKey: target.key
    } satisfies ParsedPluginRow;
    if (row.sourceKey === row.targetKey) {
      conflict += 1;
      addIssue(issues, "redirect-self");
      continue;
    }
    parsedRows.push(row);
    const rows = bySource.get(row.sourceKey) ?? [];
    rows.push(row);
    bySource.set(row.sourceKey, rows);
  }

  for (const [sourceKey, rows] of bySource) {
    if (rows.length > 1) {
      duplicateSources.add(sourceKey);
      conflict += rows.length;
      addIssue(issues, "redirect-duplicate-semantic-source", rows.length);
    }
  }

  const graph = new Map<string, ParsedPluginRow>();
  for (const row of parsedRows) {
    if (
      !duplicateSources.has(row.sourceKey)
      && !currentRoutes.has(row.sourceKey)
      && !azureRoutes.has(row.sourceKey)
      && !terminalIdentities.has(row.sourceKey)
    ) {
      graph.set(row.sourceKey, row);
    }
  }

  const cycleSources = new Set<string>();
  const unresolvedSources = new Set<string>();
  type Terminal = Identity | null | "cycle" | "ambiguous";
  const terminalIdentity = new Map<string, Terminal>();
  const resolveTerminal = (start: string): Terminal => {
    const cached = terminalIdentity.get(start);
    if (cached !== undefined) {
      return cached;
    }
    const visited = new Set<string>();
    let current = start;
    for (let depth = 0; depth <= limits.maxRedirectDepth; depth += 1) {
      if (visited.has(current)) {
        for (const source of visited) {
          cycleSources.add(source);
        }
        terminalIdentity.set(start, "cycle");
        return "cycle";
      }
      visited.add(current);
      const edge = graph.get(current);
      if (edge === undefined) {
        const resolved = identityFor(terminalIdentities, current);
        terminalIdentity.set(start, resolved);
        return resolved;
      }
      current = edge.targetKey;
    }
    unresolvedSources.add(start);
    terminalIdentity.set(start, null);
    return null;
  };

  let pluginAccepted = 0;
  for (const row of parsedRows) {
    if (duplicateSources.has(row.sourceKey)) {
      continue;
    }
    const sourceIdentity = identityFor(terminalIdentities, row.sourceKey);
    if (sourceIdentity === "ambiguous") {
      addIssue(issues, "redirect-cross-locale-conflict");
      addIssue(issues, "redirect-conflicting-identity");
      conflict += 1;
      continue;
    }
    if (
      sourceIdentity === null
      && (
        currentRoutes.has(row.sourceKey)
        || azureRoutes.has(row.sourceKey)
      )
    ) {
      addIssue(issues, "redirect-route-shadowing");
      conflict += 1;
      continue;
    }
    const terminal = resolveTerminal(
      sourceIdentity === null ? row.sourceKey : row.targetKey
    );
    if (terminal === "cycle") {
      continue;
    }
    if (terminal === "ambiguous") {
      conflict += 1;
      addIssue(issues, "redirect-destination-conflict");
      addIssue(issues, "redirect-cross-locale-conflict");
      continue;
    }
    if (terminal === null) {
      unresolved += 1;
      addIssue(issues, "redirect-unresolved");
      continue;
    }
    if (sourceIdentity !== null) {
      if (sourceIdentity.record.id !== terminal.record.id) {
        conflict += 1;
        addIssue(issues, "redirect-conflicting-identity");
        continue;
      }
      pluginAccepted += 1;
      pluginDeduplicated += 1;
      continue;
    }
    const sourceAliasIdentities = aliases.get(row.sourceKey);
    if (
      sourceAliasIdentities !== undefined
      && (
        sourceAliasIdentities.size !== 1
        || [...sourceAliasIdentities][0]?.record.id !== terminal.record.id
      )
    ) {
      conflict += 1;
      continue;
    }
    const existing = acceptedByKey.get(row.sourceKey);
    if (
      existing !== undefined
      && existing.recipeId !== terminal.record.id
    ) {
      conflict += 1;
      addIssue(issues, "redirect-destination-conflict");
      continue;
    }
    if (existing === undefined) {
      acceptedByKey.set(row.sourceKey, {
        source: row.source,
        destination: canonicalDestination(terminal),
        recipeId: terminal.record.id,
        locale: terminal.locale,
        kind: "plugin"
      });
    } else {
      pluginDeduplicated += 1;
    }
    pluginAccepted += 1;
  };

  for (const source of cycleSources) {
    if (graph.has(source)) {
      cycle += 1;
      addIssue(issues, "redirect-cycle");
    }
  }
  for (const source of unresolvedSources) {
    if (graph.has(source)) {
      addIssue(issues, "redirect-depth");
    }
  }

  const resolved = [...acceptedByKey.values()]
    .sort((left, right) => sourceOrder(left.source, right.source));
  const byRecipeId = new Map<string, string[]>();
  for (const redirect of resolved) {
    const sources = byRecipeId.get(redirect.recipeId) ?? [];
    sources.push(redirect.source);
    byRecipeId.set(redirect.recipeId, sources);
  }
  for (const sources of byRecipeId.values()) {
    sources.sort(sourceOrder);
  }

  const localeCounts: Record<Locale, number> = { ...localeDefaults };
  for (const [recipeId] of byRecipeId) {
    const identity = identities.find((value) => value.record.id === recipeId);
    if (identity !== undefined) {
      localeCounts[identity.locale] += 1;
    }
  }
  const pluginUnresolved = unresolved;
  const manifest: RedirectManifest = {
    candidates:
      sourceValidRecords.length + oldSlugCandidateCount + input.graph.redirects.length,
    exactSafe,
    regex,
    unsupported,
    unresolvedTarget: unresolved,
    oldSlugCandidates: oldSlugCandidateCount,
    accepted: resolved.length,
    canonicalCandidates: sourceValidRecords.length,
    promotionEligibleCandidates: identities.length,
    canonicalAccepted,
    oldSlugAccepted,
    pluginRows: input.graph.redirects.length,
    pluginAccepted,
    pluginDeduplicated,
    pluginRegex: regex,
    pluginUnsupported: unsupported,
    pluginExternalOrAmbiguous: externalOrAmbiguous,
    pluginUnresolved,
    pluginConflict: conflict,
    pluginCycle: cycle,
    plugin: {
      rows: input.graph.redirects.length,
      accepted: pluginAccepted,
      deduplicated: pluginDeduplicated,
      regex,
      unsupported,
      externalOrAmbiguous,
      unresolved: pluginUnresolved,
      conflict,
      cycle
    },
    uniqueAcceptedSources: resolved.length,
    recipesWithRedirects: byRecipeId.size,
    localeCounts,
    issueCodes: issueList(issues)
  };

  return {
    redirects: resolved,
    byRecipeId,
    manifest,
    issues: issueList(issues)
  };
}

export function resolveWprmRedirects(
  input: WprmRedirectResolverInput
) {
  return resolveWprmRedirectsInternal(input);
}

export const resolveRecipeRedirects = resolveWprmRedirects;
export const buildWprmRedirectResolution = resolveWprmRedirects;
export const resolveWprmImportRedirects = resolveWprmRedirects;
export const deriveWprmRedirects = resolveWprmRedirects;
