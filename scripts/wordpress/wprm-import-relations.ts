import {
  localeValues,
  type Locale
} from "../../src/content/schema";
import { validateSafeLocalPath } from "../../src/content/url-path";
import {
  collectTargetStrings,
  readJsonValue,
  withinStructuredLimits
} from "./source-evidence-structured";
import { parsePhpSerialized } from "./php-serialize";
import {
  normalizedLocale,
  numericId
} from "./source-evidence-scan";
import {
  type CandidateOutcome,
  type WprmIssueCode,
  type WprmImportLimits,
  type WprmSourceGraph,
  type WprmSourceMetadata,
  type RedirectManifest
} from "./wprm-import-contracts";

export interface ParentRecipeLink {
  readonly recipeId: string;
  readonly parentId: string | null;
  readonly parentKind:
    | "missing"
    | "self"
    | "dangling"
    | "noneditorial"
    | "usable";
  readonly parentLocale: Locale | null;
  readonly recipeLocale: Locale | null;
}

export interface WprmRelations {
  readonly locales: ReadonlyMap<string, Locale | null>;
  readonly parentLinks: ReadonlyMap<string, ParentRecipeLink>;
  readonly translationGroups: ReadonlyMap<string, string | null>;
  readonly issues: ReadonlyMap<string, ReadonlySet<WprmIssueCode>>;
  readonly recipeTaxonomies: ReadonlyMap<string, ReturnType<typeof collectDirectTaxonomies>>;
  readonly editorialTaxonomies: ReadonlyMap<string, ReturnType<typeof collectDirectTaxonomies>>;
  readonly provenParentGroups: number;
  readonly incompleteParentGroups: number;
  readonly directWprmGroups: number;
  readonly usableParentRecipes: number;
  readonly usableParentRecipesOutsideGroups: number;
  readonly missingParentRecipes: number;
  readonly redirects: RedirectManifest;
  readonly localeByPost: ReadonlyMap<string, Locale>;
}

function addIssue(
  issues: Map<string, Set<WprmIssueCode>>,
  recipeId: string,
  code: WprmIssueCode
) {
  const values = issues.get(recipeId) ?? new Set<WprmIssueCode>();
  values.add(code);
  issues.set(recipeId, values);
}

function isEditorial(type: string) {
  return type.toLowerCase() === "post" || type.toLowerCase() === "page";
}

function numericSort(left: string, right: string) {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  return leftNumber < rightNumber
    ? -1
    : leftNumber > rightNumber
      ? 1
      : left.localeCompare(right);
}

interface PostTranslationGroup {
  readonly taxonomyId: string;
  readonly members: readonly string[];
  readonly editorialMembers: readonly string[];
  readonly directWprm: readonly string[];
  readonly directWpur: readonly string[];
  readonly relatedRecipes: readonly string[];
}

function sameGroupMembers(
  left: readonly string[],
  right: readonly string[]
) {
  return left.length === right.length
    && left.every((member, index) => member === right[index]);
}

function overlappingPostTranslationGroups(
  groups: readonly PostTranslationGroup[]
) {
  const groupsByEditorialMember = new Map<string, number[]>();
  for (const [index, group] of groups.entries()) {
    for (const member of group.editorialMembers) {
      const indexes = groupsByEditorialMember.get(member) ?? [];
      indexes.push(index);
      groupsByEditorialMember.set(member, indexes);
    }
  }

  const components: PostTranslationGroup[][] = [];
  const visited = new Set<number>();
  for (let index = 0; index < groups.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }
    const component: PostTranslationGroup[] = [];
    const pending = [index];
    visited.add(index);
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined) {
        continue;
      }
      const group = groups[current];
      if (group === undefined) {
        continue;
      }
      component.push(group);
      const adjacent = new Set<number>();
      for (const member of group.editorialMembers) {
        for (const adjacentIndex of groupsByEditorialMember.get(member) ?? []) {
          adjacent.add(adjacentIndex);
        }
      }
      for (const adjacentIndex of [...adjacent].sort((left, right) => left - right)) {
        if (!visited.has(adjacentIndex)) {
          visited.add(adjacentIndex);
          pending.push(adjacentIndex);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function localeTerms(graph: WprmSourceGraph) {
  const localeByPost = new Map<string, Locale>();
  const conflicting = new Set<string>();
  for (const [taxonomyId, taxonomy] of graph.taxonomies) {
    if (taxonomy.taxonomy.toLowerCase() !== "language") {
      continue;
    }
    const term = graph.terms.get(taxonomy.termId);
    const locale = normalizedLocale(term?.slug);
    if (locale === null) {
      continue;
    }
    for (const objectId of graph.relationships.get(taxonomyId) ?? []) {
      const previous = localeByPost.get(objectId);
      if (previous !== undefined && previous !== locale) {
        conflicting.add(objectId);
        localeByPost.delete(objectId);
      } else if (!conflicting.has(objectId)) {
        localeByPost.set(objectId, locale);
      }
    }
  }
  return { localeByPost, conflicting };
}

function parentIdFor(
  recipeId: string,
  metadata: Pick<WprmSourceMetadata, "wprm">,
  issues: Map<string, Set<WprmIssueCode>>
) {
  const raw = metadata.wprm.get(recipeId)?.values.get("wprm_parent_post_id");
  if (raw === undefined || raw.trim().length === 0 || raw.trim() === "0") {
    return null;
  }
  const parentId = numericId(raw.trim());
  if (parentId === null) {
    addIssue(issues, recipeId, "malformed-wprm-meta");
    return null;
  }
  return parentId;
}

function classifyParent(
  recipeId: string,
  parentId: string | null,
  graph: WprmSourceGraph
): ParentRecipeLink["parentKind"] {
  if (parentId === null) {
    return "missing";
  }
  if (parentId === recipeId) {
    return "self";
  }
  const parent = graph.posts.get(parentId);
  if (parent === undefined) {
    return "dangling";
  }
  return isEditorial(parent.type) ? "usable" : "noneditorial";
}

function knownRatingTaxonomy(taxonomy: string) {
  const normalized = taxonomy.toLowerCase();
  return normalized === "rating"
    || normalized.includes("rating")
    || normalized === "wprm_recipe_rating"
    || normalized === "recipe_rating";
}

export interface DirectTaxonomy {
  readonly scope: "recipe" | "editorial";
  readonly taxonomy: string;
  readonly sourceId: string;
  readonly sourceTaxonomyId: string;
  readonly name: string;
  readonly slug: string;
}

function collectDirectTaxonomies(
  objectId: string,
  scope: "recipe" | "editorial",
  graph: WprmSourceGraph,
  issues: Map<string, Set<WprmIssueCode>>,
  issueRecipeId: string
) {
  const values: DirectTaxonomy[] = [];
  for (const [taxonomyId, members] of graph.relationships) {
    if (!members.has(objectId)) {
      continue;
    }
    const taxonomy = graph.taxonomies.get(taxonomyId);
    if (taxonomy === undefined) {
      addIssue(issues, issueRecipeId, "invalid-taxonomy-membership");
      continue;
    }
    const normalizedTaxonomy = taxonomy.taxonomy.toLowerCase();
    if (
      normalizedTaxonomy === "language"
      || normalizedTaxonomy === "post_translations"
      || normalizedTaxonomy === "term_language"
      || normalizedTaxonomy === "term_translations"
      || knownRatingTaxonomy(normalizedTaxonomy)
    ) {
      if (knownRatingTaxonomy(normalizedTaxonomy)) {
        addIssue(issues, issueRecipeId, "excluded-rating-data");
      }
      continue;
    }
    const term = graph.terms.get(taxonomy.termId);
    if (
      term === undefined
      || term.name === null
      || term.name.length === 0
      || term.slug === null
      || term.slug.length === 0
    ) {
      addIssue(issues, issueRecipeId, "invalid-taxonomy-membership");
      continue;
    }
    values.push({
      scope,
      taxonomy: taxonomy.taxonomy,
      sourceId: taxonomy.termId,
      sourceTaxonomyId: taxonomyId,
      name: term.name,
      slug: term.slug
    });
  }
  return values.sort((left, right) =>
    left.scope.localeCompare(right.scope)
    || left.taxonomy.localeCompare(right.taxonomy)
    || numericSort(left.sourceTaxonomyId, right.sourceTaxonomyId)
  );
}

function safeRedirectPath(value: string | null) {
  if (value === null || value.trim().length === 0) {
    return false;
  }
  try {
    validateSafeLocalPath(value, "redirect source");
    return true;
  } catch {
    return false;
  }
}

function redirectTargetSafe(
  value: string | null,
  limits: WprmImportLimits
) {
  if (value === null || value.trim().length === 0) {
    return false;
  }
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > limits.evidence.maxMetaValueBytes) {
    return false;
  }
  if (/^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed) || /^N;/u.test(trimmed)) {
    try {
      const parsed = parsePhpSerialized(trimmed, {
        maxInputBytes: limits.evidence.maxMetaValueBytes,
        maxDepth: limits.evidence.maxSerializedDepth,
        maxEntries: limits.evidence.maxSerializedEntries,
        maxStringBytes: limits.evidence.maxMetaValueBytes
      });
      const targets = collectTargetStrings(parsed);
      return targets.length === 1 && safeRedirectPath(targets[0] ?? null);
    } catch {
      return false;
    }
  }
  if (/^[\[{]/u.test(trimmed)) {
    const parsed = readJsonValue(trimmed);
    return parsed !== null
      && withinStructuredLimits(parsed, limits.evidence)
      && collectTargetStrings(parsed).length === 1
      && safeRedirectPath(collectTargetStrings(parsed)[0] ?? null);
  }
  return safeRedirectPath(trimmed);
}

function classifyRedirects(
  graph: WprmSourceGraph,
  limits: WprmImportLimits
): RedirectManifest {
  let exactSafe = 0;
  let regex = 0;
  let unsupported = 0;
  let unresolvedTarget = 0;
  for (const redirect of graph.redirects) {
    const matcher = redirect.matchType?.trim().toLowerCase() ?? "";
    const regexFlag = redirect.regex?.trim() ?? "";
    if (
      matcher === "url"
      && (regexFlag.length === 0 || regexFlag === "0")
      && safeRedirectPath(redirect.source)
    ) {
      exactSafe += 1;
    } else if (matcher === "regex" || regexFlag === "1") {
      regex += 1;
    } else {
      unsupported += 1;
    }
    if (!redirectTargetSafe(redirect.actionData, limits)) {
      unresolvedTarget += 1;
    }
  }
  return {
    candidates: graph.redirects.length + graph.oldSlugCount,
    exactSafe,
    regex,
    unsupported,
    unresolvedTarget,
    oldSlugCandidates: graph.oldSlugCount,
    accepted: 0,
    canonicalCandidates: 0,
    promotionEligibleCandidates: 0,
    canonicalAccepted: 0,
    oldSlugAccepted: 0,
    pluginRows: graph.redirects.length,
    pluginAccepted: 0,
    pluginDeduplicated: 0,
    pluginRegex: regex,
    pluginUnsupported: unsupported,
    pluginExternalOrAmbiguous: 0,
    pluginUnresolved: unresolvedTarget,
    pluginConflict: 0,
    pluginCycle: 0,
    plugin: {
      rows: graph.redirects.length,
      accepted: 0,
      deduplicated: 0,
      regex,
      unsupported,
      externalOrAmbiguous: 0,
      unresolved: unresolvedTarget,
      conflict: 0,
      cycle: 0
    },
    uniqueAcceptedSources: 0,
    recipesWithRedirects: 0,
    localeCounts: {
      en: 0,
      fr: 0,
      ru: 0
    },
    issueCodes: []
  };
}

export function deriveWprmRelations(
  graph: WprmSourceGraph,
  metadata: Pick<WprmSourceMetadata, "wprm" | "wpurSignals">,
  limits: WprmImportLimits
): WprmRelations {
  const { localeByPost, conflicting } = localeTerms(graph);
  const issues = new Map<string, Set<WprmIssueCode>>();
  const parentLinks = new Map<string, ParentRecipeLink>();
  const locales = new Map<string, Locale | null>();
  const translationGroups = new Map<string, string | null>();
  const recipesInParentTranslationGroups = new Set<string>();
  const recipeTaxonomies = new Map<string, DirectTaxonomy[]>();
  const editorialTaxonomies = new Map<string, DirectTaxonomy[]>();
  const parentRecipes = new Map<string, string[]>();
  let usableParentRecipes = 0;
  let missingParentRecipes = 0;

  const recipes = [...graph.posts.values()]
    .filter((post) => post.type.toLowerCase() === "wprm_recipe")
    .sort((left, right) => numericSort(left.id, right.id));
  for (const recipe of recipes) {
    const parentId = parentIdFor(recipe.id, metadata, issues);
    const kind = classifyParent(recipe.id, parentId, graph);
    const parentLocale = kind === "usable" && parentId !== null
      ? localeByPost.get(parentId) ?? null
      : null;
    const recipeLocale = localeByPost.get(recipe.id) ?? null;
    const locale = kind === "usable" ? parentLocale : recipeLocale;
    locales.set(recipe.id, locale);
    translationGroups.set(recipe.id, null);
    parentLinks.set(recipe.id, {
      recipeId: recipe.id,
      parentId,
      parentKind: kind,
      parentLocale,
      recipeLocale
    });
    if (kind === "usable" && parentId !== null) {
      usableParentRecipes += 1;
      const members = parentRecipes.get(parentId) ?? [];
      members.push(recipe.id);
      parentRecipes.set(parentId, members);
    } else {
      missingParentRecipes += kind === "missing" ? 1 : 0;
      const code = kind === "missing"
        ? "missing-editorial-parent"
        : kind === "self"
          ? "self-editorial-parent"
          : kind === "dangling"
            ? "dangling-editorial-parent"
            : "noneditorial-parent";
      addIssue(issues, recipe.id, code);
    }
    if (conflicting.has(recipe.id)) {
      addIssue(issues, recipe.id, "missing-recipe-locale");
      locales.set(recipe.id, null);
    }
    if (locale === null) {
      addIssue(issues, recipe.id, "missing-recipe-locale");
    }
  }

  let provenParentGroups = 0;
  let incompleteParentGroups = 0;
  let directWprmGroups = 0;
  const groups = [...graph.taxonomies.entries()]
    .filter(([, taxonomy]) => taxonomy.taxonomy.toLowerCase() === "post_translations")
    .sort(([left], [right]) => numericSort(left, right));

  const postTranslationGroups: PostTranslationGroup[] = groups.map(([taxonomyId]) => {
    const members = [...(graph.relationships.get(taxonomyId) ?? [])].sort(numericSort);
    const editorialMembers = members.filter((member) =>
      isEditorial(graph.posts.get(member)?.type ?? "")
    );
    const directWprm = members.filter((member) =>
      graph.posts.get(member)?.type.toLowerCase() === "wprm_recipe"
    );
    const directWpur = members.filter((member) =>
      graph.posts.get(member)?.type.toLowerCase() === "recipe"
      &&
      metadata.wpurSignals.get(member)?.has("recipe_ingredients") === true
      && metadata.wpurSignals.get(member)?.has("recipe_instructions") === true
    );
    const relatedRecipes = [...new Set(
      editorialMembers.flatMap((member) => parentRecipes.get(member) ?? [])
    )].sort(numericSort);
    return {
      taxonomyId,
      members,
      editorialMembers,
      directWprm,
      directWpur,
      relatedRecipes
    };
  });
  const ambiguousGroupIds = new Set<string>();
  for (const component of overlappingPostTranslationGroups(postTranslationGroups)) {
    const firstMembers = component[0]?.members;
    // Exact duplicate memberships retain the existing duplicate semantics.
    if (
      firstMembers === undefined
      || component.every((group) => sameGroupMembers(firstMembers, group.members))
    ) {
      continue;
    }
    for (const group of component) {
      ambiguousGroupIds.add(group.taxonomyId);
    }
  }

  for (const group of postTranslationGroups) {
    const {
      taxonomyId,
      members,
      editorialMembers,
      directWprm,
      directWpur,
      relatedRecipes
    } = group;
    const recipeCounts = editorialMembers.map((member) => parentRecipes.get(member)?.length ?? 0);
    const hasMissing = recipeCounts.some((count) => count === 0);
    const hasMultiple = recipeCounts.some((count) => count > 1);
    const ambiguous = ambiguousGroupIds.has(taxonomyId);

    if (ambiguous) {
      for (const recipeId of [...new Set([...directWprm, ...relatedRecipes])]) {
        addIssue(issues, recipeId, "ambiguous-parent-translation-group");
      }
      for (const recipeId of relatedRecipes) {
        recipesInParentTranslationGroups.add(recipeId);
      }
    }
    if (directWprm.length > 0 || directWpur.length > 0) {
      if (directWprm.length > 0) {
        directWprmGroups += 1;
      }
      for (const recipeId of [...new Set([...directWprm, ...relatedRecipes])]) {
        addIssue(issues, recipeId, "ambiguous-parent-translation-group");
      }
      continue;
    }
    if (relatedRecipes.length === 0) {
      continue;
    }
    for (const recipeId of relatedRecipes) {
      recipesInParentTranslationGroups.add(recipeId);
    }
    const invalidLocale = members.some((member) =>
      !localeByPost.has(member) || conflicting.has(member)
    );
    const groupLocales = members.map((member) => localeByPost.get(member));
    const duplicateLocale = new Set(groupLocales).size !== groupLocales.length;
    const containsNoneditorialMember = editorialMembers.length !== members.length;
    if (invalidLocale || duplicateLocale || containsNoneditorialMember) {
      for (const recipeId of relatedRecipes) {
        if (invalidLocale) {
          addIssue(issues, recipeId, "invalid-parent-group-locale");
        }
        if (duplicateLocale) {
          addIssue(issues, recipeId, "duplicate-parent-group-locale");
        }
        if (containsNoneditorialMember) {
          addIssue(issues, recipeId, "ambiguous-parent-translation-group");
        }
      }
      continue;
    }
    if (hasMissing || hasMultiple) {
      incompleteParentGroups += 1;
      for (const recipeId of relatedRecipes) {
        addIssue(
          issues,
          recipeId,
          hasMultiple ? "multiple-recipes-for-editorial-member" : "incomplete-parent-translation"
        );
      }
      continue;
    }
    if (ambiguous) {
      continue;
    }
    provenParentGroups += 1;
    const groupId = `wordpress:post-translations:${taxonomyId}`;
    for (const recipeId of relatedRecipes) {
      translationGroups.set(recipeId, groupId);
    }
  }

  for (const recipe of recipes) {
    const link = parentLinks.get(recipe.id);
    if (link === undefined) {
      continue;
    }
    recipeTaxonomies.set(
      recipe.id,
      collectDirectTaxonomies(recipe.id, "recipe", graph, issues, recipe.id)
    );
    if (link.parentKind === "usable" && link.parentId !== null) {
      editorialTaxonomies.set(
        recipe.id,
        collectDirectTaxonomies(link.parentId, "editorial", graph, issues, recipe.id)
      );
    } else {
      editorialTaxonomies.set(recipe.id, []);
    }
    const wprm = metadata.wprm.get(recipe.id);
    if ((wprm?.unsupportedKeys.size ?? 0) > 0) {
      addIssue(issues, recipe.id, "unsupported-wprm-field");
    }
    if ((wprm?.duplicateKeys.size ?? 0) > 0) {
      addIssue(issues, recipe.id, "duplicate-singular-meta");
    }
    if ((wprm?.excludedRatingData ?? 0) > 0) {
      addIssue(issues, recipe.id, "excluded-rating-data");
    }
    if ((wprm?.excludedOperationalData ?? 0) > 0) {
      addIssue(issues, recipe.id, "excluded-operational-data");
    }
    if ((wprm?.excludedAuthorData ?? 0) > 0) {
      addIssue(issues, recipe.id, "excluded-author-data");
    }
    if ((wprm?.excludedSocialMediaData ?? 0) > 0) {
      addIssue(issues, recipe.id, "excluded-social-media-data");
    }
    if ((wprm?.excludedVideoData ?? 0) > 0) {
      addIssue(issues, recipe.id, "excluded-video-data");
    }
    switch (wprm?.wprmType.classification) {
      case "food":
        addIssue(issues, recipe.id, "excluded-wprm-type");
        break;
      case "howto":
      case "other":
      case "unknown":
        addIssue(issues, recipe.id, "unsupported-wprm-type");
        break;
      case "malformed":
        addIssue(issues, recipe.id, "malformed-wprm-type");
        break;
      default:
        if ((wprm?.excludedWprmType ?? 0) > 0) {
          addIssue(issues, recipe.id, "malformed-wprm-type");
        }
        break;
    }
  }

  return {
    locales,
    parentLinks,
    translationGroups,
    issues,
    recipeTaxonomies,
    editorialTaxonomies,
    provenParentGroups,
    incompleteParentGroups,
    directWprmGroups,
    usableParentRecipes,
    usableParentRecipesOutsideGroups:
      usableParentRecipes - recipesInParentTranslationGroups.size,
    missingParentRecipes,
    redirects: classifyRedirects(graph, limits),
    localeByPost
  };
}

export function relationIssues(
  relations: WprmRelations,
  recipeId: string
): readonly WprmIssueCode[] {
  return [...(relations.issues.get(recipeId) ?? [])].sort((left, right) =>
    left.localeCompare(right)
  );
}

export function relationOutcomeCodes(
  relations: WprmRelations,
  outcomes: readonly CandidateOutcome[]
) {
  return outcomes.map((outcome) => ({
    ...outcome,
    codes: relationIssues(relations, outcome.recipeId)
  }));
}

export function supportedLocale(value: string | null): value is Locale {
  return value !== null && (localeValues as readonly string[]).includes(value);
}

export const deriveParentRelations = deriveWprmRelations;
export const derivePolylangRelations = deriveWprmRelations;
