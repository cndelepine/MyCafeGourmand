import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sanitizedSqlFixture =
  /^test\/fixtures\/wordpress\/[^/]+\.sql$/i;
const privatePathSegments = new Set([
  "migration-output",
  "upload-archives",
  "uploads",
  "wp-content"
]);
const backupPathSegments = new Set([
  "backup",
  "backups",
  "database-backups",
  "migration-inputs",
  "source-backups",
  "wordpress-backups"
]);
const compressedOrArchived =
  "(?:7z|bz2|gz|rar|tar|tar\\.bz2|tar\\.gz|tar\\.xz|tar\\.zst|tgz|xz|zip|zst)";
const databaseInput =
  new RegExp(
    `\\.(?:sql|dump)(?:\\.${compressedOrArchived})?$|\\.(?:sqlite|sqlite3)$`,
    "i"
  );
const archiveInput =
  /\.(?:7z|bz2|gz|rar|tar|tar\.bz2|tar\.gz|tar\.xz|tar\.zst|tgz|xz|zip|zst)$/i;
const migrationArchiveName =
  /(?:^|[-_.])(backup|database|db|dump|uploads?|wordpress|wp)(?:[-_.]|$)/i;

function normalizedRepositoryPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function forbiddenMigrationInputReason(filePath) {
  const normalized = normalizedRepositoryPath(filePath);

  if (sanitizedSqlFixture.test(normalized)) {
    return undefined;
  }

  const segments = normalized.toLowerCase().split("/");
  if (segments.some((segment) => privatePathSegments.has(segment))) {
    return "private migration directory";
  }
  if (segments.some((segment) => segment.startsWith("drive-download-"))) {
    return "private migration download";
  }

  const basename = path.posix.basename(normalized);
  const parentSegments = segments.slice(0, -1);
  if (/^wp-config\.php(?:[.~_-].*)?$/i.test(basename)) {
    return "WordPress configuration";
  }
  if (databaseInput.test(basename)) {
    return "database export";
  }
  if (
    new RegExp(
      `\\.wxr(?:\\.xml)?(?:\\.${compressedOrArchived})?$`,
      "i"
    ).test(basename)
  ) {
    return "WordPress WXR export";
  }
  if (
    /wordpress/i.test(basename) &&
    new RegExp(`\\.xml(?:\\.${compressedOrArchived})?$`, "i").test(basename)
  ) {
    return "possible WordPress WXR export";
  }
  if (archiveInput.test(basename)) {
    if (parentSegments.some((segment) => backupPathSegments.has(segment))) {
      return "possible migration archive";
    }
    const stem = basename.replace(archiveInput, "");
    if (migrationArchiveName.test(stem)) {
      return "possible migration archive";
    }
  }

  return undefined;
}

export function findForbiddenMigrationInputs(filePaths) {
  return filePaths.flatMap((filePath) => {
    const reason = forbiddenMigrationInputReason(filePath);
    return reason === undefined ? [] : [{ path: filePath, reason }];
  });
}

function trackedRepositoryPaths() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return output.split("\0").filter(Boolean);
}

export function checkRepository() {
  const forbidden = findForbiddenMigrationInputs(trackedRepositoryPaths());
  if (forbidden.length === 0) {
    console.log("Repository migration-input guard passed.");
    return;
  }

  console.error("Forbidden migration inputs are tracked:");
  for (const finding of forbidden) {
    console.error(`- ${finding.path}: ${finding.reason}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  checkRepository();
}
