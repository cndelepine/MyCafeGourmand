export function assertReleaseDeploymentIntegration(): never {
  throw new Error(
    "Release build is blocked until an exact-redirect edge adapter consumes " +
    ".deployment/redirect-manifest.json, deploys every rule, and verifies the live redirects."
  );
}
