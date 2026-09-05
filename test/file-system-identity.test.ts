import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  pathMatchesFileDescriptor,
  sameFileSystemIdentity,
  type FileSystemIdentity
} from "../src/content/file-system-identity";
import { recipeFixture } from "./fixtures/recipe";

const pathIdentity: FileSystemIdentity = {
  dev: 0x12345678fedcba98n,
  ino: 987654321n,
  mode: 0o100666n,
  size: 42n,
  mtimeNs: 1700000000123456700n,
  ctimeNs: 1700000000765432100n
};
const descriptorIdentity = { ...pathIdentity, dev: 0xfedcba98n };
const identityFields = [
  "dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"
] as const;

function withRecipeDirectory<T>(callback: (root: string, source: string) => T) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".file-identity-test-"));
  const source = path.join(root, "en", `${recipeFixture.slug}.json`);
  try {
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, JSON.stringify(recipeFixture));
    return callback(root, source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Windows path/descriptor comparison accepts only the volume serial width difference", () => {
  assert.equal(sameFileSystemIdentity(pathIdentity, descriptorIdentity), false);
  assert.equal(pathMatchesFileDescriptor(pathIdentity, descriptorIdentity, "win32"), true);
  assert.equal(pathMatchesFileDescriptor(pathIdentity, pathIdentity, "win32"), true);
  assert.equal(pathMatchesFileDescriptor(descriptorIdentity, descriptorIdentity, "win32"), true);
  assert.equal(pathMatchesFileDescriptor(descriptorIdentity, pathIdentity, "win32"), false);
  assert.equal(pathMatchesFileDescriptor(pathIdentity, {
    ...pathIdentity,
    dev: pathIdentity.dev + (1n << 32n)
  }, "win32"), false);
  for (const platform of ["linux", "darwin"] as const) {
    assert.equal(pathMatchesFileDescriptor(pathIdentity, descriptorIdentity, platform), false);
  }
});

test("Windows zero path devices require independent descriptor snapshots for device checks", () => {
  const missingDevice = { ...pathIdentity, dev: 0n };
  assert.equal(pathMatchesFileDescriptor(missingDevice, descriptorIdentity, "win32"), true);
  assert.equal(pathMatchesFileDescriptor(missingDevice, descriptorIdentity, "linux"), false);
  assert.equal(pathMatchesFileDescriptor(descriptorIdentity, missingDevice, "win32"), false);
  for (const field of identityFields.filter((field) => field !== "dev")) {
    assert.equal(pathMatchesFileDescriptor(missingDevice, {
      ...descriptorIdentity,
      [field]: descriptorIdentity[field] + 1n
    }, "win32"), false, field);
  }
  assert.equal(sameFileSystemIdentity(descriptorIdentity, {
    ...descriptorIdentity,
    dev: descriptorIdentity.dev + 1n
  }), false);
});

test("cross-API comparisons still reject changed device, inode, mode, size, mtime, and ctime", () => {
  for (const field of identityFields) {
    assert.equal(pathMatchesFileDescriptor(pathIdentity, {
      ...descriptorIdentity,
      [field]: descriptorIdentity[field] + 1n
    }, "win32"), false, field);
  }
  for (const mode of [0o040666n, 0o120666n]) {
    assert.equal(pathMatchesFileDescriptor(pathIdentity, {
      ...descriptorIdentity,
      mode
    }, "win32"), false, "directory or symbolic link is not a regular file");
  }
});

test("same-API comparisons retain every bit of device and mutation metadata", () => {
  for (const identity of [pathIdentity, descriptorIdentity]) {
    assert.equal(sameFileSystemIdentity(identity, { ...identity }), true);
    for (const field of identityFields) {
      assert.equal(sameFileSystemIdentity(identity, {
        ...identity,
        [field]: identity[field] + 1n
      }), false, field);
    }
    assert.equal(sameFileSystemIdentity(identity, {
      ...identity,
      dev: identity.dev + (1n << 32n)
    }), false);
  }
});

test("real path and descriptor stats differ only by the supported Windows device representation", (t) => {
  withRecipeDirectory((_root, source) => {
    const before = fs.lstatSync(source, { bigint: true });
    const descriptor = fs.openSync(source, fs.constants.O_RDONLY);
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const differences = identityFields.filter((field) => before[field] !== opened[field]);
      t.diagnostic(JSON.stringify({
        node: process.version,
        uv: process.versions.uv,
        platform: process.platform,
        differences,
        path: Object.fromEntries(identityFields.map((field) => [field, before[field].toString()])),
        descriptor: Object.fromEntries(identityFields.map((field) => [field, opened[field].toString()]))
      }));
      assert.equal(before.isSymbolicLink(), false);
      assert.equal(before.isFile() && opened.isFile(), true);
      assert.deepEqual(differences.filter((field) => field !== "dev"), []);
      assert.equal(pathMatchesFileDescriptor(before, opened), true);
      if (before.dev !== opened.dev) {
        assert.equal(process.platform, "win32");
        assert.equal(before.dev === 0n || (before.dev & 0xffffffffn) === opened.dev, true);
      }
      fs.readFileSync(descriptor);
      assert.equal(sameFileSystemIdentity(opened, fs.fstatSync(descriptor, { bigint: true })), true);
      assert.equal(sameFileSystemIdentity(before, fs.lstatSync(source, { bigint: true })), true);
    } finally {
      fs.closeSync(descriptor);
    }
  });
});

test("real catalog loads unchanged files and detects same-size rewrites and replacements", async () => {
  const { createRecipeContentTreeGuard, loadRecipeCatalog } = await import("../src/content/catalog");
  withRecipeDirectory((root, source) => {
    assert.deepEqual(loadRecipeCatalog(root), [recipeFixture]);
    const guard = createRecipeContentTreeGuard(root);
    guard.assertUnchanged();
    const original = fs.readFileSync(source);
    const modified = Buffer.from(original);
    modified[0] = 0x20;
    fs.writeFileSync(source, modified);
    fs.utimesSync(source, new Date("2001-01-01"), new Date("2001-01-01"));
    assert.throws(() => guard.assertUnchanged(), /content tree changed/);
    fs.writeFileSync(source, original);
    const replacementGuard = createRecipeContentTreeGuard(root);
    const replacement = path.join(root, "replacement.json");
    fs.writeFileSync(replacement, original);
    fs.renameSync(replacement, source);
    assert.throws(() => replacementGuard.assertUnchanged(), /content tree changed/);
  });
});

test("catalog preserves device checks when Windows path stats report zero", async (t) => {
  const { createRecipeContentTreeGuard, loadRecipeCatalog } = await import("../src/content/catalog");
  const platformProperty = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platformProperty);
  const originalLstat = fs.lstatSync;
  const originalFstat = fs.fstatSync;
  withRecipeDirectory((root) => {
    let descriptorDevice = 3092186581n;
    const mockedLstat = t.mock.method(fs, "lstatSync", (entryPath: fs.PathLike) => {
      const stats = originalLstat(entryPath, { bigint: true });
      stats.dev = 0n;
      return stats;
    });
    const mockedFstat = t.mock.method(fs, "fstatSync", (descriptor: number) => {
      const stats = originalFstat(descriptor, { bigint: true });
      stats.dev = descriptorDevice;
      return stats;
    });
    Object.defineProperty(process, "platform", { ...platformProperty, value: "win32" });
    syncBuiltinESMExports();
    try {
      assert.deepEqual(loadRecipeCatalog(root), [recipeFixture]);
      const guard = createRecipeContentTreeGuard(root);
      guard.assertUnchanged();
      descriptorDevice += 1n;
      assert.throws(() => guard.assertUnchanged(), /content tree changed/);
    } finally {
      mockedLstat.mock.restore();
      mockedFstat.mock.restore();
      Object.defineProperty(process, "platform", platformProperty);
      syncBuiltinESMExports();
    }
  });
});

test("catalog rejects a symlinked locale, including Windows junctions", async () => {
  const { loadRecipeCatalog } = await import("../src/content/catalog");
  withRecipeDirectory((root) => {
    fs.symlinkSync(path.join(root, "en"), path.join(root, "fr"), "junction");
    assert.throws(() => loadRecipeCatalog(root), /Symbolic links are not allowed/);
  });
});

test("catalog retains full descriptor identity checks while reading", async (t) => {
  const { loadRecipeCatalog } = await import("../src/content/catalog");
  const originalFstat = fs.fstatSync;
  withRecipeDirectory((root) => {
    for (const field of identityFields) {
      let calls = 0;
      const mocked = t.mock.method(fs, "fstatSync", (descriptor: number) => {
        const stats = originalFstat(descriptor, { bigint: true });
        if (stats.isFile() && ++calls === (process.platform === "win32" ? 4 : 2)) {
          stats[field] += field === "dev" ? 1n << 32n : 1n;
        }
        return stats;
      });
      syncBuiltinESMExports();
      try {
        assert.throws(() => loadRecipeCatalog(root), /source identity changed while it was read/);
        assert.ok(calls >= (process.platform === "win32" ? 4 : 2), field);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    }
  });
});

test("catalog rejects changed descriptor metadata before reading", async (t) => {
  const { loadRecipeCatalog } = await import("../src/content/catalog");
  const originalFstat = fs.fstatSync;
  withRecipeDirectory((root) => {
    for (const field of identityFields) {
      let calls = 0;
      const mocked = t.mock.method(fs, "fstatSync", (descriptor: number) => {
        const stats = originalFstat(descriptor, { bigint: true });
        if (stats.isFile() && ++calls === (process.platform === "win32" ? 2 : 1)) {
          stats[field] += 1n;
        }
        return stats;
      });
      syncBuiltinESMExports();
      try {
        assert.throws(() => loadRecipeCatalog(root), /source identity changed before it was read/);
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    }
  });
});

test("catalog rejects a junction substitution even when the open file is unchanged", async (t) => {
  const { loadRecipeCatalog } = await import("../src/content/catalog");
  const originalOpen = fs.openSync;
  withRecipeDirectory((root, source) => {
    let calls = 0;
    const mocked = t.mock.method(fs, "openSync", (
      entryPath: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode
    ) => {
      if (entryPath === source && ++calls === (process.platform === "win32" ? 2 : 1)) {
        // Windows cannot rename a directory containing an open file.
        const localePath = path.join(root, "en");
        const movedPath = path.join(root, "moved");
        fs.renameSync(localePath, movedPath);
        fs.symlinkSync(movedPath, localePath, "junction");
      }
      return originalOpen(entryPath, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => loadRecipeCatalog(root), /source identity changed before it was read/);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });
});
