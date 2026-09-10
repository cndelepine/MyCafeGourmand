import { assertEnvironment } from "./workflow-release";

void (async () => {
  if (process.argv.length !== 2 || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Family test deployments require manual dispatch from protected main.");
  }
  await assertEnvironment("family-test");
})().catch(() => {
  console.error("Family deployment blocked: protected main and independent family-test environment approval are required.");
  process.exitCode = 1;
});
