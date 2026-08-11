import type { NextConfig } from "next";
import {
  assertRecipeMediaBuildEnvironment,
  getRecipeMediaRemotePattern,
  isRecipeMediaReleaseBuild
} from "./src/lib/recipe-media";

const nextConfig = (phase: string): NextConfig => {
  if (phase === "phase-production-build") {
    assertRecipeMediaBuildEnvironment(
      isRecipeMediaReleaseBuild() ? "release" : "non-release"
    );
  }
  const recipeMediaRemotePattern = getRecipeMediaRemotePattern();
  return {
    output: "export",
    images: {
      unoptimized: true,
      ...(recipeMediaRemotePattern === undefined
        ? {}
        : { remotePatterns: [recipeMediaRemotePattern] })
    },
    trailingSlash: true
  };
};

export default nextConfig;
