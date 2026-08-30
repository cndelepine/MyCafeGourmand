import {
  parsePhpSerialized,
  type PhpValue
} from "./php-serialize";
import type { SourceEvidenceLimits } from "./source-evidence-contracts";

export function keySignature(value: string): readonly string[] {
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

export function isPhpValue(value: unknown): value is PhpValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return true;
  }
  return typeof value === "object";
}

export function readJsonValue(value: string): PhpValue | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isPhpValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function withinStructuredLimits(
  value: PhpValue,
  limits: Pick<SourceEvidenceLimits, "maxSerializedDepth" | "maxSerializedEntries">
) {
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
      return false;
    }
    if (currentValue === null || typeof currentValue !== "object") {
      continue;
    }
    const children = Array.isArray(currentValue)
      ? currentValue
      : Object.values(currentValue);
    entries += children.length;
    if (entries > limits.maxSerializedEntries) {
      return false;
    }
    for (const child of children) {
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

export function parseStructuredValue(
  value: string | null | undefined,
  limits: SourceEvidenceLimits
): { readonly value: PhpValue; readonly encoding: "php" | "json" } | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > limits.maxMetaValueBytes) {
    return null;
  }
  if (
    /^(?:a|b|d|i|o|r|s|c):/iu.test(trimmed)
    || /^N;/u.test(trimmed)
  ) {
    try {
      return {
        value: parsePhpSerialized(trimmed, {
          maxInputBytes: limits.maxMetaValueBytes,
          maxDepth: limits.maxSerializedDepth,
          maxEntries: limits.maxSerializedEntries,
          maxStringBytes: limits.maxMetaValueBytes
        }),
        encoding: "php"
      };
    } catch {
      return null;
    }
  }
  if (/^[\[{]/u.test(trimmed)) {
    const parsed = readJsonValue(trimmed);
    return parsed === null || !withinStructuredLimits(parsed, limits)
      ? null
      : { value: parsed, encoding: "json" };
  }
  return null;
}

export function eachNestedValue(
  value: PhpValue,
  callback: (key: string, value: PhpValue) => void
) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isPhpValue(entry)) {
        callback("", entry);
      }
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      callback(key, entry);
    }
  }
}

export function collectTargetStrings(value: PhpValue) {
  const targets: string[] = [];
  const keys = new Set(["url", "target", "destination", "redirect"]);
  if (typeof value === "string") {
    return [value];
  }
  const pending: PhpValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || current === undefined || typeof current !== "object") {
      continue;
    }
    eachNestedValue(current, (key, nested) => {
      if (keys.has(key) && typeof nested === "string") {
        targets.push(nested);
      }
      if (nested !== null && typeof nested === "object") {
        pending.push(nested);
      }
    });
  }
  return targets;
}
