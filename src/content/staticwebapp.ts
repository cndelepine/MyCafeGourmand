import type { EditorialPageRecord } from "./editorial-schema";
import type { ExactRedirect } from "./redirect-manifest";
import { createExactRedirectManifest } from "./redirect-manifest";
import type { GalleryRecord } from "./gallery-schema";
import type { RecipeRecord } from "./schema";
import {
  decodeLocalPath,
  localPathKey,
  validateSafeLocalPath
} from "./url-path";
import {
  getPublicStaticPageParams,
  getStaticPathFromSegments
} from "../lib/public-routes";

export const maxStaticWebAppConfigBytes = 20_000;

export type StaticWebAppConfig = Record<string, unknown> & {
  routes: Record<string, unknown>[];
};

export type StaticWebAppConfigOptions = {
  editorialRecords?: readonly EditorialPageRecord[];
  galleryRecords?: readonly GalleryRecord[];
  handAuthoredConfig?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAzurePath(value: string, label: string) {
  validateSafeLocalPath(value, `Azure Static Web Apps ${label}`);
}

function azurePathKey(value: string) {
  try {
    return localPathKey(value);
  } catch {
    // validateAzurePath reports malformed encoding with the useful context.
    return value === "/" ? "/" : value.replace(/\/+$/u, "");
  }
}

function isExactAzureRoute(value: string) {
  try {
    return !/[*{}]/u.test(decodeLocalPath(value));
  } catch {
    // validateAzurePath reports malformed encoding with the useful context.
    return !/[*{}]/u.test(value);
  }
}

function canonicalPaths(
  records: readonly RecipeRecord[],
  editorialRecords: readonly EditorialPageRecord[],
  galleryRecords: readonly GalleryRecord[]
) {
  return new Set(
    getPublicStaticPageParams(records, editorialRecords, galleryRecords).map(({ segments }) =>
      azurePathKey(getStaticPathFromSegments(segments))
    )
  );
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
      if (isExactAzureRoute(route)) {
        validateAzurePath(route, `hand-authored redirect source ${index + 1}`);
      }
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
  exactRedirects: readonly ExactRedirect[],
  handAuthoredRoutes: readonly Record<string, unknown>[]
) {
  const edges = new Map<string, RedirectGraphEdge>();
  const addEdge = (source: string, destination: string, description: string) => {
    const sourceKey = azurePathKey(source);
    if (edges.has(sourceKey)) {
      throw new Error(`Redirect source conflict in merged routes: ${source}`);
    }
    edges.set(sourceKey, {
      destination: azurePathKey(destination),
      description
    });
  };

  for (const redirect of exactRedirects) {
    addEdge(
      redirect.source,
      redirect.destination,
      `exact manifest redirect "${redirect.source}"`
    );
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
          `merged redirect loop detected: ${cycle}` +
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
  const editorialRecords = options.editorialRecords ?? [];
  const galleryRecords = options.galleryRecords ?? [];
  const manifest = createExactRedirectManifest(records, editorialRecords, galleryRecords);
  const handAuthoredRoutes = getHandAuthoredRoutes(options.handAuthoredConfig);
  const currentPaths = canonicalPaths(records, editorialRecords, galleryRecords);

  const exactRedirectKeys = new Set(
    manifest.redirects.map((redirect) => azurePathKey(redirect.source))
  );
  for (const [index, route] of handAuthoredRoutes.entries()) {
    if (
      typeof route.route === "string"
      && exactRedirectKeys.has(azurePathKey(route.route))
    ) {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} conflicts with exact redirect: ${route.route}`
      );
    }
  }
  validateMergedRedirectGraph(manifest.redirects, handAuthoredRoutes);
  for (const [index, route] of handAuthoredRoutes.entries()) {
    if (
      typeof route.route === "string"
      && ("redirect" in route || "rewrite" in route)
      && isExactAzureRoute(route.route)
      && currentPaths.has(azurePathKey(route.route))
    ) {
      throw new Error(
        `Hand-authored Static Web Apps route ${index + 1} conflicts with a canonical route: ${route.route}`
      );
    }
  }

  const baseConfig = options.handAuthoredConfig;
  const config = isRecord(baseConfig) ? { ...baseConfig } : {};
  return {
    ...config,
    routes: handAuthoredRoutes
  };
}

export function serializeStaticWebAppConfig(config: StaticWebAppConfig) {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxStaticWebAppConfigBytes) {
    throw new Error(
      `Static Web Apps config is ${bytes} bytes; the maximum is ` +
      `${maxStaticWebAppConfigBytes} bytes. Move exact redirects to the provider manifest.`
    );
  }
  return serialized;
}
