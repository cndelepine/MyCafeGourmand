#!/usr/bin/env node

/**
 * Import one WP Recipe Maker recipe from a WordPress MySQL dump.
 *
 * Example:
 * npm run import:recipe -- --database "C:\\path\\to\\backup-db" --recipe-id 2980 --slug meatballs-soup
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (!value.startsWith("--")) return pairs;
    pairs.push([value.slice(2), values[index + 1]?.startsWith("--") ? true : values[index + 1]]);
    return pairs;
  }, [])
);

const required = ["database", "recipe-id", "slug"];
const missing = required.filter((key) => !args[key]);
if (missing.length) {
  console.error(`Missing required option(s): ${missing.map((key) => `--${key}`).join(", ")}`);
  process.exit(1);
}

const databasePath = resolve(args.database);
const recipeId = String(args["recipe-id"]);
const slug = String(args.slug).toLowerCase();
const uploadsBase = String(args["uploads-base"] ?? "https://mycafegourmand.com/wp-content/uploads/").replace(/\/?$/, "/");
const dryRun = Boolean(args["dry-run"]);
const overwrite = Boolean(args.overwrite);

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  throw new Error("--slug must contain lowercase letters, numbers, and hyphens only.");
}

await stat(databasePath);
const sql = await readFile(databasePath, "utf8");

function unescapeSql(value) {
  return value.replace(/\\([\\'0bnrtZ])/g, (_, character) => ({
    "0": "\0", b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a"
  }[character] ?? character));
}

function getMetaRows(postId) {
  const row = new RegExp(String.raw`\(\d+,${postId},'([^']+)','((?:\\.|[^'])*)'\)`, "g");
  const meta = new Map();
  for (const match of sql.matchAll(row)) meta.set(match[1], unescapeSql(match[2]));
  return meta;
}

function moveByUtf8Bytes(text, start, bytes) {
  let position = start;
  let used = 0;
  while (used < bytes && position < text.length) {
    const point = text.codePointAt(position);
    const character = String.fromCodePoint(point);
    used += Buffer.byteLength(character, "utf8");
    position += character.length;
  }
  if (used !== bytes) throw new Error("Invalid serialized UTF-8 string length.");
  return position;
}

function parsePhpSerialized(text) {
  let position = 0;
  function readUntil(token) {
    const end = text.indexOf(token, position);
    if (end === -1) throw new Error("Unexpected end of serialized value.");
    const result = text.slice(position, end);
    position = end + token.length;
    return result;
  }
  function value() {
    const type = text[position++];
    if (type === "N") { position++; return null; }
    if (text[position++] !== ":") throw new Error("Invalid serialized value.");
    if (type === "s") {
      const length = Number(readUntil(":"));
      if (text[position++] !== '"') throw new Error("Invalid serialized string.");
      const end = moveByUtf8Bytes(text, position, length);
      const result = text.slice(position, end);
      position = end;
      if (text.slice(position, position + 2) !== '";') throw new Error("Invalid serialized string end.");
      position += 2;
      return result;
    }
    if (type === "i" || type === "d" || type === "b") return Number(readUntil(";"));
    if (type === "a") {
      const length = Number(readUntil(":"));
      if (text[position++] !== "{") throw new Error("Invalid serialized array.");
      const result = {};
      for (let index = 0; index < length; index++) result[value()] = value();
      if (text[position++] !== "}") throw new Error("Invalid serialized array end.");
      return result;
    }
    throw new Error(`Unsupported serialized type: ${type}`);
  }
  return value();
}

function values(object) {
  return Object.values(object ?? {});
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function ingredientLine(ingredient) {
  return [ingredient.amount, ingredient.unit, ingredient.ingredient, ingredient.notes]
    .map(text)
    .filter(Boolean)
    .join(" ");
}

function camelCase(value) {
  return value.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

async function download(url, destination) {
  if (!overwrite) {
    try { await stat(destination); return; } catch { /* download it */ }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (${response.status}).`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

const meta = getMetaRows(recipeId);
if (!meta.has("recipe_title")) throw new Error(`No recipe metadata was found for WordPress recipe ID ${recipeId}.`);

const rawIngredients = parsePhpSerialized(meta.get("recipe_ingredients") ?? "a:0:{};");
const rawInstructions = parsePhpSerialized(meta.get("recipe_instructions") ?? "a:0:{};");
const grouped = new Map();
for (const item of values(rawIngredients)) {
  const group = text(item.group) || "Ingredients";
  if (!grouped.has(group)) grouped.set(group, []);
  grouped.get(group).push(ingredientLine(item));
}

const instructions = values(rawInstructions);
const heroAttachmentId = text(meta.get("recipe_alternate_image"));
const attachmentPath = (attachmentId) => text(getMetaRows(attachmentId).get("_wp_attached_file"));
const heroPath = heroAttachmentId ? attachmentPath(heroAttachmentId) : "";
const stepPaths = instructions.map((instruction) => text(instruction.image) ? attachmentPath(text(instruction.image)) : "");

const recipe = {
  id: slug,
  language: String(args.language ?? "en"),
  title: text(meta.get("recipe_title")),
  description: text(meta.get("recipe_description")),
  category: String(args.category ?? "Uncategorized"),
  servings: [text(meta.get("recipe_servings")), text(meta.get("recipe_servings_type"))].filter(Boolean).join(" "),
  prepTime: [text(meta.get("recipe_prep_time")), text(meta.get("recipe_prep_time_text"))].filter(Boolean).join(" "),
  images: {
    hero: heroPath ? `/recipes/${slug}/hero${extname(heroPath)}` : "",
    steps: Object.fromEntries(stepPaths.map((path, index) => path ? [index, `/recipes/${slug}/steps/${String(index + 1).padStart(2, "0")}${extname(path)}`] : []).filter((entry) => entry.length))
  },
  ingredients: [...grouped].map(([name, items]) => ({ name, items })),
  steps: instructions.map((instruction) => text(instruction.description))
};

const projectRoot = process.cwd();
const assetRoot = join(projectRoot, "public", "recipes", slug);
const sourcePath = join(projectRoot, "src", "content", "recipes", `${slug}.ts`);
const downloads = [
  heroPath && { path: heroPath, destination: join(assetRoot, `hero${extname(heroPath)}`) },
  ...stepPaths.map((path, index) => path && { path, destination: join(assetRoot, "steps", `${String(index + 1).padStart(2, "0")}${extname(path)}`) })
].filter(Boolean);

console.log(`Found: ${recipe.title}`);
console.log(`${recipe.ingredients.length} ingredient group(s), ${recipe.steps.length} step(s), ${downloads.length} image(s).`);
if (dryRun) process.exit(0);

await mkdir(join(assetRoot, "steps"), { recursive: true });
for (const image of downloads) {
  console.log(`Downloading ${image.path}`);
  await download(`${uploadsBase}${image.path}`, image.destination);
}

if (!overwrite) {
  try { await stat(sourcePath); throw new Error(`${sourcePath} already exists. Add --overwrite to replace it.`); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

const variableName = camelCase(slug);
const source = `import type { Recipe } from "./types";\n\nexport const ${variableName}: Recipe = ${JSON.stringify(recipe, null, 2)};\n`;
await writeFile(sourcePath, source);
console.log(`Created ${sourcePath}`);
