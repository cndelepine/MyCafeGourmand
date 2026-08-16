import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { runWprmBulkImport } from "../scripts/wordpress/wprm-import-runner";
import {
  assertPrivateStagingDirectory,
  repositoryRoot
} from "../scripts/wordpress/wprm-import-stage";

const fixture = path.resolve(
  process.cwd(),
  "test/fixtures/wordpress/wprm-bulk.sql"
);

function zipArchive(names: readonly string[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

test("the end-to-end bulk runner keeps every WPRM post accounted", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-bulk-e2e-"));
  try {
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const result = await runWprmBulkImport({
      database: fixture,
      fingerprintKeyFile: keyFile,
      dryRun: true
    });

    assert.equal(result.manifest.candidates.total, 10);
    assert.equal(
      result.manifest.candidates.ready
      + result.manifest.candidates.review
      + result.manifest.candidates.error,
      result.manifest.candidates.total
    );
    assert.equal(result.manifest.wpurSignals, 1);
    assert.equal(result.manifest.wpurRecordsEmitted, 0);
    assert.equal(result.manifest.privacy.rawValuesEmitted, false);
    assert.equal(result.manifest.privacy.sourceWordingEmitted, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the bulk runner rejects a non-private fingerprint key", async () => {
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-bulk-key-"));
  try {
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    chmodSync(keyFile, 0o644);
    await assert.rejects(
      runWprmBulkImport({
        database: fixture,
        fingerprintKeyFile: keyFile,
        dryRun: true
      }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "invalid-fingerprint-key"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("staging authorization is fixed to the physical repository boundary", async () => {
  const suffix = randomBytes(8).toString("hex");
  const allowed = path.join(repositoryRoot, "migration-output", `.wprm-auth-${suffix}`);
  const outside = path.join(repositoryRoot, "..", `.wprm-auth-outside-${suffix}`);
  const symlinkRoot = path.join(repositoryRoot, "migration-output", `.wprm-link-${suffix}`);
  const symlinkTarget = path.join(repositoryRoot, "migration-output", `.wprm-target-${suffix}`);
  const originalCwd = process.cwd();
  try {
    const allowedDirectories = await assertPrivateStagingDirectory(
      path.relative(repositoryRoot, allowed)
    );
    assert.equal(allowedDirectories.root, allowed);
    assert.equal(lstatSync(allowed).mode & 0o777, 0o700);
    assert.equal(lstatSync(allowedDirectories.candidates).mode & 0o777, 0o700);

    process.chdir(path.dirname(repositoryRoot));
    const cwdIndependent = await assertPrivateStagingDirectory(
      path.relative(repositoryRoot, `${allowed}-cwd`)
    );
    assert.equal(cwdIndependent.root, `${allowed}-cwd`);

    for (const forbidden of ["", "src", "content", "public", "out", ".next", "test"]) {
      await assert.rejects(
        assertPrivateStagingDirectory(path.join(repositoryRoot, forbidden)),
        (error: unknown) =>
          error && typeof error === "object" && "code" in error
          && error.code === "unsafe-staging-dir"
      );
    }
    await assert.rejects(
      assertPrivateStagingDirectory(path.join(repositoryRoot, "migration-output", "..", "src")),
      /WPRM bulk import failed/
    );

    const outsideDirectories = await assertPrivateStagingDirectory(outside);
    assert.equal(outsideDirectories.root, outside);

    mkdirSync(symlinkTarget, { recursive: true });
    symlinkSync(symlinkTarget, symlinkRoot);
    await assert.rejects(
      assertPrivateStagingDirectory(path.join(symlinkRoot, "child")),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "unsafe-staging-dir"
    );
    const finalLink = `${symlinkRoot}-final`;
    symlinkSync(symlinkTarget, finalLink);
    await assert.rejects(
      assertPrivateStagingDirectory(finalLink),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "unsafe-staging-dir"
    );
  } finally {
    process.chdir(originalCwd);
    for (const value of [symlinkRoot, `${symlinkRoot}-final`]) {
      try {
        unlinkSync(value);
      } catch {
        // The test cleanup is best effort.
      }
    }
    for (const value of [allowed, `${allowed}-cwd`, outside, symlinkTarget]) {
      rmSync(value, { recursive: true, force: true });
    }
  }
});

test("external staging requires a new root or an authorized resume manifest", async () => {
  const suffix = randomBytes(8).toString("hex");
  const external = path.join(repositoryRoot, "..", `.wprm-external-${suffix}`);
  const arbitrary = path.join(repositoryRoot, "..", `.wprm-arbitrary-${suffix}`);
  const fake = path.join(repositoryRoot, "..", `.wprm-fake-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-external-test-"));
  try {
    const root = path.parse(repositoryRoot).root;
    for (const filesystemRoot of [root, path.parse(path.resolve(root, ".")).root]) {
      await assert.rejects(
        assertPrivateStagingDirectory(filesystemRoot),
        (error: unknown) =>
          error && typeof error === "object" && "code" in error
          && error.code === "unsafe-staging-dir"
      );
    }

    mkdirSync(arbitrary, { recursive: true, mode: 0o700 });
    chmodSync(arbitrary, 0o700);
    const arbitraryMode = lstatSync(arbitrary).mode & 0o777;
    await assert.rejects(
      assertPrivateStagingDirectory(arbitrary, true),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-conflict"
    );
    assert.equal(lstatSync(arbitrary).mode & 0o777, arbitraryMode);

    mkdirSync(path.join(fake, "candidates"), { recursive: true, mode: 0o700 });
    chmodSync(fake, 0o700);
    chmodSync(path.join(fake, "candidates"), 0o700);
    const fakeMarker = path.join(fake, ".wprm-staging.json");
    writeFileSync(fakeMarker, JSON.stringify({ schemaVersion: 1, kind: "wrong" }), {
      mode: 0o600
    });
    const fakeMode = lstatSync(fake).mode & 0o777;
    await assert.rejects(
      assertPrivateStagingDirectory(fake, true),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "unsafe-staging-dir"
    );
    assert.equal(lstatSync(fake).mode & 0o777, fakeMode);

    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const options = {
      database: fixture,
      fingerprintKeyFile: keyFile,
      stagingDir: external,
      write: true
    } as const;
    const first = await runWprmBulkImport(options);
    assert.equal(lstatSync(external).mode & 0o777, 0o700);
    assert.equal(lstatSync(path.join(external, "candidates")).mode & 0o777, 0o700);
    const resumed = await runWprmBulkImport({ ...options, resume: true });
    assert.deepEqual(resumed.manifest, first.manifest);

    const changedDatabase = path.join(directory, "changed.sql");
    writeFileSync(
      changedDatabase,
      readFileSync(fixture, "utf8").replace("Editorial body", "Changed body")
    );
    await assert.rejects(
      runWprmBulkImport({
        ...options,
        database: changedDatabase,
        resume: true
      }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-conflict"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    for (const target of [external, arbitrary, fake]) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("staging resume rejects a prior mapper contract", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(repositoryRoot, "migration-output", `.wprm-contract-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-contract-test-"));
  try {
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const options = {
      database: fixture,
      fingerprintKeyFile: keyFile,
      stagingDir,
      write: true
    } as const;
    await runWprmBulkImport(options);
    const markerPath = path.join(stagingDir, ".wprm-staging.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    marker.importerContractVersion = "wprm-bulk-import-v2";
    writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });

    await assert.rejects(
      runWprmBulkImport({ ...options, resume: true }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-conflict"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("WPRM resume binds archive identities rather than upload counts", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(repositoryRoot, "migration-output", `.wprm-upload-contract-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-upload-contract-"));
  try {
    const keyFile = path.join(directory, "key");
    const firstArchive = path.join(directory, "first.zip");
    const changedArchive = path.join(directory, "changed.zip");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    writeFileSync(firstArchive, zipArchive(["uploads/unused-a.jpg"]));
    writeFileSync(changedArchive, zipArchive(["uploads/unused-b.jpg"]));
    const options = {
      database: fixture,
      fingerprintKeyFile: keyFile,
      uploadArchives: [firstArchive],
      stagingDir,
      write: true
    } as const;
    const first = await runWprmBulkImport(options);
    assert.match(first.manifest.source.uploadIndexContractSha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(
      runWprmBulkImport({
        ...options,
        uploadArchives: [changedArchive],
        resume: true
      }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "staging-conflict"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("WPRM resume explicitly rejects pre-upload-contract staging", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(repositoryRoot, "migration-output", `.wprm-upgrade-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-upgrade-"));
  try {
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const options = {
      database: fixture,
      fingerprintKeyFile: keyFile,
      stagingDir,
      write: true
    } as const;
    await runWprmBulkImport(options);
    const markerPath = path.join(stagingDir, ".wprm-staging.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    marker.schemaVersion = 2;
    marker.importerContractVersion = "wprm-bulk-import-v9";
    delete marker.uploadIndexContractSha256;
    writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
    await assert.rejects(
      runWprmBulkImport({ ...options, resume: true }),
      (error: unknown) =>
        error !== null
        && typeof error === "object"
        && "code" in error
        && error.code === "staging-upload-contract-upgrade-required"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("a populated root is rejected before a staging marker can be written", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(repositoryRoot, "migration-output", `.wprm-interrupt-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-interrupt-test-"));
  try {
    const candidates = path.join(stagingDir, "candidates");
    mkdirSync(candidates, { recursive: true, mode: 0o700 });
    const target = path.join(stagingDir, "target");
    writeFileSync(target, "not a candidate");
    symlinkSync(target, path.join(candidates, "101.json"));
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    await assert.rejects(
      runWprmBulkImport({
        database: fixture,
        fingerprintKeyFile: keyFile,
        stagingDir,
        write: true
      }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-conflict"
    );
    const marker = path.join(stagingDir, ".wprm-staging.json");
    assert.equal(lstatSync(marker, { throwIfNoEntry: false }), undefined);
    assert.equal(lstatSync(path.join(candidates, "101.json")).isSymbolicLink(), true);
    assert.equal(
      lstatSync(path.join(stagingDir, "manifest.json"), { throwIfNoEntry: false }),
      undefined
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("exclusive staging lock rejects concurrent WPRM writers", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(repositoryRoot, "migration-output", `.wprm-concurrent-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-concurrent-test-"));
  try {
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const options = {
      database: fixture,
      fingerprintKeyFile: keyFile,
      stagingDir,
      write: true
    } as const;
    const results = await Promise.allSettled([
      runWprmBulkImport(options),
      runWprmBulkImport(options)
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    assert.equal(
      rejected?.reason && typeof rejected.reason === "object" && "code" in rejected.reason
        ? rejected.reason.code
        : null,
      "staging-conflict"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("WPRM staging retries after an empty candidates-only interruption", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(
    repositoryRoot,
    "migration-output",
    `.wprm-interrupted-${suffix}`
  );
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-interrupted-test-"));
  try {
    mkdirSync(path.join(stagingDir, "candidates"), { recursive: true, mode: 0o700 });
    chmodSync(stagingDir, 0o700);
    chmodSync(path.join(stagingDir, "candidates"), 0o700);
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });

    const result = await runWprmBulkImport({
      database: fixture,
      fingerprintKeyFile: keyFile,
      stagingDir,
      write: true
    });

    assert.equal(result.manifest.candidates.total, 10);
    assert.equal(
      lstatSync(path.join(stagingDir, ".wprm-staging.json")).mode & 0o777,
      0o600
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("stale staging locks fail closed", async () => {
  const suffix = randomBytes(8).toString("hex");
  const stagingDir = path.join(repositoryRoot, "migration-output", `.wprm-stale-${suffix}`);
  const directory = mkdtempSync(path.join(process.cwd(), ".wprm-stale-test-"));
  try {
    mkdirSync(path.join(stagingDir, "candidates"), { recursive: true, mode: 0o700 });
    const lockPath = path.join(stagingDir, ".wordpress-staging.lock");
    writeFileSync(lockPath, "stale lock", { mode: 0o600 });
    chmodSync(lockPath, 0o600);
    const keyFile = path.join(directory, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    await assert.rejects(
      runWprmBulkImport({
        database: fixture,
        fingerprintKeyFile: keyFile,
        stagingDir,
        write: true
      }),
      (error: unknown) =>
        error && typeof error === "object" && "code" in error
        && error.code === "staging-conflict"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});
