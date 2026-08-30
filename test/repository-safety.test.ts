import assert from "node:assert/strict";
import test from "node:test";
import {
  findForbiddenMigrationInputs,
  forbiddenMigrationInputReason
} from "../scripts/check-forbidden-migration-inputs.mjs";

test("permits only the sanitized WordPress SQL fixture boundary", () => {
  assert.equal(
    forbiddenMigrationInputReason(
      "test/fixtures/wordpress/source-inventory.sql"
    ),
    undefined
  );
  assert.equal(
    forbiddenMigrationInputReason("test/fixtures/other/source.sql"),
    "database export"
  );
  assert.equal(
    forbiddenMigrationInputReason("test/fixtures/wordpress/nested/source.sql"),
    "database export"
  );
});

test("rejects canonical database, WXR, configuration, and upload inputs", () => {
  assert.deepEqual(
    findForbiddenMigrationInputs([
      "backup/site.sql.gz",
      "backup/site.sql.zip",
      "exports/site.WordPress.2026-08-30.xml",
      "exports/site.WordPress.2026-08-30.xml.gz",
      "source/wp-config.php",
      "source/wp-config.php.bak",
      "wp-content/uploads/2020/recipe.jpg",
      "private/uploads.zip",
      "archive/wordpress-backup.tar.gz",
      "migration-output/staging/manifest.json",
      "drive-download-123/source.zip"
    ]),
    [
      { path: "backup/site.sql.gz", reason: "database export" },
      { path: "backup/site.sql.zip", reason: "database export" },
      {
        path: "exports/site.WordPress.2026-08-30.xml",
        reason: "possible WordPress WXR export"
      },
      {
        path: "exports/site.WordPress.2026-08-30.xml.gz",
        reason: "possible WordPress WXR export"
      },
      { path: "source/wp-config.php", reason: "WordPress configuration" },
      {
        path: "source/wp-config.php.bak",
        reason: "WordPress configuration"
      },
      {
        path: "wp-content/uploads/2020/recipe.jpg",
        reason: "private migration directory"
      },
      {
        path: "private/uploads.zip",
        reason: "possible migration archive"
      },
      {
        path: "archive/wordpress-backup.tar.gz",
        reason: "possible migration archive"
      },
      {
        path: "migration-output/staging/manifest.json",
        reason: "private migration directory"
      },
      {
        path: "drive-download-123/source.zip",
        reason: "private migration download"
      }
    ]
  );
});

test("permits ordinary application and test assets", () => {
  assert.deepEqual(
    findForbiddenMigrationInputs([
      "content/recipes/en/soup.json",
      "public/images/recipe.jpg",
      "test/fixtures/sitemaps/index.xml",
      "docs/migration-operations.md"
    ]),
    []
  );
});
