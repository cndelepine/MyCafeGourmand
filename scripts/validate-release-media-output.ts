#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRecipeMediaManifest,
  type RecipeMediaManifest
} from "../src/content/media-manifest";
import type { RecipeRecord } from "../src/content/schema";
import {
  requireRecipeMediaBaseUrl,
  resolveRecipeMediaUrl
} from "../src/lib/recipe-media";
import { getStaticPageParams } from "../src/lib/recipe-routes";

const maxReleaseArtifactBytes = 16 * 1024 * 1024;
export const maxAzureStaticWebAppsFiles = 15_000;
export const maxAzureStaticWebAppsBytes = 250 * 1024 * 1024;
const maxFlightJsonNesting = 256;
const mediaObjectPath = "/recipes/media/wordpress/";
const mediaObjectReference = new RegExp(
  "^/recipes/media/wordpress/(?:0|[1-9]\\d*)\\.(?:avif|gif|jpe?g|png|webp)" +
    "(?=$|[^A-Za-z0-9._~-])",
  "u"
);
const flightPushPrefix = "self.__next_f.push(";

export type ReleaseMediaOutputValidationOptions = {
  readonly mediaBaseUrl?: string;
  readonly mediaManifest?: RecipeMediaManifest;
  readonly outputDirectory?: string;
};

export type ReleaseMediaOutputValidationResult = {
  readonly documents: number;
  readonly mediaUrls: number;
};

export type StaticExportOutputValidationOptions = {
  readonly catalog: readonly RecipeRecord[];
  readonly outputDirectory?: string;
};

export type StaticExportOutputValidationResult = {
  readonly bytes: number;
  readonly files: number;
  readonly routes: number;
};

export class ReleaseMediaOutputValidationError extends Error {
  constructor() {
    super("Release media output validation failed.");
    this.name = "ReleaseMediaOutputValidationError";
  }
}

function fail(): never {
  throw new ReleaseMediaOutputValidationError();
}

function outputFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    try {
      for (const entry of readdirSync(directory, {
        encoding: "utf8",
        withFileTypes: true
      })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          fail();
        }
        if (entry.isDirectory()) {
          visit(candidate);
        } else if (entry.isFile()) {
          files.push(candidate);
          if (files.length > maxAzureStaticWebAppsFiles) {
            fail();
          }
        } else {
          fail();
        }
      }
    } catch (error) {
      if (error instanceof ReleaseMediaOutputValidationError) {
        throw error;
      }
      fail();
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function readReleaseArtifact(file: string) {
  let stats;
  try {
    stats = lstatSync(file);
  } catch {
    fail();
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxReleaseArtifactBytes) {
    fail();
  }
  try {
    return readFileSync(file).toString("utf8");
  } catch {
    fail();
  }
}

function outputRoot(outputDirectory: string | undefined) {
  const root = path.resolve(outputDirectory ?? path.join(process.cwd(), "out"));
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch {
    fail();
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail();
  }
  return root;
}

function outputFileSize(file: string) {
  try {
    const stats = lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxReleaseArtifactBytes) {
      fail();
    }
    return stats.size;
  } catch (error) {
    if (error instanceof ReleaseMediaOutputValidationError) {
      throw error;
    }
    fail();
  }
}

function staticPageFile(
  outputDirectory: string,
  segments: readonly string[]
) {
  const file = path.resolve(outputDirectory, ...segments, "index.html");
  if (
    file !== outputDirectory
    && !file.startsWith(`${outputDirectory}${path.sep}`)
  ) {
    fail();
  }
  return file;
}

export function validateStaticExportOutput(
  options: StaticExportOutputValidationOptions
): StaticExportOutputValidationResult {
  const root = outputRoot(options.outputDirectory);
  const files = outputFiles(root);
  const bytes = files.reduce((total, file) => {
    const next = total + outputFileSize(file);
    if (next > maxAzureStaticWebAppsBytes) {
      fail();
    }
    return next;
  }, 0);
  const staticRoutes = getStaticPageParams(options.catalog);

  for (const { segments } of staticRoutes) {
    outputFileSize(staticPageFile(root, segments));
  }

  return {
    bytes,
    files: files.length,
    routes: staticRoutes.length
  };
}

function isUrlCharacter(value: string) {
  return /[!#$%&'*+,\-./0-9:;=?@A-Z_[\]a-z~]/u.test(value);
}

function decodedTransportText(value: string) {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    decoded = decoded.replace(
      /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\/)/gu,
      (_match, unicode: string | undefined, hexadecimal: string | undefined) => {
        changed = true;
        if (unicode !== undefined) {
          return String.fromCodePoint(Number.parseInt(unicode, 16));
        }
        if (hexadecimal !== undefined) {
          return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
        }
        return "/";
      }
    );
    if (!changed) {
      break;
    }
  }
  return decoded;
}

function mediaUrlAt(value: string, pathIndex: number) {
  let start = pathIndex;
  while (start > 0 && isUrlCharacter(value[start - 1]!)) {
    start -= 1;
  }
  let end = pathIndex + mediaObjectPath.length;
  while (end < value.length && isUrlCharacter(value[end]!)) {
    end += 1;
  }
  return value.slice(start, end);
}

function validateMediaReferences(
  content: string,
  expectedByUrl: ReadonlyMap<string, string>,
  seenKeys: Set<string>
) {
  const decoded = decodedTransportText(content);
  let count = 0;
  let index = decoded.indexOf(mediaObjectPath);
  while (index !== -1) {
    if (!mediaObjectReference.test(decoded.slice(index))) {
      index = decoded.indexOf(mediaObjectPath, index + mediaObjectPath.length);
      continue;
    }
    const candidate = mediaUrlAt(decoded, index);
    const key = expectedByUrl.get(candidate);
    if (key === undefined) {
      fail();
    }
    seenKeys.add(key);
    count += 1;
    index = decoded.indexOf(mediaObjectPath, index + mediaObjectPath.length);
  }
  return count;
}

function parseFlightPushArgument(content: string, start: number) {
  let index = start + flightPushPrefix.length;
  while (index < content.length && /\s/u.test(content[index]!)) {
    index += 1;
  }
  if (content[index] !== "[") {
    fail();
  }
  const argumentStart = index;
  const closers: string[] = [];
  let quote = false;
  let escaped = false;
  for (; index < content.length; index += 1) {
    const current = content[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "\"") {
        quote = false;
      }
      continue;
    }
    if (current === "\"") {
      quote = true;
      continue;
    }
    if (current === "[" || current === "{") {
      closers.push(current === "[" ? "]" : "}");
      if (closers.length > maxFlightJsonNesting) {
        fail();
      }
      continue;
    }
    if (current === "]" || current === "}") {
      if (closers.pop() !== current) {
        fail();
      }
      if (closers.length === 0) {
        const argument = content.slice(argumentStart, index + 1);
        let payload: unknown;
        try {
          payload = JSON.parse(argument) as unknown;
        } catch {
          fail();
        }
        index += 1;
        while (index < content.length && /\s/u.test(content[index]!)) {
          index += 1;
        }
        if (content[index] !== ")") {
          fail();
        }
        return { end: index + 1, payload };
      }
    }
  }
  fail();
}

function flightPayloadText(payload: unknown) {
  if (
    !Array.isArray(payload)
    || typeof payload[0] !== "number"
    || !Number.isSafeInteger(payload[0])
    || (payload.length !== 1 && payload.length !== 2)
  ) {
    fail();
  }
  if (payload.length === 1) {
    return "";
  }
  const text = payload[1];
  if (typeof text !== "string") {
    fail();
  }
  return text;
}

function validateHtmlDocument(
  content: string,
  expectedByUrl: ReadonlyMap<string, string>,
  seenKeys: Set<string>
) {
  const scripts = /<script\b(?<attributes>[^>]*)>(?<content>[\s\S]*?)<\/script\s*>/giu;
  let mediaUrls = 0;
  let previousEnd = 0;
  const flightChunks: string[] = [];
  for (const match of content.matchAll(scripts)) {
    const start = match.index;
    if (start === undefined) {
      fail();
    }
    mediaUrls += validateMediaReferences(
      content.slice(previousEnd, start),
      expectedByUrl,
      seenKeys
    );
    const attributes = match.groups?.attributes ?? "";
    const script = match.groups?.content ?? "";
    if (/\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)/iu.test(
      attributes
    )) {
      try {
        JSON.parse(script);
      } catch {
        fail();
      }
    }
    let scriptIndex = 0;
    let flightIndex = script.indexOf(flightPushPrefix);
    while (flightIndex !== -1) {
      mediaUrls += validateMediaReferences(
        script.slice(scriptIndex, flightIndex),
        expectedByUrl,
        seenKeys
      );
      const flight = parseFlightPushArgument(script, flightIndex);
      flightChunks.push(flightPayloadText(flight.payload));
      scriptIndex = flight.end;
      flightIndex = script.indexOf(flightPushPrefix, scriptIndex);
    }
    mediaUrls += validateMediaReferences(
      script.slice(scriptIndex),
      expectedByUrl,
      seenKeys
    );
    previousEnd = start + match[0].length;
  }
  mediaUrls += validateMediaReferences(
    content.slice(previousEnd),
    expectedByUrl,
    seenKeys
  );
  mediaUrls += validateMediaReferences(flightChunks.join(""), expectedByUrl, seenKeys);
  return mediaUrls;
}

function expectedMediaUrls(manifest: RecipeMediaManifest, base: URL) {
  const expected = new Map<string, string>();
  for (const entry of manifest.entries) {
    let resolved: string;
    try {
      resolved = resolveRecipeMediaUrl(entry.key, base.href);
    } catch {
      fail();
    }
    if (new URL(resolved).origin !== base.origin || expected.has(resolved)) {
      fail();
    }
    expected.set(resolved, entry.key);
  }
  return expected;
}

export function validateReleaseMediaOutput(
  options: ReleaseMediaOutputValidationOptions = {}
): ReleaseMediaOutputValidationResult {
  const base = requireRecipeMediaBaseUrl(options.mediaBaseUrl);
  const manifest = options.mediaManifest ?? loadRecipeMediaManifest();
  const expectedByUrl = expectedMediaUrls(manifest, base);
  const root = outputRoot(options.outputDirectory);
  let mediaUrls = 0;
  const seenKeys = new Set<string>();
  const files = outputFiles(root);
  for (const file of files) {
    const content = readReleaseArtifact(file);
    mediaUrls += path.extname(file).toLowerCase() === ".html"
      ? validateHtmlDocument(content, expectedByUrl, seenKeys)
      : validateMediaReferences(content, expectedByUrl, seenKeys);
  }
  if (seenKeys.size !== manifest.entries.length) {
    fail();
  }
  return {
    documents: files.length,
    mediaUrls
  };
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  void import("../src/content/catalog")
    .then(({ recipeCatalog }) => {
      process.stdout.write(
        `${JSON.stringify({
          media: validateReleaseMediaOutput(),
          staticExport: validateStaticExportOutput({ catalog: recipeCatalog })
        }, null, 2)}\n`
      );
    })
    .catch(() => {
      console.error("release-media-output-validation-failed");
      process.exitCode = 1;
    });
}
