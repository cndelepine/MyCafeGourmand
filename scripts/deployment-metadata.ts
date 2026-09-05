import { existsSync, lstatSync, rmSync } from "node:fs";
import path from "node:path";

export const deploymentMetadataDirectoryName = ".deployment";
export const stagedDeploymentMetadataDirectoryName = ".deployment.next";
export const previousDeploymentMetadataDirectoryName = ".deployment.previous";

export function validateManagedDirectory(directory: string, label: string) {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} is not a regular directory: "${directory}"`);
  }
}

export function removeManagedDirectory(directory: string, label: string) {
  if (!existsSync(directory)) {
    return;
  }
  validateManagedDirectory(directory, label);
  rmSync(directory, { recursive: true });
}

export function cleanDeploymentMetadata(projectRoot: string = process.cwd()) {
  const root = path.resolve(projectRoot);
  removeManagedDirectory(
    path.join(root, deploymentMetadataDirectoryName),
    "Deployment metadata path"
  );
  removeManagedDirectory(
    path.join(root, stagedDeploymentMetadataDirectoryName),
    "Staged deployment metadata path"
  );
  removeManagedDirectory(
    path.join(root, previousDeploymentMetadataDirectoryName),
    "Previous deployment metadata path"
  );
}
