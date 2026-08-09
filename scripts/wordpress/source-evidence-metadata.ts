import {
  inspectStructuredValue,
  type SafeKeySetCount,
  type ShapeContract,
  type StructuralShapeEvidence,
  type StructuralShapeEvidenceDelta
} from "./source-evidence-shape";
import {
  parseStructuredValue,
  keySignature
} from "./source-evidence-structured";
import {
  ReferenceBudget,
  issueCounter,
  type GraphState,
  type PostTableState,
  normalizedArchivePath,
  numericId,
  rowValue,
  tableHasColumns
} from "./source-evidence-scan";
import {
  SourceEvidenceError,
  type IdSet,
  type SourceEvidenceLimits
} from "./source-evidence-contracts";
import type { PhpValue } from "./php-serialize";
import type { SqlInsert, SqlValue } from "./sql-stream";
import type { IssueCounter } from "./source-evidence-scan";

function createShapeEvidence(): StructuralShapeEvidenceDelta {
  return {
    encoding: {
      absent: 0,
      empty: 0,
      plain: 0,
      "php-serialized": 0,
      json: 0,
      "malformed-php": 0,
      "malformed-json": 0,
      "unsupported-serialized-type": 0,
      "limit-exceeded": 0
    },
    rootKinds: {
      array: 0,
      object: 0,
      scalar: 0,
      none: 0
    },
    groupKeySets: [],
    itemKeySets: [],
    malformed: 0
  };
}

export function mergeShape(
  target: ShapeAccumulator,
  delta: StructuralShapeEvidenceDelta
) {
  for (const key of Object.keys(target.encoding) as Array<
    keyof StructuralShapeEvidence["encoding"]
  >) {
    target.encoding[key] += delta.encoding[key];
  }
  for (const key of Object.keys(target.rootKinds) as Array<
    keyof StructuralShapeEvidence["rootKinds"]
  >) {
    target.rootKinds[key] += delta.rootKinds[key];
  }
  mergeKeySets(target.groupKeySets, delta.groupKeySets);
  mergeKeySets(target.itemKeySets, delta.itemKeySets);
  target.malformed += delta.malformed;
}

function mergeKeySets(
  target: Map<string, number>,
  values: readonly SafeKeySetCount[]
) {
  for (const value of values) {
    const key = JSON.stringify(value.keys);
    target.set(key, (target.get(key) ?? 0) + value.count);
  }
}

export interface ShapeAccumulator {
  readonly encoding: StructuralShapeEvidence["encoding"];
  readonly rootKinds: StructuralShapeEvidence["rootKinds"];
  readonly groupKeySets: Map<string, number>;
  readonly itemKeySets: Map<string, number>;
  malformed: number;
}

export function shapeAccumulator(): ShapeAccumulator {
  const empty = createShapeEvidence();
  return {
    encoding: empty.encoding,
    rootKinds: empty.rootKinds,
    groupKeySets: new Map(),
    itemKeySets: new Map(),
    malformed: 0
  };
}

export function finalizeShape(value: ShapeAccumulator): StructuralShapeEvidence {
  const keySets = (source: Map<string, number>) =>
    [...source.entries()]
      .map(([keys, count]) => ({
        keys: keySignature(keys),
        count
      }))
      .sort((left, right) =>
        JSON.stringify(left.keys).localeCompare(JSON.stringify(right.keys))
      );
  return {
    encoding: value.encoding,
    rootKinds: value.rootKinds,
    groupKeySets: keySets(value.groupKeySets),
    itemKeySets: keySets(value.itemKeySets),
    malformed: value.malformed
  };
}


const wprmIngredientContract: ShapeContract = {
  root: "array",
  allowedGroupKeys: ["ingredients", "name", "uid"],
  allowedItemKeys: [
    "uid",
    "amount",
    "unit",
    "name",
    "notes",
    "raw",
    "splits",
    "converted",
    "link",
    "id",
    "unit_id",
    "product_amount",
    "product_amount_default",
    "product_item_snapshot",
    "conversion_item_snapshot"
  ]
};

const wprmInstructionContract: ShapeContract = {
  root: "array",
  allowedGroupKeys: ["instructions", "name", "uid"],
  allowedItemKeys: [
    "uid",
    "name",
    "text",
    "type",
    "image",
    "ingredients",
    "video",
    "tip_icon",
    "tip_style",
    "tip_accent",
    "tip_text_color"
  ]
};

const wpurIngredientContract: ShapeContract = {
  root: "array",
  allowedGroupKeys: [],
  allowedItemKeys: [
    "amount",
    "unit",
    "ingredient",
    "notes",
    "group",
    "ingredient_id",
    "amount_normalized"
  ]
};

const wpurInstructionContract: ShapeContract = {
  root: "array",
  allowedGroupKeys: [],
  allowedItemKeys: ["description", "image", "group"]
};

const wpurKeys = new Set([
  "recipe_title",
  "recipe_alternate_image",
  "recipe_description",
  "recipe_servings",
  "recipe_servings_type",
  "recipe_prep_time",
  "recipe_prep_time_text",
  "recipe_cook_time",
  "recipe_cook_time_text",
  "recipe_passive_time",
  "recipe_passive_time_text",
  "recipe_ingredients",
  "recipe_instructions",
  "recipe_notes",
  "recipe_video_id",
  "recipe_video_embed",
  "recipe_video_thumb"
]);

function numericReference(value: PhpValue): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    return numericId(value);
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return numericReference(value.id ?? value.attachment_id);
  }
  return null;
}

function collectInstructionImageReferences(
  value: PhpValue,
  limits: SourceEvidenceLimits
) {
  const references: string[] = [];
  const pending: Array<{ value: PhpValue; depth: number }> = [
    { value, depth: 1 }
  ];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const { value: currentValue, depth } = current;
    if (depth > limits.maxSerializedDepth) {
      throw new SourceEvidenceError("serialized-limit");
    }
    if (currentValue === null || typeof currentValue !== "object") {
      continue;
    }
    const children = Array.isArray(currentValue)
      ? currentValue.map((entry) => ["", entry] as const)
      : Object.entries(currentValue);
    entries += children.length;
    if (entries > limits.maxSerializedEntries) {
      throw new SourceEvidenceError("serialized-limit");
    }
    for (const [key, nested] of children) {
      if ((key === "image" || key === "image_id")) {
        const id = numericReference(nested);
        if (id) {
          references.push(id);
        }
      }
      if (nested !== null && typeof nested === "object") {
        pending.push({ value: nested, depth: depth + 1 });
      }
    }
  }
  return references;
}

export interface MetadataState {
  readonly wprmIngredients: Map<string, StructuralShapeEvidenceDelta>;
  readonly wprmInstructions: Map<string, StructuralShapeEvidenceDelta>;
  readonly wpurIngredients: Map<string, StructuralShapeEvidenceDelta>;
  readonly wpurInstructions: Map<string, StructuralShapeEvidenceDelta>;
  readonly wpurKeys: Map<string, Set<string>>;
  readonly wpurSignalPosts: IdSet;
  readonly wprmParents: Map<string, string | null>;
  readonly heroReferences: IdSet;
  readonly stepReferences: IdSet;
  heroReferenceCount: number;
  stepReferenceCount: number;
  readonly attachedFiles: Map<string, string | null>;
  readonly altPresent: IdSet;
  readonly dimensionRows: Set<string>;
  dimensionWidth: number;
  dimensionHeight: number;
  dimensionMalformed: number;
  readonly issues: IssueCounter;
  readonly referenceBudget: ReferenceBudget;
  postMetaRows: number;
}

export function createMetadataState(limits: SourceEvidenceLimits): MetadataState {
  return {
    wprmIngredients: new Map(),
    wprmInstructions: new Map(),
    wpurIngredients: new Map(),
    wpurInstructions: new Map(),
    wpurKeys: new Map(),
    wpurSignalPosts: new Set(),
    wprmParents: new Map(),
    heroReferences: new Set(),
    stepReferences: new Set(),
    heroReferenceCount: 0,
    stepReferenceCount: 0,
    attachedFiles: new Map(),
    altPresent: new Set(),
    dimensionRows: new Set(),
    dimensionWidth: 0,
    dimensionHeight: 0,
    dimensionMalformed: 0,
    issues: issueCounter(),
    referenceBudget: new ReferenceBudget(limits.maxEvidenceReferences),
    postMetaRows: 0
  };
}

function addShapeDelta(
  target: Map<string, StructuralShapeEvidenceDelta>,
  postId: string,
  delta: StructuralShapeEvidenceDelta
) {
  const previous = target.get(postId);
  if (!previous) {
    target.set(postId, delta);
    return;
  }
  const accumulator = shapeAccumulator();
  mergeShape(accumulator, previous);
  mergeShape(accumulator, delta);
  target.set(postId, finalizeShape(accumulator));
}

function recordStructuredIssue(
  state: MetadataState,
  key: string,
  delta: StructuralShapeEvidenceDelta,
  family: "wprm" | "wpur",
  rawValue: string | null,
  limits: SourceEvidenceLimits
) {
  if (
    rawValue !== null
    && Buffer.byteLength(rawValue, "utf8") > limits.maxMetaValueBytes
  ) {
    throw new SourceEvidenceError("meta-value-limit");
  }
  const malformed = delta.malformed
    + delta.encoding["malformed-php"]
    + delta.encoding["malformed-json"];
  if (malformed > 0) {
    state.issues.add(`malformed-${family}-${key}`);
  }
  const unknown = [...delta.groupKeySets, ...delta.itemKeySets]
    .filter((set) => set.keys.includes("unknown"))
    .reduce((count, set) => count + set.count, 0);
  if (unknown > 0) {
    state.issues.add("unknown-structured-key", unknown);
  }
  if (delta.encoding["limit-exceeded"] > 0) {
    throw new SourceEvidenceError(
      delta.malformed > 0 ? "shape-keyset-limit" : "serialized-limit"
    );
  }
}

function recordHeroReference(
  state: MetadataState,
  value: SqlValue | undefined,
  candidate: boolean
) {
  if (!candidate) {
    return;
  }
  const id = numericReference(value === null || value === undefined ? null : value);
  if (id) {
    state.heroReferenceCount += 1;
    state.heroReferences.add(id);
    state.referenceBudget.add();
  }
}

function recordStepReferences(
  state: MetadataState,
  value: string | null | undefined,
  limits: SourceEvidenceLimits,
  candidate: boolean,
  family: "wprm" | "wpur"
) {
  if (!candidate) {
    return;
  }
  const parsed = parseStructuredValue(value, limits);
  if (!parsed) {
    return;
  }
  const references = collectInstructionImageReferences(parsed.value, limits);
  for (const id of references) {
    state.stepReferenceCount += 1;
    state.stepReferences.add(id);
    state.referenceBudget.add();
  }
  if (parsed.encoding === "php" || parsed.encoding === "json") {
    return;
  }
  state.issues.add(`malformed-${family}-instructions`);
}

function inspectDimensions(
  state: MetadataState,
  postId: string,
  value: string | null | undefined,
  limits: SourceEvidenceLimits
) {
  if (value === null || value === undefined || value.trim().length === 0) {
    return;
  }
  if (Buffer.byteLength(value, "utf8") > limits.maxMetaValueBytes) {
    throw new SourceEvidenceError("meta-value-limit");
  }
  state.dimensionRows.add(postId);
  const parsed = parseStructuredValue(value, limits);
  if (!parsed || parsed.value === null || typeof parsed.value !== "object") {
    state.dimensionMalformed += 1;
    state.issues.add("attachment-metadata-malformed");
    return;
  }
  const root = parsed.value;
  const width = Array.isArray(root) ? undefined : root.width;
  const height = Array.isArray(root) ? undefined : root.height;
  if (typeof width === "number" || (typeof width === "string" && /^\d+$/u.test(width))) {
    state.dimensionWidth += 1;
  }
  if (
    typeof height === "number"
    || (typeof height === "string" && /^\d+$/u.test(height))
  ) {
    state.dimensionHeight += 1;
  }
}

function processMetadataInsert(
  state: MetadataState,
  postTable: PostTableState,
  insert: SqlInsert,
  limits: SourceEvidenceLimits
) {
  state.postMetaRows += 1;
  if (state.postMetaRows > limits.maxPostMetaRows) {
    throw new SourceEvidenceError("postmeta-row-limit");
  }
  const postId = numericId(rowValue(insert.row, "post_id"));
  const keyValue = rowValue(insert.row, "meta_key");
  if (!postId || keyValue === null || keyValue === undefined) {
    throw new SourceEvidenceError("malformed-postmeta");
  }
  const key = keyValue.toLowerCase();
  const value = rowValue(insert.row, "meta_value");
  const post = postTable.records.get(postId);
  const isWprm = post?.kind === "wprm";
  const isRecipePost = post?.kind === "recipe";

  if (key === "wprm_ingredients" && isWprm) {
    const text = value ?? null;
    const delta = inspectStructuredValue(text, wprmIngredientContract, limits);
    addShapeDelta(state.wprmIngredients, postId, delta);
    recordStructuredIssue(state, "ingredients", delta, "wprm", text, limits);
  } else if (key === "wprm_instructions" && isWprm) {
    const text = value ?? null;
    const delta = inspectStructuredValue(text, wprmInstructionContract, limits);
    addShapeDelta(state.wprmInstructions, postId, delta);
    recordStructuredIssue(state, "instructions", delta, "wprm", text, limits);
    recordStepReferences(state, text, limits, true, "wprm");
  } else if (key === "wprm_parent_post_id" && isWprm) {
    const parentId = numericId(value);
    if (value !== null && value !== undefined && parentId === null) {
      state.issues.add("malformed-wprm-parent-link");
    }
    state.wprmParents.set(postId, parentId);
  } else if (key === "_thumbnail_id") {
    recordHeroReference(state, value, isWprm || isRecipePost);
  }

  if (wpurKeys.has(key)) {
    const keys = state.wpurKeys.get(postId) ?? new Set<string>();
    keys.add(key);
    state.wpurKeys.set(postId, keys);
    if (key === "recipe_ingredients" && isRecipePost) {
      const text = value ?? null;
      const delta = inspectStructuredValue(text, wpurIngredientContract, limits);
      addShapeDelta(state.wpurIngredients, postId, delta);
      recordStructuredIssue(state, "ingredients", delta, "wpur", text, limits);
    } else if (key === "recipe_instructions" && isRecipePost) {
      const text = value ?? null;
      const delta = inspectStructuredValue(text, wpurInstructionContract, limits);
      addShapeDelta(state.wpurInstructions, postId, delta);
      recordStructuredIssue(state, "instructions", delta, "wpur", text, limits);
      recordStepReferences(state, text, limits, true, "wpur");
    } else if (key === "recipe_alternate_image" && isRecipePost) {
      recordHeroReference(state, value, true);
      if (
        value !== null
        && value !== undefined
        && numericReference(value) === null
      ) {
        if (Buffer.byteLength(value, "utf8") > limits.maxMetaValueBytes) {
          throw new SourceEvidenceError("meta-value-limit");
        }
        const parsed = parseStructuredValue(value, limits);
        if (parsed) {
          const id = numericReference(parsed.value);
          if (id) {
            state.heroReferenceCount += 1;
            state.heroReferences.add(id);
            state.referenceBudget.add();
          }
        }
      }
    }
  }

  if (
    key.startsWith("wpurp_")
    || key.startsWith("ultimate_recipe")
    || key.startsWith("urp_")
  ) {
    state.wpurSignalPosts.add(postId);
  }

  if (key === "_wp_attached_file" && post?.kind === "attachment") {
    if (value === null || value === undefined || value.trim().length === 0) {
      state.issues.add("attachment-file-malformed");
      state.attachedFiles.set(postId, null);
    } else {
      const normalized = normalizedArchivePath(value);
      if (normalized === null) {
        state.issues.add("attachment-file-malformed");
      }
      state.attachedFiles.set(postId, normalized);
    }
  } else if (key === "_wp_attachment_image_alt" && post?.kind === "attachment") {
    if (value !== null && value !== undefined && value.trim().length > 0) {
      state.altPresent.add(postId);
    }
  } else if (key === "_wp_attachment_metadata" && post?.kind === "attachment") {
    inspectDimensions(state, postId, value, limits);
  }
}


  export function metadataHandlers(
    state: MetadataState,
    graph: GraphState,
    postTable: PostTableState,
    postMetaTable: string | undefined,
    limits: SourceEvidenceLimits
  ) {
    return {
      onCreateTable() {
        // The graph pass selects the only allowed postmeta table before this pass.
      },
      getTableColumns(table: string) {
        return [...(graph.tableColumns.get(table) ?? [])];
      },
      onInsert(insert: SqlInsert) {
        if (
          postMetaTable !== undefined
          && insert.table.toLowerCase() === postMetaTable.toLowerCase()
          && tableHasColumns(
            graph.tableColumns.get(postMetaTable) ?? new Set(),
            ["post_id", "meta_key", "meta_value"]
          )
        ) {
          processMetadataInsert(state, postTable, insert, limits);
        }
      }
    };
  }
