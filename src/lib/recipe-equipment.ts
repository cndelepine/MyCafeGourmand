import type { RecipeRecord } from "@/content/schema";

export type RecipeEquipmentItem = NonNullable<
  RecipeRecord["recipe"]["equipment"]
>[number];

export function formatRecipeEquipment(item: RecipeEquipmentItem) {
  const equipment = [item.amount, item.name]
    .filter((value): value is string => value !== null)
    .join(" ");
  return item.notes === null
    ? equipment
    : `${equipment}, ${item.notes}`;
}
