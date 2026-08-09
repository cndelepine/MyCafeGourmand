import {
  parsePhpSerialized,
  PhpSerializationError,
  type PhpValue
} from "./php-serialize";
import {
  isPhpValue,
  withinStructuredLimits
} from "./source-evidence-structured";
import type {
  SafeShapeEncoding,
  ShapeContract,
  SourceEvidenceLimits,
  StructuralShapeEvidenceDelta
} from "./source-evidence-contracts";
export type {
  SafeShapeEncoding,
  ShapeContract,
  StructuralShapeEvidence,
  StructuralShapeEvidenceDelta,
  SafeKeySetCount
} from "./source-evidence-contracts";
export { withinStructuredLimits } from "./source-evidence-structured";

function emptyEvidence(): {
  encoding: Record<SafeShapeEncoding, number>;
  rootKinds: Record<"array" | "object" | "scalar" | "none", number>;
  groupKeySets: Map<string, number>;
  itemKeySets: Map<string, number>;
  malformed: number;
} {
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
    groupKeySets: new Map(),
    itemKeySets: new Map(),
    malformed: 0
  };
}

function isRecord(value: PhpValue): value is Record<string, PhpValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStructured(value: PhpValue): value is Record<string, PhpValue> {
  return value !== null && typeof value === "object";
}

function entriesOf(value: PhpValue) {
  return isStructured(value) ? Object.entries(value) : [];
}

function addKeySet(
  target: Map<string, number>,
  value: PhpValue,
  allowedKeys: readonly string[]
): void {
  if (!isRecord(value)) {
    return;
  }
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value)
    .filter((key) => allowed.has(key))
    .sort((left, right) => left.localeCompare(right));
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    keys.push("unknown");
  }
  const signature = JSON.stringify(keys);
  target.set(signature, (target.get(signature) ?? 0) + 1);
}

function addNestedItems(
  target: Map<string, number>,
  group: PhpValue,
  contract: ShapeContract
) {
  if (!isRecord(group)) {
    return;
  }
  const groupKey = contract.allowedGroupKeys.find((key) => isStructured(group[key]));
  if (groupKey === undefined) {
    return;
  }
  for (const [, item] of entriesOf(group[groupKey])) {
    if (!isRecord(item)) {
      continue;
    }
    addKeySet(target, item, contract.allowedItemKeys);
  }
}

function keySignature(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      && parsed.every((key): key is string => typeof key === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function looksLikeItem(value: PhpValue, contract: ShapeContract) {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.some((key) => contract.allowedItemKeys.includes(key))
    && !keys.some((key) => contract.allowedGroupKeys.includes(key));
}

function finalize(
  partial: ReturnType<typeof emptyEvidence>
): StructuralShapeEvidenceDelta {
  const groupKeySets = [...partial.groupKeySets.entries()]
    .map(([signature, count]) => ({
      keys: keySignature(signature),
      count
    }))
    .sort((left, right) =>
      JSON.stringify(left.keys).localeCompare(JSON.stringify(right.keys))
    );
  const itemKeySets = [...partial.itemKeySets.entries()]
    .map(([signature, count]) => ({
      keys: keySignature(signature),
      count
    }))
    .sort((left, right) =>
      JSON.stringify(left.keys).localeCompare(JSON.stringify(right.keys))
    );
  return {
    encoding: partial.encoding,
    rootKinds: partial.rootKinds,
    groupKeySets,
    itemKeySets,
    malformed: partial.malformed
  };
}

export function inspectStructuredValue(
  value: string | null | undefined,
  contract: ShapeContract,
  limits: Pick<
    SourceEvidenceLimits,
    "maxMetaValueBytes" | "maxSerializedDepth" | "maxSerializedEntries" | "maxShapeKeySets"
  >
): StructuralShapeEvidenceDelta {
  const result = emptyEvidence();
  if (value === null || value === undefined) {
    result.encoding.absent += 1;
    result.rootKinds.none += 1;
    return finalize(result);
  }

  if (Buffer.byteLength(value, "utf8") > limits.maxMetaValueBytes) {
    result.encoding["limit-exceeded"] += 1;
    result.rootKinds.none += 1;
    return finalize(result);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    result.encoding.empty += 1;
    result.rootKinds.none += 1;
    return finalize(result);
  }

  let parsed: PhpValue;
  let parsedRootKind: "array" | "object" | "scalar" | "none";
  const serialized =
    /^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed) || /^N;/u.test(trimmed);
  if (serialized) {
    try {
      parsed = parsePhpSerialized(trimmed, {
        maxInputBytes: limits.maxMetaValueBytes,
        maxDepth: limits.maxSerializedDepth,
        maxEntries: limits.maxSerializedEntries,
        maxStringBytes: limits.maxMetaValueBytes
      });
      const serializedType = trimmed[0]?.toLowerCase();
      parsedRootKind = serializedType === "a"
        ? "array"
        : serializedType === "n"
          ? "none"
          : "scalar";
      result.encoding["php-serialized"] += 1;
    } catch (error) {
      if (
        error instanceof PhpSerializationError
        && (error.code === "depth-limit"
          || error.code === "entry-limit"
          || error.code === "string-limit")
      ) {
        result.encoding["limit-exceeded"] += 1;
      } else if (
        error instanceof PhpSerializationError
        && error.code === "unsupported-type"
      ) {
        result.encoding["unsupported-serialized-type"] += 1;
      } else {
        result.encoding["malformed-php"] += 1;
        result.malformed += 1;
      }
      result.rootKinds.none += 1;
      return finalize(result);
    }
  } else if (/^[\[{]/u.test(trimmed)) {
    try {
      const jsonValue: unknown = JSON.parse(trimmed);
      if (!isPhpValue(jsonValue)) {
        throw new Error("not-structured");
      }
      parsed = jsonValue;
      parsedRootKind = Array.isArray(parsed)
        ? "array"
        : parsed === null
          ? "none"
          : "object";
      if (!withinStructuredLimits(parsed, limits)) {
        result.encoding["limit-exceeded"] += 1;
        result.rootKinds.none += 1;
        return finalize(result);
      }
      result.encoding.json += 1;
    } catch {
      result.encoding["malformed-json"] += 1;
      result.malformed += 1;
      result.rootKinds.none += 1;
      return finalize(result);
    }
  } else {
    result.encoding.plain += 1;
    result.rootKinds.scalar += 1;
    result.malformed += 1;
    return finalize(result);
  }

  result.rootKinds[parsedRootKind] += 1;
  if (
    (contract.root === "array" && parsedRootKind !== "array")
    || (contract.root === "object" && parsedRootKind !== "object")
  ) {
    result.malformed += 1;
    return finalize(result);
  }

  const rootEntries = entriesOf(parsed);
  for (const [, entry] of rootEntries) {
    if (contract.allowedGroupKeys.length > 0 && !looksLikeItem(entry, contract)) {
      addKeySet(result.groupKeySets, entry, contract.allowedGroupKeys);
      addNestedItems(result.itemKeySets, entry, contract);
    } else {
      addKeySet(result.itemKeySets, entry, contract.allowedItemKeys);
    }
  }

  const setCount = result.groupKeySets.size + result.itemKeySets.size;
  if (setCount > limits.maxShapeKeySets) {
    result.encoding["limit-exceeded"] += 1;
    result.groupKeySets.clear();
    result.itemKeySets.clear();
    result.malformed += 1;
  }
  return finalize(result);
}
