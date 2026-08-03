#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recipeRecordSchema, type Locale } from "../src/content/schema";
import { validateRecipeSlug } from "../src/content/url-path";
import { parsePhpSerialized, type PhpValue } from "./wordpress/php-serialize";
import { getPostMeta } from "./wordpress/sql-dump";

type Arguments = Record<string, string | boolean>;

function assertSafePathSegments(path: string, label: string) {
  for (const segment of path.split("/").filter(Boolean)) {
    if (
      segment === "."
      || segment === ".."
      || /%[0-9a-f]{2}/i.test(segment)
      || /[\u0000-\u001f\u007f]/.test(segment)
    ) {
      throw new Error(`${label} contains an unsafe path segment.`);
    }
  }
}

export function normalizeMediaBasePath(value: string) {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (/[?#]/.test(normalized)) {
    throw new Error("--media-base-path must be a local URL path.");
  }
  assertSafePathSegments(normalized, "--media-base-path");
  return normalized ? `/${normalized}/` : "/";
}

export function normalizeAttachmentPath(value: string, attachmentId: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  assertSafePathSegments(normalized, `Attachment ${attachmentId}`);
  return normalized;
}

function parseArguments(values: string[]) {
  const parsed: Arguments = {};

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }

    const key = argument.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }

  return parsed;
}

function requiredString(args: Arguments, key: string) {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option: --${key}`);
  }
  return value;
}

function text(value: PhpValue | undefined) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim()
    : "";
}

function objectValues(value: PhpValue) {
  if (value === null || typeof value !== "object") {
    throw new Error("Expected a serialized array.");
  }
  return Object.values(value);
}

function object(value: PhpValue) {
  if (value === null || typeof value !== "object") {
    throw new Error("Expected a serialized object.");
  }
  return value;
}

export async function runImporter(argv: string[]) {
  const args = parseArguments(argv);
  const database = resolve(requiredString(args, "database"));
  const recipeId = requiredString(args, "recipe-id");
  const slug = requiredString(args, "slug");
  const locale = requiredString(args, "locale");
  const write = args.write === true;
  const dryRun = args["dry-run"] === true;
  const output = typeof args.output === "string" ? resolve(args.output) : null;
  const mediaBasePath = normalizeMediaBasePath(
    typeof args["media-base-path"] === "string"
      ? args["media-base-path"]
      : "/wordpress-uploads/"
  );

  if (!/^\d+$/.test(recipeId)) {
    throw new Error("--recipe-id must contain digits only.");
  }
  if (!["en", "fr", "ru"].includes(locale)) {
    throw new Error("--locale must be one of en, fr, or ru.");
  }
  validateRecipeSlug(slug, "--slug");
  if (write && output === null) {
    throw new Error("--write requires an explicit --output path.");
  }
  if (write && dryRun) {
    throw new Error("--dry-run and --write cannot be used together.");
  }
  if (!write && output !== null) {
    throw new Error("--output is only valid together with --write.");
  }

  const sql = await readFile(database, "utf8");
  const meta = getPostMeta(sql, recipeId);
  const title = meta.get("recipe_title")?.trim();
  if (!title) {
    throw new Error(`No WP Recipe Maker title was found for recipe ${recipeId}.`);
  }

  const rawIngredients = parsePhpSerialized(meta.get("recipe_ingredients") ?? "a:0:{}");
  const rawInstructions = parsePhpSerialized(meta.get("recipe_instructions") ?? "a:0:{}");
  const ingredientGroups = new Map<string, Array<ReturnType<typeof object>>>();
  const instructions = objectValues(rawInstructions).map(object);
  const mediaByAttachmentId = new Map<string, {
    id: string;
    sourceId: string;
    path: string;
    alt: null;
    width: null;
    height: null;
  }>();

  function preserveAttachment(attachmentId: string) {
    if (!/^\d+$/.test(attachmentId) || attachmentId === "0") {
      throw new Error(`Invalid WordPress attachment ID: ${attachmentId}`);
    }

    const existing = mediaByAttachmentId.get(attachmentId);
    if (existing) {
      return existing.id;
    }

    const attachmentPath = getPostMeta(sql, attachmentId).get("_wp_attached_file");
    if (!attachmentPath) {
      throw new Error(`Attachment ${attachmentId} has no _wp_attached_file metadata.`);
    }
    const normalizedPath = normalizeAttachmentPath(attachmentPath, attachmentId);

    const media = {
      id: `wordpress-attachment:${attachmentId}`,
      sourceId: attachmentId,
      path: `${mediaBasePath}${normalizedPath}`,
      alt: null,
      width: null,
      height: null
    } as const;
    mediaByAttachmentId.set(attachmentId, media);
    return media.id;
  }

  const rawHeroAttachmentId = meta.get("recipe_alternate_image")?.trim();
  const heroMediaId = rawHeroAttachmentId && rawHeroAttachmentId !== "0"
    ? preserveAttachment(rawHeroAttachmentId)
    : null;
  const instructionMediaIds = instructions.map((instruction) => {
    const attachmentId = text(instruction.image);
    return attachmentId && attachmentId !== "0"
      ? preserveAttachment(attachmentId)
      : null;
  });

  for (const rawIngredient of objectValues(rawIngredients)) {
    const ingredient = object(rawIngredient);
    const group = text(ingredient.group);
    const key = group || "0";
    const items = ingredientGroups.get(key) ?? [];
    items.push(ingredient);
    ingredientGroups.set(key, items);
  }

  const record = recipeRecordSchema.parse({
    schemaVersion: 1,
    kind: "recipe",
    id: `wordpress:wprm:${recipeId}`,
    locale: locale as Locale,
    translationGroupId: null,
    slug,
    source: {
      system: "wordpress",
      postId: null,
      recipeId,
      postType: null,
      plugin: "wprm",
      sourceSlug: null,
      createdAt: null,
      modifiedAt: null
    },
    redirectFrom: [],
    title,
    description: meta.get("recipe_description")?.trim() || null,
    editorial: {
      content: null,
      excerpt: null
    },
    taxonomies: [],
    recipe: {
      servings: meta.get("recipe_servings") ? {
        raw: [meta.get("recipe_servings"), meta.get("recipe_servings_type")]
          .filter(Boolean)
          .join(" "),
        unit: meta.get("recipe_servings_type")?.trim() || null,
        scalable: false
      } : null,
      times: {
        prep: meta.get("recipe_prep_time") ? {
          raw: [meta.get("recipe_prep_time"), meta.get("recipe_prep_time_text")]
            .filter(Boolean)
            .join(" "),
          minutes: null
        } : null,
        cook: null,
        rest: null,
        total: null
      },
      heroMediaId,
      ingredientGroups: [...ingredientGroups.entries()].map(([group, items], groupIndex) => ({
        name: group === "0" ? null : group,
        sourceIndex: groupIndex,
        items: items.map((ingredient, sourceIndex) => {
          const raw = [
            text(ingredient.amount),
            text(ingredient.unit),
            text(ingredient.ingredient),
            text(ingredient.notes)
          ].filter(Boolean).join(" ");
          const name = text(ingredient.ingredient);
          if (!raw || !name) {
            throw new Error(`Ingredient ${sourceIndex} in group ${groupIndex} is incomplete.`);
          }
          return {
            sourceIndex,
            raw,
            quantity: null,
            name,
            notes: text(ingredient.notes) || null
          };
        })
      })),
      instructionGroups: [{
        name: null,
        sourceIndex: 0,
        steps: instructions.map((instruction, sourceIndex) => {
          const instructionText = text(instruction.description);
          if (!instructionText) {
            throw new Error(`Instruction ${sourceIndex} has no description.`);
          }
          return {
            sourceIndex,
            text: instructionText,
            mediaId: instructionMediaIds[sourceIndex]
          };
        })
      }]
    },
    media: [...mediaByAttachmentId.values()],
    seo: null
  });

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (write && output) {
    await writeFile(output, serialized, { flag: "wx" });
    console.log(`Created ${output}`);
  } else {
    console.log(serialized);
    console.error("Dry run only; add --write and --output to create a file.");
  }

  return record;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runImporter(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
