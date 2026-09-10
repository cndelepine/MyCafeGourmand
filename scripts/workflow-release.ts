import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const idSchema = z.string().regex(/^[1-9][0-9]{0,15}$/u);
const runSchema = z.object({
  id: z.number().int().positive(),
  event: z.string(),
  head_branch: z.string().nullable(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  workflow_id: z.number().int().positive(),
  conclusion: z.string().nullable(),
  status: z.string(),
  updated_at: z.string().datetime(),
  head_repository: z.object({ full_name: z.string() })
});
const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  created_at: z.string().datetime(),
  size_in_bytes: z.number().int().nonnegative(),
  expired: z.boolean()
});
export type WorkflowRun = z.infer<typeof runSchema>;
export type WorkflowArtifact = z.infer<typeof artifactSchema>;

export function assertTrustedRun(value: unknown, repository: string, workflowId: number) {
  const run = runSchema.parse(value);
  if (run.event !== "workflow_dispatch" || run.head_branch !== "main"
    || run.head_repository.full_name !== repository || run.workflow_id !== workflowId) {
    throw new Error("Source must be a manual main deployment workflow in this repository.");
  }
  return run;
}

export function latestAcceptedRun(
  values: readonly { run: unknown; artifact: unknown }[],
  repository: string,
  workflowId: number,
  currentRunId?: string
) {
  let latest: { run: WorkflowRun; artifact: WorkflowArtifact } | undefined;
  for (const value of values) {
    const run = assertTrustedRun(value.run, repository, workflowId);
    const artifact = artifactSchema.parse(value.artifact);
    if (artifact.name !== "accepted-production" || artifact.size_in_bytes === 0) {
      throw new Error("Expected immutable production acceptance evidence.");
    }
    if (String(run.id) === currentRunId) {
      throw new Error("This run already accepted production; dispatch a new operation instead of rerunning it.");
    }
    // Reruns mutate run status/updated_at, but cannot rewrite a retained artifact.
    if (latest === undefined || artifact.created_at > latest.artifact.created_at
      || (artifact.created_at === latest.artifact.created_at && artifact.id > latest.artifact.id)) {
      latest = { run, artifact };
    }
  }
  return latest?.run;
}

export function selectArtifact(values: unknown, name: string) {
  const response = z.object({
    total_count: z.number().int().max(20),
    artifacts: z.array(artifactSchema).max(20)
  }).parse(values);
  const matches = response.artifacts.filter((artifact) => artifact.name === name);
  if (matches.length !== 1 || matches[0].expired || matches[0].size_in_bytes > 300 * 1024 * 1024
    || matches[0].size_in_bytes === 0) {
    throw new Error("Expected one retained bounded artifact from the trusted run.");
  }
  return matches[0];
}

async function api(endpoint: string): Promise<unknown> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository)) throw new Error("Invalid repository context.");
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("Read-only Actions token is required.");
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub provenance request failed (${response.status}).`);
  if (!response.body) throw new Error("GitHub provenance response is empty.");
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("GitHub provenance response exceeds bound.");
    parts.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(parts).toString());
}

async function workflowId() {
  const workflow = z.object({ id: z.number().int(), path: z.literal(".github/workflows/deploy.yml") })
    .parse(await api("actions/workflows/deploy.yml"));
  return workflow.id;
}

export function assertProtectedEnvironment(value: unknown) {
  const environment = z.object({
    protection_rules: z.array(z.object({
      type: z.string(), prevent_self_review: z.boolean().optional(),
      reviewers: z.array(z.unknown()).optional()
    })),
    deployment_branch_policy: z.object({
      protected_branches: z.boolean(), custom_branch_policies: z.boolean()
    }).nullable()
  }).parse(value);
  if (!environment.protection_rules.some((rule) => rule.type === "required_reviewers"
    && rule.prevent_self_review === true && (rule.reviewers?.length ?? 0) > 0)
    || !environment.deployment_branch_policy) {
    throw new Error("Administrator must configure required independent reviewers and deployment branch restrictions.");
  }
  if (!environment.deployment_branch_policy.custom_branch_policies
    && !environment.deployment_branch_policy.protected_branches) {
    throw new Error("Environment must restrict deployment to protected main.");
  }
  return { ...environment, deployment_branch_policy: environment.deployment_branch_policy };
}

export async function assertEnvironment(name: "staging" | "production" | "family-test") {
  z.object({ protected: z.literal(true) }).parse(await api("branches/main"));
  const environment = assertProtectedEnvironment(await api(`environments/${name}`));
  if (environment.deployment_branch_policy.custom_branch_policies) {
    const policies = z.object({
      total_count: z.literal(1),
      branch_policies: z.array(z.object({ name: z.literal("main"), type: z.literal("branch") })).length(1)
    });
    policies.parse(await api(`environments/${name}/deployment-branch-policies?per_page=100`));
  }
}

async function assertCurrentProduction(expected: string) {
  if (expected !== "0") idSchema.parse(expected);
  const id = await workflowId();
  const response = z.object({ workflow_runs: z.array(runSchema).max(30) })
    .parse(await api(`actions/workflows/${id}/runs?branch=main&per_page=30`));
  const runs = response.workflow_runs;
  const accepted: { run: WorkflowRun; artifact: WorkflowArtifact }[] = [];
  for (const run of runs) {
    const artifacts = z.object({ artifacts: z.array(artifactSchema).max(20) })
      .parse(await api(`actions/runs/${run.id}/artifacts?per_page=100`));
    for (const artifact of artifacts.artifacts) {
      if (artifact.name === "accepted-production") accepted.push({ run, artifact });
    }
  }
  const latest = latestAcceptedRun(accepted, process.env.GITHUB_REPOSITORY!, id, process.env.GITHUB_RUN_ID);
  if (latest !== undefined) {
    if (String(latest.id) !== expected) throw new Error("Accepted production changed since the operator selected this operation.");
    return;
  }
  if (runs.length === 30 || expected !== "0") {
    throw new Error("Cannot establish the expected accepted production within the bounded history.");
  }
}

function output(name: string, value: string) {
  if (!/^[a-z_]+$/u.test(name) || !/^[a-f0-9]+$/u.test(value)) throw new Error("Invalid workflow output.");
  const file = process.env.GITHUB_OUTPUT;
  if (!file) throw new Error("Missing workflow output file.");
  appendFileSync(file, `${name}=${value}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  void (async () => {
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main") {
      throw new Error("Deployment tooling runs only from a manual main workflow.");
    }
    const [command, operation, runId, expectedCurrent, ...extra] = process.argv.slice(2);
    if (command === "check-current" && operation && !runId) {
      await assertCurrentProduction(operation);
      return;
    }
    if (command !== "authorize" || !["prepare", "rollback"].includes(operation)
      || extra.length || !runId || !expectedCurrent) {
      throw new Error("Usage: workflow-release.ts authorize prepare|rollback SOURCE_RUN EXPECTED_CURRENT_RUN | check-current EXPECTED_CURRENT_RUN");
    }
    await assertEnvironment("production");
    if (operation === "prepare") {
      await assertEnvironment("staging");
      if (runId !== "0") throw new Error("Prepare builds this main commit; source run must be 0.");
      await assertCurrentProduction(expectedCurrent);
      return;
    }
    idSchema.parse(runId);
    assertTrustedRun(await api(`actions/runs/${runId}`), process.env.GITHUB_REPOSITORY!, await workflowId());
    const artifacts = await api(`actions/runs/${runId}/artifacts?per_page=100`);
    const artifact = selectArtifact(artifacts, "accepted-production");
    output("artifact_id", String(artifact.id));
    // Rollback archive provenance belongs to the accepting run, whereas its build
    // SHA remains in the bound receipts; do not pretend it was rebuilt at that SHA.
    await assertCurrentProduction(expectedCurrent);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Workflow authorization failed.");
    process.exitCode = 1;
  });
}
