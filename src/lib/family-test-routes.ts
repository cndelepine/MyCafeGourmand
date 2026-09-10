export const familyTestPrefix = "/_family-test/";
export const familyTestPublicPages = [
  `${familyTestPrefix}login.html`,
  `${familyTestPrefix}denied.html`
] as const;
export const familyTestProbePath = `${familyTestPrefix}probe.html`;
export const familyTestRole = "family";

export function isFamilyTestReservedPath(decodedPath: string) {
  const lower = decodedPath.toLowerCase();
  return lower === "/_family-test" || lower.startsWith(familyTestPrefix)
    || lower === "/.auth" || lower.startsWith("/.auth/");
}
