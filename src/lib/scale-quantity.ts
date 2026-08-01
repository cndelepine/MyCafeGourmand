import type { Quantity } from "@/content/schema";

export function scaleQuantity(quantity: Quantity, factor: number): Quantity {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("Scale factor must be a positive finite number.");
  }
  if (!quantity.scalable) {
    return quantity;
  }

  return {
    ...quantity,
    value: quantity.value === undefined ? undefined : quantity.value * factor,
    min: quantity.min === undefined ? undefined : quantity.min * factor,
    max: quantity.max === undefined ? undefined : quantity.max * factor
  };
}
