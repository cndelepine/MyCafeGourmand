import { z } from "zod";

const redirectSchema = z.strictObject({
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

export function validateRedirects(input: readonly Redirect[]) {
  const redirects = input.map((redirect) => redirectSchema.parse(redirect));
  const bySource = new Map<string, string>();

  for (const redirect of redirects) {
    const source = normalizePath(redirect.source);
    const destination = normalizePath(redirect.destination);

    if (source === destination) {
      throw new Error(`Self-redirect is not allowed: ${redirect.source}`);
    }
    if (bySource.has(source)) {
      throw new Error(`Duplicate redirect source: ${redirect.source}`);
    }
    bySource.set(source, destination);
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

export const redirects = validateRedirects([]);
