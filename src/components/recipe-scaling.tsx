"use client";

import { Fragment, useState } from "react";
import type { Quantity, RecipeRecord } from "@/content/schema";
import {
  formatIngredient,
  formatQuantity
} from "@/lib/scale-quantity";

type IngredientGroup =
  RecipeRecord["recipe"]["ingredientGroups"][number];

type RecipeScalingLabels = {
  ingredients: string;
  language: string;
  missing: string;
  prepTime: string;
  cookTime: string;
  restTime: string;
  totalTime: string;
  customTime: string;
  sectionNumber: string;
  serves: string;
  servingScale: string;
};

type RecipeScalingProps = {
  ingredientGroups: readonly IngredientGroup[];
  labels: RecipeScalingLabels;
  language: string;
  servings: Quantity | null;
  times: RecipeRecord["recipe"]["times"];
};

const servingFactors = [1, 2, 3] as const;
type ServingFactor = (typeof servingFactors)[number];

export function RecipeScaling({
  ingredientGroups,
  labels,
  language,
  servings,
  times
}: RecipeScalingProps) {
  const [factor, setFactor] = useState<ServingFactor>(1);
  const displayedServings = servings
    ? formatQuantity(servings, factor)
    : labels.missing;
  const timeEntries = [
    { key: "prep", label: labels.prepTime, value: times.prep?.raw ?? labels.missing },
    ...(["cook", "rest", "total"] as const).flatMap((key) => {
      const duration = times[key];
      return duration === null
        ? []
        : [{ key, label: labels[`${key}Time`], value: duration.raw }];
    }),
    ...(times.custom === null ? [] : [{
      key: "custom",
      label: times.custom.label ?? labels.customTime,
      value: times.custom.duration.raw
    }])
  ];

  return (
    <>
      <fieldset className="serving-controls">
        <legend>{labels.servingScale}</legend>
        {servingFactors.map((option) => (
          <button
            aria-pressed={factor === option}
            key={option}
            onClick={() => setFactor(option)}
            type="button"
          >
            {option}x
          </button>
        ))}
      </fieldset>

      <dl className="details">
        <div>
          <dt>{labels.serves}</dt>
          <dd aria-live="polite">{displayedServings}</dd>
        </div>
        <div>
          {timeEntries.map(({ key, label, value }) => (
            <Fragment key={key}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </div>
        <div>
          <dt>{labels.language}</dt>
          <dd>{language}</dd>
        </div>
      </dl>

      <section
        aria-labelledby="ingredients-title"
        className="ingredients"
        id="ingredients"
      >
        <div className="section-label">
          <span>{labels.sectionNumber}</span>
          <h2 id="ingredients-title">{labels.ingredients}</h2>
        </div>
        <div className="ingredient-groups">
          {ingredientGroups.map((group) => (
            <div className="ingredient-group" key={group.sourceIndex}>
              {group.name ? <h3>{group.name}</h3> : null}
              <ul>
                {group.items.map((item) => (
                  <li key={item.sourceIndex}>{formatIngredient(item, factor)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
