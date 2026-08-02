import { z } from "zod";

export const redirectSchema = z.strictObject({
  source: z.string().startsWith("/"),
  destination: z.string().startsWith("/"),
  status: z.literal(301)
});

export type Redirect = z.infer<typeof redirectSchema>;

function normalizePath(path: string) {
  const queryIndex = path.search(/[?#]/);
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  return pathname === "/" ? pathname : pathname.replace(/\/+$/, "");
}

function validateRedirectPath(path: string, label: "source" | "destination") {
  if (path.startsWith("//")) {
    throw new Error(`Redirect ${label} must be a single root-relative path: ${path}`);
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(path)) {
    throw new Error(`Redirect ${label} contains an unsafe character: ${path}`);
  }

  const queryIndex = path.search(/[?#]/u);
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Redirect ${label} is not valid URL encoding: ${path}: ${message}`, {
      cause: error
    });
  }

  if (
    decodedPathname.includes("\0")
    || decodedPathname.includes("\\")
    || decodedPathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Redirect ${label} contains traversal or an unsafe character: ${path}`);
  }
}

export type RedirectValidationEntry = {
  redirect: Redirect;
  context?: string;
};

function validateRedirectEntries(entries: readonly RedirectValidationEntry[]) {
  const redirects = entries.map(({ redirect }) => redirectSchema.parse(redirect));
  const bySource = new Map<string, string>();
  const sourceContexts = new Map<string, string | undefined>();

  for (const [index, redirect] of redirects.entries()) {
    validateRedirectPath(redirect.source, "source");
    validateRedirectPath(redirect.destination, "destination");
    const source = normalizePath(redirect.source);
    const destination = normalizePath(redirect.destination);

    if (source === destination) {
      throw new Error(`Self-redirect is not allowed: ${redirect.source}`);
    }
    if (bySource.has(source)) {
      const context = entries[index]?.context;
      const previousContext = sourceContexts.get(source);
      const details = [context, previousContext]
        .filter((value): value is string => Boolean(value))
        .join("; ");
      throw new Error(
        `Duplicate redirect source: ${redirect.source}` +
        (details.length > 0 ? ` (${details})` : "")
      );
    }
    bySource.set(source, destination);
    sourceContexts.set(source, entries[index]?.context);
  }

  for (const source of bySource.keys()) {
    const visited = new Set<string>();
    let path: string | undefined = source;

    while (path !== undefined && bySource.has(path)) {
      if (visited.has(path)) {
        throw new Error(`Redirect loop detected from ${source}`);
      }
      visited.add(path);
      path = bySource.get(path);
    }
  }

  return redirects;
}

export function validateRedirects(input: readonly Redirect[]) {
  return validateRedirectEntries(input.map((redirect) => ({ redirect })));
}

export function validateRedirectManifest(
  entries: readonly RedirectValidationEntry[]
) {
  return validateRedirectEntries(entries);
}

export const redirects = validateRedirects([]);
