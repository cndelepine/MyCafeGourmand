import type { Quantity, RecipeRecord } from "@/content/schema";

export type RecipeIngredient =
  RecipeRecord["recipe"]["ingredientGroups"][number]["items"][number];

const fractionGlyphs = new Map([
  ["1/2", "½"],
  ["1/3", "⅓"],
  ["2/3", "⅔"],
  ["1/4", "¼"],
  ["3/4", "¾"],
  ["1/5", "⅕"],
  ["2/5", "⅖"],
  ["3/5", "⅗"],
  ["4/5", "⅘"],
  ["1/6", "⅙"],
  ["5/6", "⅚"],
  ["1/8", "⅛"],
  ["3/8", "⅜"],
  ["5/8", "⅝"],
  ["7/8", "⅞"]
]);

const fractionDenominators = [2, 3, 4, 5, 6, 8, 10, 12, 16];

function validateFactor(factor: number) {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("Scale factor must be a positive finite number.");
  }
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    throw new Error("Quantity values must be finite.");
  }

  const roundedInteger = Math.round(value);
  if (Math.abs(value - roundedInteger) < 0.0001) {
    return String(roundedInteger);
  }

  const whole = Math.floor(value);
  const fractional = value - whole;

  for (const denominator of fractionDenominators) {
    const numerator = Math.round(fractional * denominator);
    if (
      numerator > 0 &&
      numerator < denominator &&
      Math.abs(fractional - numerator / denominator) < 0.0001
    ) {
      const fraction = `${numerator}/${denominator}`;
      const formattedFraction =
        fractionGlyphs.get(fraction) ?? fraction;
      return whole > 0
        ? `${whole} ${formattedFraction}`
        : formattedFraction;
    }
  }

  return value.toFixed(3).replace(/\.?0+$/, "");
}

export function scaleQuantity(quantity: Quantity, factor: number): Quantity {
  validateFactor(factor);
  if (!quantity.scalable) {
    return quantity;
  }

  if (quantity.value !== undefined) {
    const value = quantity.value * factor;
    return Number.isFinite(value)
      ? { ...quantity, value }
      : quantity;
  }
  if (quantity.min === undefined || quantity.max === undefined) {
    return quantity;
  }
  const min = quantity.min * factor;
  const max = quantity.max * factor;
  return Number.isFinite(min) && Number.isFinite(max)
    ? { ...quantity, min, max }
    : quantity;
}

export function formatQuantity(quantity: Quantity, factor: number) {
  validateFactor(factor);

  if (
    factor === 1 ||
    !quantity.scalable
  ) {
    return quantity.raw;
  }

  const scaledQuantity = scaleQuantity(quantity, factor);
  if (scaledQuantity === quantity) {
    return quantity.raw;
  }
  let amount: string;
  if (scaledQuantity.value !== undefined) {
    amount = formatNumber(scaledQuantity.value);
  } else if (
    scaledQuantity.min !== undefined &&
    scaledQuantity.max !== undefined
  ) {
    amount = `${formatNumber(scaledQuantity.min)}–${formatNumber(
      scaledQuantity.max
    )}`;
  } else {
    return quantity.raw;
  }

  return quantity.unit ? `${amount} ${quantity.unit}` : amount;
}

export function formatIngredient(
  item: RecipeIngredient,
  factor: number
) {
  validateFactor(factor);

  if (factor === 1 || item.quantity === null || !item.quantity.scalable) {
    return item.raw;
  }

  const scaled = scaleQuantity(item.quantity, factor);
  if (scaled === item.quantity) {
    return item.raw;
  }
  const quantity = formatQuantity(item.quantity, factor);
  const usesPluralName = scaled.value !== undefined
    ? Math.abs(scaled.value - 1) >= 0.0001
    : scaled.min !== undefined && scaled.max !== undefined
      ? Math.abs(scaled.min - 1) >= 0.0001 || Math.abs(scaled.max - 1) >= 0.0001
      : false;
  const name = usesPluralName && item.pluralName
    ? item.pluralName
    : item.name;
  const ingredient = item.notes
    ? `${name}, ${item.notes}`
    : name;
  return `${quantity} ${ingredient}`;
}
