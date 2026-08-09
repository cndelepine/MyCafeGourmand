import {
  type BwgStoragePathKind,
  type CountLabel,
  type Locale,
  type MemberCount,
  type RecipeEditorialAlignmentEvidence,
  type StructuralShapeEvidenceDelta,
  type ActionCountLabel
} from "./source-evidence-contracts";
import {
  sortedCountLabels,
  sortedNumericCounts,
  type GraphState,
  type PostTableState,
  type RedirectGraph,
  type GalleryGraph
} from "./source-evidence-scan";
import {
  finalizeShape,
  mergeShape,
  shapeAccumulator,
  type MetadataState
} from "./source-evidence-metadata";
import type { UploadArchiveInventory } from "./uploads-inventory";

export function mergeShapeMap(
    values: ReadonlyMap<string, StructuralShapeEvidenceDelta>,
    ids: ReadonlySet<string>
  ) {
    const result = shapeAccumulator();
    for (const id of ids) {
      const delta = values.get(id);
      if (delta) {
        mergeShape(result, delta);
      }
    }
    return finalizeShape(result);
  }

  export function wprmPostIds(table: PostTableState) {
    return new Set(
      [...table.records.entries()]
        .filter(([, record]) => record.kind === "wprm")
        .map(([id]) => id)
    );
  }

  export function wpurCandidateIds(table: PostTableState, metadata: MetadataState) {
    return new Set(
      [...table.records.entries()]
        .filter(([id, record]) =>
          record.kind === "recipe"
          && metadata.wpurKeys.get(id)?.has("recipe_ingredients") === true
          && metadata.wpurKeys.get(id)?.has("recipe_instructions") === true
        )
        .map(([id]) => id)
    );
  }

  export function parentLinkEvidence(
    table: PostTableState,
    ids: ReadonlySet<string>,
    parents: ReadonlyMap<string, string | null>
  ) {
    let missing = 0;
    let valid = 0;
    let self = 0;
    let dangling = 0;
    for (const id of ids) {
      const parent = parents.get(id);
      if (parent === undefined || parent === null) {
        missing += 1;
      } else if (parent === id) {
        self += 1;
      } else if (!table.records.has(parent)) {
        dangling += 1;
      } else {
        valid += 1;
      }
    }
    return { missing, valid, self, dangling };
  }

  export function editorialReferenceEvidence(
    table: PostTableState,
    ids: ReadonlySet<string>,
    parents: ReadonlyMap<string, string | null>
  ) {
    let none = 0;
    let one = 0;
    let many = 0;
    let agreesWithParent = 0;
    let conflictsWithParent = 0;
    for (const id of ids) {
      const parent = parents.get(id);
      const references = parent === null || parent === undefined
        ? new Set<string>()
        : table.records.get(parent)?.references ?? new Set<string>();
      if (references.size === 0) {
        none += 1;
      } else if (references.size === 1) {
        one += 1;
      } else {
        many += 1;
      }
      if (parent !== undefined && parent !== null && references.has(id)) {
        agreesWithParent += 1;
      } else if (parent !== undefined && parent !== null && references.size > 0) {
        conflictsWithParent += 1;
      }
    }
    return {
      none,
      one,
      many,
      agreesWithParent,
      conflictsWithParent
    };
  }

  function memberCardinality(
    groups: ReadonlyMap<string, ReadonlySet<string>>
  ): MemberCount[] {
    const counts = new Map<number, number>();
    for (const members of groups.values()) {
      counts.set(members.size, (counts.get(members.size) ?? 0) + 1);
    }
    return sortedNumericCounts(counts);
  }

  function postLocaleEvidence(
    groups: ReadonlyMap<string, ReadonlySet<string>>,
    localeByPost: ReadonlyMap<string, Locale>
  ) {
    const counts = new Map<string, number>();
    for (const members of groups.values()) {
      const tuple = {
        en: 0,
        fr: 0,
        ru: 0
      };
      for (const member of members) {
        const locale = localeByPost.get(member);
        if (locale) {
          tuple[locale] += 1;
        }
      }
      const key = `${tuple.en}:${tuple.fr}:${tuple.ru}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => {
        const [en, fr, ru] = key.split(":").map(Number);
        return {
          en: en ?? 0,
          fr: fr ?? 0,
          ru: ru ?? 0,
          count
        };
      })
      .sort((left, right) =>
        left.en - right.en || left.fr - right.fr || left.ru - right.ru
      );
  }

  function buildRecipeEditorialAlignment(
    postGroups: ReadonlyMap<string, ReadonlySet<string>>,
    localeByPost: ReadonlyMap<string, Locale>,
    conflictingPostLocales: ReadonlySet<string>,
    postTable: PostTableState,
    wprmIds: ReadonlySet<string>,
    wpurIds: ReadonlySet<string>,
    parents: ReadonlyMap<string, string | null>
  ): RecipeEditorialAlignmentEvidence {
    const recipesByParent = new Map<string, Set<string>>();
    let usable = 0;
    let missingParent = 0;
    let selfParent = 0;
    let danglingParent = 0;
    let nonEditorialParent = 0;

    for (const recipeId of wprmIds) {
      const parent = parents.get(recipeId);
      if (parent === undefined || parent === null) {
        missingParent += 1;
        continue;
      }
      if (parent === recipeId) {
        selfParent += 1;
        continue;
      }
      const parentRecord = postTable.records.get(parent);
      if (parentRecord === undefined) {
        danglingParent += 1;
        continue;
      }
      if (parentRecord.kind !== "post" && parentRecord.kind !== "page") {
        nonEditorialParent += 1;
        continue;
      }
      usable += 1;
      const recipes = recipesByParent.get(parent) ?? new Set<string>();
      recipes.add(recipeId);
      recipesByParent.set(parent, recipes);
    }

    const groupsByPost = new Map<string, Set<string>>();
    for (const [groupId, members] of postGroups) {
      for (const member of members) {
        const groups = groupsByPost.get(member) ?? new Set<string>();
        groups.add(groupId);
        groupsByPost.set(member, groups);
      }
    }
    let ungroupedParentRecipes = 0;
    for (const parentRecipes of recipesByParent.values()) {
      for (const recipeId of parentRecipes) {
        const parent = parents.get(recipeId);
        if (
          parent !== null
          && parent !== undefined
          && (groupsByPost.get(parent)?.size ?? 0) === 0
        ) {
          ungroupedParentRecipes += 1;
        }
      }
    }

    let directWprmGroups = 0;
    let directWpurGroups = 0;
    let directInvalidGroups = 0;
    let groupsConsidered = 0;
    let oneToOne = 0;
    let oneLanguage = 0;
    let twoLanguage = 0;
    let threeLanguage = 0;
    let missingRecipe = 0;
    let multipleRecipes = 0;
    let mixedMissingAndMultiple = 0;
    let invalidLocale = 0;

    for (const members of postGroups.values()) {
      const memberList = [...members];
      if (memberList.some(
        (member) => !localeByPost.has(member) || conflictingPostLocales.has(member)
      )) {
        invalidLocale += 1;
        continue;
      }
      const directWprm = memberList.filter((member) => wprmIds.has(member));
      const directWpur = memberList.filter((member) => wpurIds.has(member));
      const hasRecipe = directWprm.length > 0 || directWpur.length > 0;
      const allWprm = memberList.length > 0 && directWprm.length === memberList.length;
      const allWpur = memberList.length > 0 && directWpur.length === memberList.length;
      if (allWprm) {
        directWprmGroups += 1;
        continue;
      }
      if (allWpur) {
        directWpurGroups += 1;
        continue;
      }
      if (hasRecipe) {
        directInvalidGroups += 1;
        continue;
      }

      const parentMembers = memberList.filter((member) => recipesByParent.has(member));
      if (parentMembers.length === 0) {
        continue;
      }
      groupsConsidered += 1;
      const editorialMembers = memberList.filter((member) => {
        const record = postTable.records.get(member);
        return record?.kind === "post" || record?.kind === "page";
      });
      const recipeCounts = editorialMembers.map(
        (member) => recipesByParent.get(member)?.size ?? 0
      );
      const hasMissing = recipeCounts.some((count) => count === 0);
      const hasMultiple = recipeCounts.some((count) => count > 1);
      if (hasMissing && hasMultiple) {
        mixedMissingAndMultiple += 1;
      } else if (hasMissing) {
        missingRecipe += 1;
      } else if (hasMultiple) {
        multipleRecipes += 1;
      } else {
        oneToOne += 1;
        const languageCount = new Set(
          memberList.map((member) => localeByPost.get(member))
        ).size;
        if (languageCount === 1) {
          oneLanguage += 1;
        } else if (languageCount === 2) {
          twoLanguage += 1;
        } else if (languageCount === 3) {
          threeLanguage += 1;
        }
      }
    }

    return {
      direct: {
        wprmGroups: directWprmGroups,
        wpurGroups: directWpurGroups,
        invalidGroups: directInvalidGroups
      },
      parent: {
        groupsConsidered,
        oneToOne,
        oneLanguage,
        twoLanguage,
        threeLanguage,
        missingRecipe,
        multipleRecipes,
        mixedMissingAndMultiple,
        invalidLocale
      },
      wprmParentEligibility: {
        usable,
        missingParent,
        selfParent,
        danglingParent,
        nonEditorialParent,
        ungroupedParentRecipes
      }
    };
  }

  export function buildPolylangEvidence(
    graph: GraphState,
    postTable: PostTableState,
    wprmIds: ReadonlySet<string>,
    wpurIds: ReadonlySet<string>,
    parents: ReadonlyMap<string, string | null>
  ) {
    const postGroups = new Map<string, Set<string>>();
    const termGroups = new Map<string, Set<string>>();
    const localeByPost = new Map<string, Locale>();
    const conflictingPostLocales = new Set<string>();

    for (const [taxonomyId, taxonomy] of graph.terms.taxonomies) {
      const members = graph.terms.relationships.get(taxonomyId) ?? new Set<string>();
      if (taxonomy.taxonomy === "language") {
        const locale = graph.terms.terms.get(taxonomy.termId)?.locale;
        if (!locale) {
          graph.issues.add("unsupported-language-term", 1, "warning");
          continue;
        }
        for (const member of members) {
          const previous = localeByPost.get(member);
          if (previous && previous !== locale) {
            conflictingPostLocales.add(member);
            graph.issues.add("conflicting-post-locales");
          } else {
            localeByPost.set(member, locale);
          }
        }
      } else if (taxonomy.taxonomy === "term_language") {
        continue;
      } else if (taxonomy.taxonomy === "post_translations") {
        postGroups.set(taxonomyId, new Set(members));
      } else if (taxonomy.taxonomy === "term_translations") {
        termGroups.set(taxonomyId, new Set(members));
      }
    }

    const emptyPostGroups = [...postGroups.values()].filter((group) => group.size === 0).length;
    const emptyTermGroups = [...termGroups.values()].filter((group) => group.size === 0).length;
    if (emptyPostGroups > 0) {
      graph.issues.add("empty-post-translation-group", emptyPostGroups, "warning");
    }
    if (emptyTermGroups > 0) {
      graph.issues.add("empty-term-translation-group", emptyTermGroups, "warning");
    }
    let mixedTaxonomyGroups = 0;
    for (const members of termGroups.values()) {
      const taxonomies = new Set<string>();
      for (const termId of members) {
        for (const taxonomyId of graph.terms.taxonomiesByTerm.get(termId) ?? []) {
          const taxonomy = graph.terms.taxonomies.get(taxonomyId);
          if (
            taxonomy !== undefined
            && taxonomy.taxonomy !== "term_translations"
            && taxonomy.taxonomy !== "term_language"
            && taxonomy.taxonomy !== "language"
          ) {
            taxonomies.add(taxonomy.taxonomy);
          }
        }
      }
      if (taxonomies.size > 1) {
        mixedTaxonomyGroups += 1;
      }
    }

    const recipeEditorialAlignment = buildRecipeEditorialAlignment(
      postGroups,
      localeByPost,
      conflictingPostLocales,
      postTable,
      wprmIds,
      wpurIds,
      parents
    );

    return {
      posts: {
        translationGroups: postGroups.size,
        emptyGroups: emptyPostGroups,
        memberCardinality: memberCardinality(postGroups),
        localeCardinality: postLocaleEvidence(postGroups, localeByPost),
        conflictingLocaleAssignments: conflictingPostLocales.size
      },
      terms: {
        translationGroups: termGroups.size,
        emptyGroups: emptyTermGroups,
        memberCardinality: memberCardinality(termGroups),
        mixedTaxonomyGroups
      },
      recipeEditorialAlignment
    };
  }

  interface RedirectEvidence {
    readonly records: number;
    readonly statusCounts: readonly CountLabel[];
    readonly matcherCounts: readonly CountLabel[];
    readonly actionCounts: readonly ActionCountLabel[];
    readonly sourceSafety: {
      readonly safeExactPath: number;
      readonly unsafeOrUnsupported: number;
    };
    readonly targetEncoding: {
      readonly plain: number;
      readonly "php-serialized": number;
      readonly json: number;
      readonly missing: number;
      readonly malformed: number;
      readonly unsupported: number;
    };
    readonly resolvableLocalTargets: number;
  }

  export function buildRedirectEvidence(
    graph: RedirectGraph
  ): RedirectEvidence {
    const actionCounts = [...graph.actions.entries()]
      .map(([key, count]) => {
        const separator = key.lastIndexOf(":");
        const type = key.slice(0, separator);
        const code = key.slice(separator + 1);
        return {
          type,
          code: /^\d+$/u.test(code) ? Number(code) : code,
          count
        };
      })
      .sort((left, right) =>
        left.type.localeCompare(right.type)
        || (typeof left.code === "number" && typeof right.code === "number"
          ? left.code - right.code
          : String(left.code).localeCompare(String(right.code)))
      );
    return {
      records: graph.records,
      statusCounts: sortedCountLabels(graph.statuses),
      matcherCounts: sortedCountLabels(graph.matchers),
      actionCounts,
      sourceSafety: {
        safeExactPath: graph.safeExactPath,
        unsafeOrUnsupported: graph.unsafeOrUnsupported
      },
      targetEncoding: graph.targetEncoding,
      resolvableLocalTargets: graph.resolvableLocalTargets
    };
  }

  interface MediaEvidence {
    readonly referencedAttachmentIds: number;
    readonly heroReferences: number;
    readonly stepReferences: number;
    readonly attachmentRecords: number;
    readonly attachedFilePresent: number;
    readonly altPresent: number;
    readonly dimensionMetadata: {
      readonly present: number;
      readonly hasWidth: number;
      readonly hasHeight: number;
      readonly malformed: number;
    };
    readonly archiveCoverage: {
      readonly matched: number;
      readonly missing: number;
      readonly duplicate: number;
      readonly unsafe: number;
    };
  }

  export function buildMediaEvidence(
    postTable: PostTableState,
    metadata: MetadataState,
    archive: UploadArchiveInventory
  ): MediaEvidence {
    let matched = 0;
    let missing = 0;
    let duplicate = 0;
    let unsafe = 0;
    for (const value of metadata.attachedFiles.values()) {
      if (value === null) {
        unsafe += 1;
      } else if (!archive.uploadPathCounts.has(value)) {
        missing += 1;
      } else {
        matched += 1;
        if ((archive.uploadPathCounts.get(value) ?? 0) > 1) {
          duplicate += 1;
        }
      }
    }
    return {
      referencedAttachmentIds: new Set([
        ...metadata.heroReferences,
        ...metadata.stepReferences
      ]).size,
      heroReferences: metadata.heroReferenceCount,
      stepReferences: metadata.stepReferenceCount,
      attachmentRecords: [...postTable.records.values()]
        .filter((record) => record.kind === "attachment")
        .length,
      attachedFilePresent: [...metadata.attachedFiles.values()]
        .filter((value) => value !== null).length,
      altPresent: metadata.altPresent.size,
      dimensionMetadata: {
        present: metadata.dimensionRows.size,
        hasWidth: metadata.dimensionWidth,
        hasHeight: metadata.dimensionHeight,
        malformed: metadata.dimensionMalformed
      },
      archiveCoverage: {
        matched,
        missing,
        duplicate,
        unsafe
      }
    };
  }

  export function buildGalleryEvidence(
    graph: GalleryGraph,
    archive: UploadArchiveInventory
  ) {
    let validImageRelations = 0;
    let missingImageRelations = 0;
    for (const relation of graph.imageRelations) {
      if (relation.galleryId !== null && graph.galleries.has(relation.galleryId)) {
        validImageRelations += 1;
      } else {
        missingImageRelations += 1;
      }
    }
    let toGallery = 0;
    let toAlbum = 0;
    let missingTarget = 0;
    let malformed = 0;
    for (const relation of graph.albumRelations) {
      if (
        relation.albumId === null
        || relation.targetId === null
        || relation.isAlbum === null
      ) {
        malformed += 1;
      } else if (relation.isAlbum === "0") {
        if (graph.galleries.has(relation.targetId)) {
          toGallery += 1;
        } else {
          missingTarget += 1;
        }
      } else if (graph.albums.has(relation.targetId)) {
        toAlbum += 1;
      } else {
        missingTarget += 1;
      }
    }
    const storageForms: Record<BwgStoragePathKind, number> = {
      "relative-to-bwg-root": 0,
      "single-leading-bwg-relative": 0,
      "already-archive-relative": 0,
      "wordpress-root-relative": 0,
      absolute: 0,
      empty: 0,
      external: 0,
      unsafe: 0,
      unsupported: 0
    };
    let currentImageMatched = 0;
    let currentImageMissing = 0;
    let currentThumbMatched = 0;
    let currentThumbMissing = 0;
    let bwgImageMatched = 0;
    let bwgImageMissing = 0;
    let bwgThumbMatched = 0;
    let bwgThumbMissing = 0;
    let thumbValuesPresent = 0;
    for (const paths of graph.imagePaths) {
      storageForms[paths.imagePath.kind] += 1;
      storageForms[paths.thumbPath.kind] += 1;
      if (paths.thumbPath.kind !== "empty") {
        thumbValuesPresent += 1;
      }
      const currentImageUsable =
        paths.imagePath.kind !== "external"
        && paths.imagePath.kind !== "unsafe"
        && paths.imagePath.kind !== "unsupported"
        && paths.imagePath.kind !== "empty";
      if (
        currentImageUsable
        && paths.genericImagePath !== null
        && archive.uploadPathCounts.has(paths.genericImagePath)
      ) {
        currentImageMatched += 1;
      } else {
        currentImageMissing += 1;
      }
      const currentThumbUsable =
        paths.thumbPath.kind !== "external"
        && paths.thumbPath.kind !== "unsafe"
        && paths.thumbPath.kind !== "unsupported"
        && paths.thumbPath.kind !== "empty";
      if (
        currentThumbUsable
        && paths.genericThumbPath !== null
        && archive.uploadPathCounts.has(paths.genericThumbPath)
      ) {
        currentThumbMatched += 1;
      } else {
        currentThumbMissing += 1;
      }
      if (
        paths.imagePath.archivePath !== null
        && archive.uploadPathCounts.has(paths.imagePath.archivePath)
      ) {
        bwgImageMatched += 1;
      } else {
        bwgImageMissing += 1;
      }
      if (
        paths.thumbPath.archivePath !== null
        && archive.uploadPathCounts.has(paths.thumbPath.archivePath)
      ) {
        bwgThumbMatched += 1;
      } else {
        bwgThumbMissing += 1;
      }
    }
    return {
      galleries: graph.galleries.size,
      images: graph.images.size,
      albums: graph.albums.size,
      shortcodes: graph.shortcodes,
      imageRelations: {
        valid: validImageRelations,
        missingGallery: missingImageRelations
      },
      albumRelations: {
        toGallery,
        toAlbum,
        missingTarget,
        malformed
      },
      imagePathCoverage: {
        storageForms,
        currentGeneric: {
          imageMatched: currentImageMatched,
          imageMissing: currentImageMissing,
          thumbMatched: currentThumbMatched,
          thumbMissing: currentThumbMissing
        },
        bwgRootNormalized: {
          imageMatched: bwgImageMatched,
          imageMissing: bwgImageMissing,
          thumbMatched: bwgThumbMatched,
          thumbMissing: bwgThumbMissing
        },
        thumbValuesPresent
      }
    };
  }
