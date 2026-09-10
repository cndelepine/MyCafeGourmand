import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const templatePath = path.resolve("infra/azure/main.bicep");
const template = readFileSync(templatePath, "utf8");
const expectedTypes = [
  "Microsoft.Web/staticSites@2024-11-01",
  "Microsoft.Storage/storageAccounts@2025-01-01",
  "Microsoft.Storage/storageAccounts/blobServices@2025-01-01",
  "Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01"
];

test("Azure family infrastructure has only the four approved resource declarations", () => {
  assert.match(template, /^targetScope = 'resourceGroup'/u);
  assert.deepEqual(
    [...template.matchAll(/^resource \w+ '([^']+)' = \{/gmu)].map((match) => match[1]),
    expectedTypes
  );
  assert.doesNotMatch(template, /^(?:module|extension) /gmu);
  assert.doesNotMatch(template, /repositoryUrl:|repositoryToken:|branch:|identity:|customDomains|roleAssignments/u);
});

test("Azure test site remains Free with no extra previews or repository automation", () => {
  assert.match(template, /sku: \{\s+name: 'Free'\s+tier: 'Free'\s+\}/u);
  assert.match(template, /stagingEnvironmentPolicy: 'Disabled'/u);
  assert.match(template, /enterpriseGradeCdnStatus: 'Disabled'/u);
  assert.match(template, /skipGithubActionWorkflowGeneration: true/u);
  assert.match(template, /retention: 'retain-until-explicit-owner-approval'/u);
  assert.doesNotMatch(template, /expiration|deleteAfter|deploymentScripts|Microsoft\.Consumption/u);
});

test("Azure public media uses hardened Hot LRS storage and Blob-only anonymous read", () => {
  for (const value of [
    "kind: 'StorageV2'", "name: 'Standard_LRS'", "accessTier: 'Hot'",
    "supportsHttpsTrafficOnly: true", "minimumTlsVersion: 'TLS1_2'",
    "allowSharedKeyAccess: false", "defaultToOAuthAuthentication: true",
    "allowCrossTenantReplication: false", "allowBlobPublicAccess: true",
    "publicAccess: 'Blob'"
  ]) assert.ok(template.includes(value), `Missing ${value}`);
  assert.doesNotMatch(template, /publicAccess: 'Container'|staticWebsite|listKeys|listSecrets|listAccountSas/u);
  assert.match(template, /parent: storage\s+name: 'default'/u);
  assert.match(template, /parent: blobService\s+name: mediaContainerName/u);
});

test("Azure CORS derives the actual test host and emits only public URL outputs", () => {
  assert.match(template, /param includeTestOrigin bool = true/u);
  assert.match(template, /var familyTestSiteOrigin = 'https:\/\/\$\{staticSite\.properties\.defaultHostname\}'/u);
  assert.match(template, /allowedOrigins: includeTestOrigin\s+\? \[\s+'https:\/\/mycafegourmand\.com'\s+familyTestSiteOrigin\s+\]\s+: \[\s+'https:\/\/mycafegourmand\.com'\s+\]/u);
  assert.match(template, /allowedMethods: \[\s+'GET'\s+'HEAD'\s+\]/u);
  assert.match(template, /allowedHeaders: \[\]/u);
  assert.doesNotMatch(template, /'\*'|param \w*(?:origin|token|secret|subscription)\w* string/iu);
  assert.deepEqual(
    template.split("\n").filter((line) => line.startsWith("output ")),
    [
      "output siteOrigin string = familyTestSiteOrigin",
      "output recipeMediaBaseUrl string = '${storage.properties.primaryEndpoints.blob}${mediaContainer.name}'"
    ]
  );
});

test("Azure parameter example is sanitized and limited to the approved inputs", () => {
  const example: unknown = JSON.parse(readFileSync(
    "infra/azure/family-test.parameters.example.json", "utf8"
  ));
  assert.deepEqual(example, {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      staticSiteName: { value: "mcg-family-test-example" },
      storageAccountName: { value: "mcgfamilytestexample" },
      mediaContainerName: { value: "recipe-media" },
      location: { value: "westeurope" },
      includeTestOrigin: { value: true }
    }
  });
});

test("Azure infrastructure compiles with the official installed Bicep CLI", (context) => {
  const version = spawnSync("az", ["bicep", "version"], {
    encoding: "utf8", timeout: 30_000
  });
  if (version.error || version.status !== 0) {
    context.skip("Official Azure/Bicep tooling unavailable; compile separately before provisioning. No automatic installation.");
    return;
  }
  const result = spawnSync("az", [
    "bicep", "build", "--file", templatePath, "--stdout", "--no-restore"
  ], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const compiled: unknown = JSON.parse(result.stdout);
  assert.ok(typeof compiled === "object" && compiled !== null && "resources" in compiled);
  assert.ok(Array.isArray(compiled.resources));
  assert.equal(compiled.resources.length, expectedTypes.length);
  assert.deepEqual(compiled.resources.map((resource: unknown) => {
    assert.ok(typeof resource === "object" && resource !== null
      && "type" in resource && "apiVersion" in resource);
    return `${String(resource.type)}@${String(resource.apiVersion)}`;
  }), expectedTypes);
});
