import { parsePhpSerialized, type PhpValue } from "./php-serialize";
import type { Locale } from "../../src/content/schema";
import {
  defaultWprmImportLimits,
  type WprmImportLimits
} from "./wprm-import-contracts";

export type WprmPermalinkConfig = {
  readonly homeOrigin: string;
  readonly permalinkStructure: "/%postname%/";
  readonly forceLang: true;
  readonly hideDefault: true;
  readonly rewrite: true;
  readonly redirectLang: false;
  readonly defaultLang: "en";
  readonly locales: readonly ["en", "fr", "ru"];
};

export type WprmWordPressOptions = WprmPermalinkConfig;

export class WprmSourceOptionsError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The WordPress source options are invalid.");
    this.name = "WprmSourceOptionsError";
    this.code = code;
  }
}

const requiredOptionNames = [
  "home",
  "permalink_structure",
  "polylang"
] as const;

const polylangKeys = [
  "force_lang",
  "hide_default",
  "rewrite",
  "redirect_lang",
  "default_lang"
] as const;

const optionalPolylangKeys = new Set([
  "browser",
  "domains",
  "first_activation",
  "language_taxonomies",
  "media_support",
  "nav_menus",
  "post_types",
  "previous_version",
  "sync",
  "taxonomies",
  "uninstall",
  "version"
]);

function optionString(value: string | null | undefined, code: string) {
  if (value === null || value === undefined) {
    throw new WprmSourceOptionsError(code);
  }
  if (Buffer.byteLength(value, "utf8") === 0) {
    throw new WprmSourceOptionsError(code);
  }
  return value;
}

export function parseHomeOrigin(value: string | null | undefined) {
  const source = optionString(value, "invalid-home-option");
  if (/[\u0000-\u0020\u007f]/u.test(source)) {
    throw new WprmSourceOptionsError("invalid-home-option");
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new WprmSourceOptionsError("invalid-home-option");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || source.includes("?")
    || source.includes("#")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.origin === "null"
  ) {
    throw new WprmSourceOptionsError("invalid-home-option");
  }
  return parsed.origin;
}

function strictBoolean(
  value: PhpValue | undefined,
  expected: boolean
) {
  return value === expected || value === (expected ? 1 : 0);
}

function isPhpObject(value: PhpValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalPolylangValueValid(key: string, value: PhpValue | undefined) {
  switch (key) {
    case "browser":
    case "media_support":
      return typeof value === "boolean";
    case "first_activation":
    case "uninstall":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "previous_version":
    case "version":
      return typeof value === "string";
    default:
      return isPhpObject(value);
  }
}

function parsePolylangValue(
  value: string,
  limits: Pick<WprmImportLimits, "evidence">
) {
  let parsed: PhpValue;
  try {
    parsed = parsePhpSerialized(value, {
      maxInputBytes: limits.evidence.maxMetaValueBytes,
      maxDepth: limits.evidence.maxSerializedDepth,
      maxEntries: limits.evidence.maxSerializedEntries,
      maxStringBytes: limits.evidence.maxMetaValueBytes,
      rejectDuplicateKeys: true
    });
  } catch {
    throw new WprmSourceOptionsError("invalid-polylang-option");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WprmSourceOptionsError("invalid-polylang-option");
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) =>
    !polylangKeys.includes(key as typeof polylangKeys[number])
    && !optionalPolylangKeys.has(key)
  )) {
    throw new WprmSourceOptionsError("unsupported-polylang-setting");
  }
  for (const key of optionalPolylangKeys) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)
      && !optionalPolylangValueValid(key, parsed[key])) {
      throw new WprmSourceOptionsError("malformed-polylang-setting");
    }
  }
  const forceLang = parsed.force_lang;
  const hideDefault = parsed.hide_default;
  const rewrite = parsed.rewrite;
  const redirectLang = parsed.redirect_lang;
  const defaultLang = parsed.default_lang;
  if (
    !strictBoolean(forceLang, true)
    || !strictBoolean(hideDefault, true)
    || !strictBoolean(rewrite, true)
    || !strictBoolean(redirectLang, false)
    || defaultLang !== "en"
  ) {
    throw new WprmSourceOptionsError("unsupported-polylang-setting");
  }
}

export function parsePolylangPermalinkConfig(
  value: string | null | undefined,
  limits: Pick<WprmImportLimits, "evidence"> = defaultWprmImportLimits
) {
  const source = optionString(value, "invalid-polylang-option");
  parsePolylangValue(source, limits);
  return true as const;
}

export function parseWordPressSourceOptions(
  values:
    | ReadonlyMap<string, string | null | undefined>
    | Readonly<Record<string, string | null | undefined>>,
  limits: Pick<WprmImportLimits, "evidence"> = defaultWprmImportLimits
): WprmWordPressOptions {
  const options = values instanceof Map
    ? values
    : new Map(Object.entries(values));
  for (const name of requiredOptionNames) {
    if (!options.has(name)) {
      throw new WprmSourceOptionsError("missing-wordpress-option");
    }
  }
  const homeOrigin = parseHomeOrigin(options.get("home"));
  const permalinkStructure = optionString(
    options.get("permalink_structure"),
    "invalid-permalink-structure"
  );
  if (permalinkStructure !== "/%postname%/") {
    throw new WprmSourceOptionsError("unsupported-permalink-structure");
  }
  parsePolylangPermalinkConfig(options.get("polylang"), limits);
  return {
    homeOrigin,
    permalinkStructure,
    forceLang: true,
    hideDefault: true,
    rewrite: true,
    redirectLang: false,
    defaultLang: "en",
    locales: ["en", "fr", "ru"] satisfies readonly [Locale, Locale, Locale]
  };
}

export const parseWprmSourceOptions = parseWordPressSourceOptions;
export const parseWordPressOptions = parseWordPressSourceOptions;
export const parseMinimalPolylangConfig = parsePolylangPermalinkConfig;
