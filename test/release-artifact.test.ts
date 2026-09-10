import assert from "node:assert/strict";
import { readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  prepareStagingArtifact, readBoundedFile, stagingConfig, validateReleaseArtifact,
  writeReleaseArtifactMetadata
} from "../scripts/release-artifact";
import { assertProtectedEnvironment, assertTrustedRun, latestAcceptedRun, selectArtifact } from "../scripts/workflow-release";
import { releaseFixture } from "./release-artifact-fixture";

test("release metadata binds exact files, manifest, config, and reviewed commit", () => {
  const fixture = releaseFixture();
  try {
    const result = validateReleaseArtifact(fixture.root, "production");
    assert.equal(result.metadata.artifactClass, "production");
    assert.equal(result.metadata.canonicalOrigin, "https://mycafegourmand.com");
    assert.match(result.metadata.sourceCommit, /^[a-f0-9]{40}$/u);
    assert.equal(result.manifest.redirects.length, 3);
    assert.throws(() => validateReleaseArtifact(fixture.root, "production", "0".repeat(40)), /trusted workflow/u);
    assert.throws(() => writeReleaseArtifactMetadata(fixture.root), /already exists/u);
    assert.throws(() => validateReleaseArtifact(fixture.root, "staging"), /inventory mismatch/u);
  } finally {
    fixture.cleanup();
  }
});

test("staging is an isolated copy whose only changed bytes are the response config", () => {
  const fixture = releaseFixture();
  try {
    const before = validateReleaseArtifact(fixture.root, "production");
    const stage = path.join(fixture.base, "staging");
    prepareStagingArtifact(fixture.root, stage);
    const after = validateReleaseArtifact(stage, "staging");
    assert.equal(after.artifactDigest, before.artifactDigest);
    for (const file of before.metadata.files) {
      const production = readFileSync(path.join(fixture.root, "out", file.path));
      const staging = readFileSync(path.join(stage, "out", file.path));
      if (file.path === "staticwebapp.config.json") {
        assert.notDeepEqual(production, staging);
        assert.match(staging.toString(), /noindex/u);
        assert.match(staging.toString(), /form-action 'none'/u);
      } else {
        assert.deepEqual(production, staging);
      }
    }
    assert.equal(validateReleaseArtifact(fixture.root, "production").artifactDigest, before.artifactDigest);
    assert.throws(() => validateReleaseArtifact(stage, "production"), /inventory mismatch/u);
    assert.throws(() => prepareStagingArtifact(fixture.root, fixture.root), /isolated/u);
    assert.throws(() => prepareStagingArtifact(fixture.root, path.join(fixture.root, "stage")), /isolated/u);
    assert.throws(() => prepareStagingArtifact(fixture.root, stage), /isolated/u);
  } finally {
    fixture.cleanup();
  }
});

test("artifact validation rejects added, modified, and missing output", () => {
  const fixture = releaseFixture();
  try {
    const extra = path.join(fixture.root, "out", "extra.txt");
    writeFileSync(extra, "extra");
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /inventory mismatch/u);
    rmSync(extra);
    const page = path.join(fixture.root, "out", "index.html");
    writeFileSync(page, "modified");
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /inventory mismatch/u);
    rmSync(page);
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /inventory mismatch/u);
  } finally {
    fixture.cleanup();
  }
});

test("artifact validation rejects symlinks and traversal without reading the target", () => {
  const fixture = releaseFixture();
  try {
    assert.throws(() => readBoundedFile(fixture.root, "../production/out/index.html"), /Unsafe/u);
    const link = path.join(fixture.root, "out", "linked.html");
    symlinkSync(path.join(fixture.root, "out", "index.html"), link);
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /symlink/u);
    rmSync(link);
    const metadata = path.join(fixture.root, ".deployment", "release-artifact.json");
    rmSync(metadata);
    symlinkSync(path.join(fixture.root, ".deployment", "redirect-manifest.json"), metadata);
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /regular files/u);
  } finally {
    fixture.cleanup();
  }
});

test("unknown or stale metadata and a modified legacy manifest fail closed", () => {
  const fixture = releaseFixture();
  try {
    const file = path.join(fixture.root, ".deployment", "release-artifact.json");
    const original = readFileSync(file, "utf8");
    const value: Record<string, unknown> = JSON.parse(original);
    writeFileSync(file, JSON.stringify({ ...value, schemaVersion: 9 }));
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"));
    writeFileSync(file, JSON.stringify({ ...value, artifactClass: "ci" }));
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"));
    writeFileSync(file, original);
    writeFileSync(path.join(fixture.root, ".deployment", "redirect-manifest.json"), "{}");
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /manifest digest/u);
  } finally {
    fixture.cleanup();
  }
});

test("artifact and metadata byte limits are enforced before reading oversized files", () => {
  const fixture = releaseFixture();
  try {
    const oversized = path.join(fixture.root, "out", "oversized.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, 250 * 1024 * 1024 + 1);
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /output limits/u);
    rmSync(oversized);
    truncateSync(path.join(fixture.root, ".deployment", "release-artifact.json"), 8 * 1024 * 1024 + 1);
    assert.throws(() => validateReleaseArtifact(fixture.root, "production"), /bounded/u);
  } finally {
    fixture.cleanup();
  }
});

test("staging config rejects unknown CSP and route overrides instead of erasing policies", () => {
  assert.throws(() => stagingConfig(JSON.stringify({
    globalHeaders: { "Content-Security-Policy": "default-src 'self'" }
  })), /Unsupported/u);
  assert.throws(() => stagingConfig(JSON.stringify({
    globalHeaders: { "x-robots-tag": "noindex" }
  })), /Unsupported/u);
  assert.throws(() => stagingConfig(JSON.stringify({
    globalHeaders: {}, routes: [{ route: "/foo", headers: { "X-Robots-Tag": "index" } }]
  })), /Unsupported/u);
  assert.throws(() => stagingConfig(JSON.stringify({
    globalHeaders: { "Very-Large-Header": "a".repeat(20_000) }
  })), /20,000/u);
});

const trustedRun = {
  id: 123, event: "workflow_dispatch", head_branch: "main", head_sha: "a".repeat(40),
  workflow_id: 42, status: "completed", conclusion: "success",
  updated_at: "2026-09-06T00:00:00Z", head_repository: { full_name: "owner/repo" }
};

test("deployment provenance rejects PR, fork, branch, and unrelated workflow identities", () => {
  assert.equal(assertTrustedRun(trustedRun, "owner/repo", 42).id, 123);
  for (const changed of [
    { event: "pull_request" }, { head_branch: "topic" },
    { head_repository: { full_name: "fork/repo" } }, { workflow_id: 99 }
  ]) {
    assert.throws(() => assertTrustedRun({ ...trustedRun, ...changed }, "owner/repo", 42));
  }
});

test("rerunning an old acceptance cannot reorder or poison production history", () => {
  const artifact = {
    id: 7, name: "accepted-production", size_in_bytes: 512, expired: false,
    created_at: "2026-09-06T00:00:00Z"
  };
  const first = { run: trustedRun, artifact };
  const second = {
    run: { ...trustedRun, id: 124, updated_at: "2026-09-06T01:00:00Z" },
    artifact: { ...artifact, id: 8, created_at: "2026-09-06T01:00:00Z" }
  };
  for (const rerun of [
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" }
  ]) {
    const oldRerun = { ...first, run: { ...first.run, ...rerun, updated_at: "2026-09-06T02:00:00Z" } };
    assert.equal(latestAcceptedRun([oldRerun, second], "owner/repo", 42, "125")?.id, 124);
    assert.equal(assertTrustedRun(oldRerun.run, "owner/repo", 42).id, 123);
    assert.throws(() => latestAcceptedRun([oldRerun, second], "owner/repo", 42, "123"), /already accepted/u);
  }
});

test("artifact selection rejects expired, oversized, ambiguous, or missing archives", () => {
  const artifact = {
    id: 7, name: "release-production", size_in_bytes: 512, expired: false,
    created_at: "2026-09-06T00:00:00Z"
  };
  assert.equal(selectArtifact({ total_count: 1, artifacts: [artifact] }, "release-production").id, 7);
  for (const artifacts of [
    [], [artifact, artifact], [{ ...artifact, expired: true }],
    [{ ...artifact, size_in_bytes: 301 * 1024 * 1024 }]
  ]) {
    assert.throws(() => selectArtifact({ total_count: artifacts.length, artifacts }, "release-production"));
  }
});

test("deployment authorization requires real independent review and branch restrictions", () => {
  const environment = {
    protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [{ id: 7 }] }],
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
  };
  assert.doesNotThrow(() => assertProtectedEnvironment(environment));
  for (const changed of [
    { protection_rules: [] },
    { protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ id: 7 }] }] },
    { protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: [] }] },
    { deployment_branch_policy: null },
    { deployment_branch_policy: { protected_branches: false, custom_branch_policies: false } }
  ]) {
    assert.throws(() => assertProtectedEnvironment({ ...environment, ...changed }));
  }
});

test("deployment workflow is manual, prebuilt, approved, serialized, and SHA pinned", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/deploy.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /options: \[prepare, rollback\]/u);
  assert.match(workflow, /needs: \[authorize, prepare, staging\]/u);
  assert.doesNotMatch(workflow, /\n  (push|pull_request|workflow_run):/u);
  assert.equal(workflow.match(/run: npm run build:release/gu)?.length, 1);
  assert.doesNotMatch(workflow, /NEXT_PUBLIC_CONTACT|CONTACT_FORM_ENDPOINT/u);
  assert.equal(workflow.match(/group: azure-site-mutation/gu)?.length, 2);
  assert.equal(workflow.match(/cancel-in-progress: false/gu)?.length, 2);
  assert.equal(workflow.match(/app_location: out/gu)?.length, 2);
  assert.equal(workflow.match(/skip_app_build: true/gu)?.length, 2);
  assert.equal(workflow.match(/skip_api_build: true/gu)?.length, 2);
  assert.match(workflow, /deployment_environment: staging/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /check-current "\$EXPECTED_CURRENT"/u);
  for (const match of workflow.matchAll(/uses: ([^\n]+)/gu)) {
    assert.match(match[1], /@[a-f0-9]{40}(?: |$)/u);
  }
});
