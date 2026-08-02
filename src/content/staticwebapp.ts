import { localeValues, type RecipeRecord } from "./schema";
import {
  redirects as explicitRedirects,
  validateRedirectManifest,
  type Redirect,
  type RedirectValidationEntry
} from "./redirects";
import { getLocaleHomePath, getRecipePath } from "../lib/recipe-routes";

export type StaticWebAppRoute = {
  route: string;
  redirect: string;
  statusCode: 301;
};

export type StaticWebAppConfig = Record<string, unknown> & {
  routes: StaticWebAppRoute[] | Record<string, unknown>[];
};

export type StaticWebAppConfigOptions = {
  explicitRedirects?: readonly Redirect[];
  handAuthoredConfig?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAzurePath(value: string, label: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(
      `Azure Static Web Apps ${label} must be a single root-relative path: ${value}`
    );
  }
  if (/[?#]/u.test(value) || /[\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new Error(
      `Azure Static Web Apps ${label} cannot contain a query, fragment, or unsafe character: ${value}`
    );
  }
  if (value.includes("*")) {
    throw new Error(
      `Azure Static Web Apps generated redirect ${label} cannot contain a wildcard: ${value}`
    );
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Azure Static Web Apps ${label} is not valid URL encoding: ${value}: ${message}`,
      { cause: error }
    );
  }
  if (
    decoded.includes("\0")
    || decoded.includes("\\")
    || decoded.includes("?")
    || decoded.includes("#")
    || decoded.includes("*")
    || decoded.startsWith("//")
    || decoded.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      `Azure Static Web Apps ${label} contains traversal or an unsafe character: ${value}`
    );
  }
}

function azurePathKey(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // validateAzurePath reports malformed encoding with the useful context.
  }
  return decoded === "/" ? "/" : decoded.replace(/\/+$/u, "");
}

function isExactAzureRoute(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // validateAzurePath reports malformed encoding with the useful context.
  }
  return !/[*{}]/u.test(decoded);
}

function getRecipeRedirectDestination(record: RecipeRecord) {
  const path = getRecipePath(record);
  return path.endsWith("/") ? path : `${path}/`;
}

function canonicalPaths(records: readonly RecipeRecord[]) {
  return new Set([
    "/",
    ...localeValues.map(getLocaleHomePath),
    ...records.map(getRecipePath)
  ].map(azurePathKey));
}

export function buildRedirectManifest(
  records: readonly RecipeRecord[],
  explicit: readonly Redirect[] = explicitRedirects
) {
  const entries: RedirectValidationEntry[] = explicit.map((redirect, index) => ({
    redirect,
    context: `redirect manifest entry ${index + 1}`
  }));

  for (const record of records) {
    for (const legacyUrl of record.legacyUrls) {
      entries.push({
        redirect: {
          source: legacyUrl.path,
          destination: getRecipeRedirectDestination(record),
          status: 301
        },
        context: `recipe "${record.id}" legacy URL "${legacyUrl.path}"`
      });
    }
  }

  return validateRedirectManifest(entries);
}

function validateGeneratedRoutes(
  manifest: readonly Redirect[],
  records: readonly RecipeRecord[]
) {
  const currentPaths = canonicalPaths(records);
  const sourcePaths = new Set<string>();

  for (const redirect of manifest) {
    validateAzurePath(redirect.source, "redirect source");
    validateAzurePath(redirect.destination, "redirect destination");

    const sourceKey = azurePathKey(redirect.source);
    if (sourceKey === "/") {
      throw new Error("Azure Static Web Apps redirect source cannot be the site root.");
    }
    if (currentPaths.has(sourceKey)) {
      throw new Error(
        `Azure Static Web Apps redirect source conflicts with a canonical route: ${redirect.source}`
      );
    }
    if (sourcePaths.has(sourceKey)) {
      throw new Error(`Azure Static Web Apps redirect source conflict: ${redirect.source}`);
    }
    sourcePaths.add(sourceKey);
  }

  return manifest.map((redirect) => ({
    route: redirect.source,
    redirect: redirect.destination,
    statusCode: redirect.status
  } satisfies StaticWebAppRoute));
}

function validateHandAuthoredRoutes(routes: readonly unknown[]) {
  return routes.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`Hand-authored Static Web Apps route ${index + 1} must be an object.`);
    }
    const route = value.route;
    if (typeof route !== "string") {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} must have a string "route".`
      );
    }
    if (!route.startsWith("/") || route.startsWith("//")) {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} must be root-relative: ${route}`
      );
    }
    if (/[?#\u0000-\u001f\u007f\\]/u.test(route)) {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} contains an unsafe character: ${route}`
      );
    }
    if ("redirect" in value && "rewrite" in value) {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} cannot contain both "redirect" and "rewrite".`
      );
    }
    if ("redirect" in value) {
      if (typeof value.redirect !== "string") {
        throw new Error(
          `Hand-authored Static Web Apps route ${index + 1} must have a string "redirect".`
        );
      }
      validateAzurePath(value.redirect, `hand-authored redirect ${index + 1}`);
      if (value.statusCode !== undefined && value.statusCode !== 301 && value.statusCode !== 302) {
        throw new Error(
          `Hand-authored Static Web Apps redirect ${index + 1} must use status code 301 or 302.`
        );
      }
    }
    return value;
  });
}

type RedirectGraphEdge = {
  destination: string;
  description: string;
};

function validateMergedRedirectGraph(
  generatedRoutes: readonly StaticWebAppRoute[],
  handAuthoredRoutes: readonly Record<string, unknown>[]
) {
  const edges = new Map<string, RedirectGraphEdge>();
  const addEdge = (source: string, destination: string, description: string) => {
    const sourceKey = azurePathKey(source);
    if (edges.has(sourceKey)) {
      throw new Error(
        `Azure Static Web Apps redirect source conflict in merged routes: ${source}`
      );
    }
    edges.set(sourceKey, {
      destination: azurePathKey(destination),
      description
    });
  };

  for (const route of generatedRoutes) {
    addEdge(route.route, route.redirect, `generated route "${route.route}"`);
  }

  for (const [index, route] of handAuthoredRoutes.entries()) {
    if (!("redirect" in route)) {
      continue;
    }
    if (typeof route.route !== "string" || typeof route.redirect !== "string") {
      continue;
    }
    if (!isExactAzureRoute(route.route)) {
      throw new Error(
        `Cannot safely merge non-exact hand-authored Azure redirect route ` +
        `"${route.route}". Wildcard redirect routes must be reviewed separately.`
      );
    }
    addEdge(
      route.route,
      route.redirect,
      `hand-authored route ${index + 1} "${route.route}"`
    );
  }

  for (const start of edges.keys()) {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && edges.has(current)) {
      if (visited.has(current)) {
        const cycleStart = chain.indexOf(current);
        const cycle = [...chain.slice(cycleStart), current].join(" -> ");
        const descriptions = chain
          .slice(cycleStart)
          .map((source) => edges.get(source)?.description)
          .filter((description): description is string => description !== undefined)
          .join("; ");
        throw new Error(
          `Azure Static Web Apps merged redirect loop detected: ${cycle}` +
          (descriptions.length > 0 ? ` (${descriptions})` : "")
        );
      }
      visited.add(current);
      chain.push(current);
      current = edges.get(current)?.destination;
    }
  }
}

function getHandAuthoredRoutes(config: unknown) {
  if (config === undefined) {
    return [];
  }
  if (!isRecord(config)) {
    throw new Error("Hand-authored Static Web Apps config must be a JSON object.");
  }
  const routes = config.routes;
  if (routes === undefined) {
    return [];
  }
  if (!Array.isArray(routes)) {
    throw new Error('Hand-authored Static Web Apps config "routes" must be an array.');
  }
  return validateHandAuthoredRoutes(routes);
}

export function createStaticWebAppConfig(
  records: readonly RecipeRecord[],
  options: StaticWebAppConfigOptions = {}
): StaticWebAppConfig {
  const manifest = buildRedirectManifest(records, options.explicitRedirects);
  const generatedRoutes = validateGeneratedRoutes(manifest, records);
  const handAuthoredRoutes = getHandAuthoredRoutes(options.handAuthoredConfig);

  const generatedRouteKeys = new Set(generatedRoutes.map((route) => azurePathKey(route.route)));
  for (const [index, route] of handAuthoredRoutes.entries()) {
    if (
      isRecord(route)
      && typeof route.route === "string"
      && generatedRouteKeys.has(azurePathKey(route.route))
    ) {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} conflicts with generated redirect: ${route.route}`
      );
    }
  }
  validateMergedRedirectGraph(generatedRoutes, handAuthoredRoutes);

  const baseConfig = options.handAuthoredConfig;
  const config = isRecord(baseConfig) ? { ...baseConfig } : {};
  return {
    ...config,
    routes: [...generatedRoutes, ...handAuthoredRoutes]
  };
}

export function serializeStaticWebAppConfig(config: StaticWebAppConfig) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
