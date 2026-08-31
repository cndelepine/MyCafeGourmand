import path from "node:path";
import {
  defaultRecipesRoot,
  loadRecipeCatalogWithSources
} from "../../src/content/catalog";
import { recipeFieldClassifications } from "../../src/content/recipe-field-usage";
import { getCanonicalRecipePath } from "../../src/content/recipe-path";
import { localeValues, type Locale } from "../../src/content/schema";
import { serializeJson } from "./files";

function emptyLocaleCounts(): Record<Locale, number> {
  return { en: 0, fr: 0, ru: 0 };
}

export function createRecipeReport(
  recipesRoot: string = defaultRecipesRoot
) {
  const loaded = loadRecipeCatalogWithSources(recipesRoot);
  const byLocale = emptyLocaleCounts();
  const byVersion = { "1": 0, "2": 0 };
  const byProvenance = { wordpress: 0, authored: 0 };
  const groups = new Map<string, typeof loaded.records>();
  const ungrouped: Array<{
    id: string;
    locale: Locale;
    file: string;
  }> = [];

  const records = loaded.records.map((record, index) => {
    byLocale[record.locale] += 1;
    byVersion[String(record.schemaVersion) as "1" | "2"] += 1;
    byProvenance[record.source.system] += 1;
    const file = path.relative(recipesRoot, loaded.files[index]!.path)
      .split(path.sep)
      .join("/");
    if (record.translationGroupId === null) {
      ungrouped.push({ id: record.id, locale: record.locale, file });
    } else {
      const members = groups.get(record.translationGroupId) ?? [];
      groups.set(record.translationGroupId, [...members, record]);
    }
    return {
      file,
      id: record.id,
      schemaVersion: record.schemaVersion,
      provenance: record.source.system,
      locale: record.locale,
      canonicalPath: getCanonicalRecipePath(record),
      redirects: record.redirectFrom.length,
      translationGroupId: record.translationGroupId
    };
  });

  const translationGroups = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, members]) => {
      const memberLocales = new Set(members.map((member) => member.locale));
      return {
        id,
        members: members
          .map((member) => ({
            id: member.id,
            locale: member.locale,
            canonicalPath: getCanonicalRecipePath(member)
          }))
          .sort((left, right) => left.locale.localeCompare(right.locale)),
        missingLocales: localeValues.filter((locale) => !memberLocales.has(locale))
      };
    });

  return {
    schemaVersion: 1,
    kind: "recipe-maintenance-report",
    summary: {
      records: loaded.records.length,
      byLocale,
      byVersion,
      byProvenance,
      translationGroups: translationGroups.length,
      completeTranslationGroups: translationGroups.filter(
        (group) => group.missingLocales.length === 0
      ).length,
      translationGroupsWithGaps: translationGroups.filter(
        (group) => group.missingLocales.length > 0
      ).length,
      missingTranslationSlots: translationGroups.reduce(
        (total, group) => total + group.missingLocales.length,
        0
      ),
      ungroupedRecipes: ungrouped.length
    },
    fieldUsage: recipeFieldClassifications,
    translations: {
      groups: translationGroups,
      ungrouped
    },
    records
  };
}

export type RecipeReport = ReturnType<typeof createRecipeReport>;

export function serializeRecipeReport(report: RecipeReport) {
  return serializeJson(report);
}

export function formatRecipeReport(report: RecipeReport) {
  const lines = [
    `Recipes: ${report.summary.records} ` +
      `(en ${report.summary.byLocale.en}, fr ${report.summary.byLocale.fr}, ` +
      `ru ${report.summary.byLocale.ru})`,
    `Provenance: WordPress ${report.summary.byProvenance.wordpress}, ` +
      `authored ${report.summary.byProvenance.authored}`,
    `Translations: ${report.summary.completeTranslationGroups} complete group(s), ` +
      `${report.summary.translationGroupsWithGaps} group(s) with review gaps, ` +
      `${report.summary.ungroupedRecipes} ungrouped recipe(s)`,
    "",
    "Translation gaps (review required):"
  ];
  const gaps = report.translations.groups.filter(
    (group) => group.missingLocales.length > 0
  );
  if (gaps.length === 0) {
    lines.push("none");
  } else {
    for (const group of gaps) {
      lines.push(`${group.id}\tmissing=${group.missingLocales.join(",")}`);
    }
  }
  lines.push("", "Ungrouped recipes:");
  if (report.translations.ungrouped.length === 0) {
    lines.push("none");
  } else {
    for (const record of report.translations.ungrouped) {
      lines.push(`${record.file}\t${record.id}`);
    }
  }
  lines.push("", "Field usage:");
  for (const field of report.fieldUsage) {
    lines.push(
      `${field.path}\tv${field.versions.join(",")}\t${field.uses.join(",")}`
    );
  }
  lines.push("", "Records:");
  for (const record of report.records) {
    lines.push(
      `${record.file}\tv${record.schemaVersion}\t${record.provenance}\t` +
      `${record.id}\t${record.canonicalPath}\t` +
      `${record.translationGroupId ?? "ungrouped"}`
    );
  }
  return `${lines.join("\n")}\n`;
}
