import { lstat } from "node:fs/promises";
import path from "node:path";

function isPathWithinDirectory(directory: string, candidate: string) {
  const relative = path.relative(directory, candidate);
  return (
    relative === ""
    || (
      !relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative)
    )
  );
}

async function rejectSymlinkComponents(source: string) {
  const absolute = path.resolve(source);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing symlinked local sitemap source: "${source}".`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
}

export async function assertLocalSitemapSource(source: string, rootDirectory: string) {
  if (!isPathWithinDirectory(rootDirectory, source)) {
    throw new Error(
      `Local sitemap child escapes the initial sitemap directory tree: "${source}".`
    );
  }
  await rejectSymlinkComponents(source);
}
