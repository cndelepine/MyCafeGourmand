import type { NextConfig } from "next";
import {
  assertRecipeMediaBuildEnvironment,
  getManagedMediaRemotePatterns,
  isRecipeMediaReleaseBuild
} from "./src/lib/recipe-media";

const nextConfig = (phase: string): NextConfig => {
  if (phase === "phase-production-build") {
    assertRecipeMediaBuildEnvironment(
      isRecipeMediaReleaseBuild() ? "release" : "non-release"
    );
  }
  const managedMediaRemotePatterns = getManagedMediaRemotePatterns();
  return {
    output: "export",
    images: {
      unoptimized: true,
      ...(managedMediaRemotePatterns.length === 0
        ? {}
        : { remotePatterns: managedMediaRemotePatterns })
    },
    trailingSlash: true
  };
};

export default nextConfig;
