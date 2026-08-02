import { defaultInventoryLimits } from "./constants";
import type { InventoryLimitKey, InventoryLimits } from "./types";

export function mergeInventoryLimits(
  input: Partial<InventoryLimits> | undefined
): InventoryLimits {
  const limits = {
    ...defaultInventoryLimits,
    ...input
  };
  for (const key of Object.keys(defaultInventoryLimits) as InventoryLimitKey[]) {
    const value = limits[key];
    const minimum = key === "maxDepth" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(
        `Inventory limit "${key}" must be an integer greater than or equal to ${minimum}.`
      );
    }
  }
  return limits;
}
