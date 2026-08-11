import {
  isWordPressRecipeMediaObjectKey,
  validateRecipeMediaPath
} from "../content/media";
import { validateSafeLocalPath } from "../content/url-path";

export const recipeMediaBaseUrlEnvironmentVariable = "NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL";
export const recipeMediaReleaseBuildModeEnvironmentVariable =
  "MY_CAFE_GOURMAND_RELEASE_BUILD";

export type RecipeMediaBuildMode = "release" | "non-release";

function isConfigured(
  environment: NodeJS.ProcessEnv,
  name: string
) {
  return Object.hasOwn(environment, name);
}

export function isRecipeMediaReleaseBuild(
  environment: NodeJS.ProcessEnv = process.env
) {
  return environment[recipeMediaReleaseBuildModeEnvironmentVariable] === "1"
    && environment.npm_lifecycle_event === "build:release";
}

export function assertRecipeMediaBuildEnvironment(
  mode: RecipeMediaBuildMode,
  environment: NodeJS.ProcessEnv = process.env
) {
  const configured = isConfigured(environment, recipeMediaBaseUrlEnvironmentVariable);
  if (mode === "non-release") {
    if (configured) {
      throw new Error(
        `${recipeMediaBaseUrlEnvironmentVariable} is only permitted for npm run build:release.`
      );
    }
    if (isConfigured(environment, recipeMediaReleaseBuildModeEnvironmentVariable)) {
      throw new Error("Release build mode is not permitted for a non-release build.");
    }
    return undefined;
  }
  if (!isRecipeMediaReleaseBuild(environment)) {
    throw new Error("Release media configuration requires the explicit npm run build:release mode.");
  }
  return requireRecipeMediaBaseUrl(environment[recipeMediaBaseUrlEnvironmentVariable]);
}

function rawUrlPath(value: string) {
  const scheme = value.indexOf("://");
  if (scheme === -1) {
    throw new Error("Recipe media base URL must be absolute HTTPS.");
  }
  const authorityStart = scheme + 3;
  const suffix = value.slice(authorityStart);
  const delimiter = suffix.search(/[/?#]/u);
  const authority = delimiter === -1 ? suffix : suffix.slice(0, delimiter);
  if (authority.length === 0 || authority.includes("@") || authority.includes("\\")) {
    throw new Error("Recipe media base URL must not contain credentials or an unsafe host.");
  }
  if (delimiter === -1 || suffix[delimiter] !== "/") {
    return "/";
  }
  const pathEnd = suffix.slice(delimiter).search(/[?#]/u);
  return pathEnd === -1
    ? suffix.slice(delimiter)
    : suffix.slice(delimiter, delimiter + pathEnd);
}

export function parseRecipeMediaBaseUrl(value: string) {
  if (
    value.length === 0
    || value.trim() !== value
    || !/^https:\/\//iu.test(value)
  ) {
    throw new Error("Recipe media base URL must be an absolute HTTPS URL.");
  }
  const pathname = rawUrlPath(value);
  validateSafeLocalPath(pathname, "Recipe media base URL path");

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Recipe media base URL is invalid: ${message}`, { cause: error });
  }
  if (
    url.protocol !== "https:"
    || url.hostname.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new Error(
      "Recipe media base URL must use HTTPS without credentials, query, or fragment."
    );
  }
  return url;
}

export function getRecipeMediaBaseUrl(
  value: string | undefined = process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL
) {
  return value === undefined || value.length === 0
    ? undefined
    : parseRecipeMediaBaseUrl(value);
}

export function requireRecipeMediaBaseUrl(
  value: string | undefined = process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL
) {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${recipeMediaBaseUrlEnvironmentVariable} is required for a release build.`
    );
  }
  return parseRecipeMediaBaseUrl(value);
}

export function resolveRecipeMediaUrl(
  mediaPath: string,
  baseUrl: string | undefined = process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL
) {
  validateRecipeMediaPath(mediaPath);
  if (!isWordPressRecipeMediaObjectKey(mediaPath)) {
    return mediaPath;
  }
  const parsedBase = getRecipeMediaBaseUrl(baseUrl);
  if (parsedBase === undefined) {
    return mediaPath;
  }
  const prefix = parsedBase.href.endsWith("/") ? parsedBase.href : `${parsedBase.href}/`;
  const resolved = new URL(`${prefix}${mediaPath.slice(1)}`);
  if (
    resolved.protocol !== "https:"
    || resolved.origin !== parsedBase.origin
    || resolved.username.length > 0
    || resolved.password.length > 0
    || resolved.search.length > 0
    || resolved.hash.length > 0
  ) {
    throw new Error("Resolved recipe media URL is unsafe.");
  }
  return resolved.href;
}

export function getRecipeMediaRemotePattern(
  value: string | undefined = process.env.NEXT_PUBLIC_RECIPE_MEDIA_BASE_URL
) {
  const base = getRecipeMediaBaseUrl(value);
  if (base === undefined) {
    return undefined;
  }
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/$/u, "");
  return {
    protocol: "https" as const,
    hostname: base.hostname,
    port: base.port,
    pathname: `${basePath}/recipes/media/wordpress/**`
  };
}
