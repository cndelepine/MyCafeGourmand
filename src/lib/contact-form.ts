import type { Locale } from "@/content/schema";
import { getContactSuccessPath } from "./contact-routes";
import { siteUrl } from "./site-origin";

export const contactFormEndpointEnvironmentVariable =
  "NEXT_PUBLIC_CONTACT_FORM_ENDPOINT";

export const contactFormFieldLimits = {
  name: 120,
  email: 254,
  subject: 200,
  message: 5_000
} as const;

export type ContactFormConfiguration =
  | {
    readonly available: true;
    readonly endpoint: string;
  }
  | {
    readonly available: false;
    readonly issue: "invalid" | "missing";
  };

export type ContactFormBoundaryData =
  | {
    readonly available: true;
    readonly endpoint: string;
    readonly locale: Locale;
    readonly returnUrl: string;
  }
  | {
    readonly available: false;
    readonly issue: "invalid" | "missing";
    readonly locale: Locale;
  };

function normalizedHost(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

function parseIpv4(hostname: string) {
  const parts = hostname.split(".");
  if (
    parts.length !== 4
    || parts.some((part) => !/^\d{1,3}$/u.test(part))
  ) {
    return undefined;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  return octets.some((octet) => octet > 255) ? undefined : octets;
}

function isUnsafeIpv4(octets: readonly number[]) {
  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true;
  }
  return first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0)
    || first >= 224;
}

function parseIpv6(hostname: string) {
  const value = hostname.replace(/^\[|\]$/gu, "");
  const compression = value.indexOf("::");
  if (compression !== -1 && value.indexOf("::", compression + 1) !== -1) {
    return undefined;
  }

  const parseParts = (part: string) => {
    if (part.length === 0) {
      return [];
    }
    const parts = part.split(":");
    return parts.every((candidate) => /^[0-9a-f]{1,4}$/iu.test(candidate))
      ? parts.map((candidate) => Number.parseInt(candidate, 16))
      : undefined;
  };
  const before = parseParts(compression === -1 ? value : value.slice(0, compression));
  const after = compression === -1
    ? []
    : parseParts(value.slice(compression + 2));
  if (before === undefined || after === undefined) {
    return undefined;
  }
  if (compression === -1) {
    return before.length === 8 ? before : undefined;
  }
  return before.length + after.length < 8
    ? [...before, ...Array(8 - before.length - after.length).fill(0), ...after]
    : undefined;
}

function isUnsafeIpv6(hostname: string) {
  const groups = parseIpv6(hostname);
  if (groups === undefined) {
    return true;
  }
  const first = groups[0];
  const second = groups[1];
  if (first === undefined || second === undefined) {
    return true;
  }
  const isAllZero = groups.every((group) => group === 0);
  const isLoopback = groups.slice(0, 7).every((group) => group === 0)
    && groups[7] === 1;
  const embeddedIpv4 = [
    groups[6]! >> 8,
    groups[6]! & 0xff,
    groups[7]! >> 8,
    groups[7]! & 0xff
  ];
  const isIpv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0)
    && groups[5] === 0xffff;

  return isAllZero
    || isLoopback
    || (first & 0xe000) !== 0x2000
    || (first === 0x2001 && second === 0x0db8)
    || ((isIpv4Compatible || isIpv4Mapped) && isUnsafeIpv4(embeddedIpv4));
}

function isUnsafeDnsHost(hostname: string) {
  const labels = hostname.split(".");
  if (
    labels.length < 2
    || labels.some((label) =>
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  ) {
    return true;
  }
  return [
    "home.arpa",
    "internal",
    "invalid",
    "lan",
    "local",
    "localhost",
    "onion",
    "test"
  ].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function isPrivateOrLoopbackHost(hostname: string) {
  const host = normalizedHost(hostname);
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "local"
    || host.endsWith(".local")
    || host === "lvh.me"
    || host.endsWith(".lvh.me")
    || host === "localtest.me"
    || host.endsWith(".localtest.me")
    || host === "nip.io"
    || host.endsWith(".nip.io")
    || host === "sslip.io"
    || host.endsWith(".sslip.io")
  ) {
    return true;
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) {
    return isUnsafeIpv4(ipv4);
  }
  return host.startsWith("[") && host.endsWith("]")
    ? isUnsafeIpv6(host)
    : isUnsafeDnsHost(host);
}

function isSameSiteTarget(endpoint: URL, configuredSiteUrl: string) {
  let site: URL;
  try {
    site = new URL(configuredSiteUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Site URL is invalid: ${message}`, { cause: error });
  }

  const endpointHost = normalizedHost(endpoint.hostname);
  const siteHost = normalizedHost(site.hostname);
  const siteHostWithoutWww = siteHost.startsWith("www.")
    ? siteHost.slice("www.".length)
    : siteHost;
  const endpointHostWithoutWww = endpointHost.startsWith("www.")
    ? endpointHost.slice("www.".length)
    : endpointHost;
  return endpointHostWithoutWww === siteHostWithoutWww
    || endpointHost.endsWith(`.${siteHostWithoutWww}`);
}

export function parseContactFormEndpoint(
  value: string,
  configuredSiteUrl: string = siteUrl
) {
  if (
    value.length === 0
    || value.trim() !== value
    || /\s|[\u0000-\u001f\u007f\\#]/u.test(value)
    || !/^https:\/\//iu.test(value)
  ) {
    throw new Error("Contact form endpoint must be an absolute HTTPS URL.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Contact form endpoint is invalid: ${message}`, { cause: error });
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.hostname.length === 0
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || endpoint.hash.length > 0
    || isPrivateOrLoopbackHost(endpoint.hostname)
    || isSameSiteTarget(endpoint, configuredSiteUrl)
  ) {
    throw new Error(
      "Contact form endpoint must be an external HTTPS URL without credentials, fragments, or private hosts."
    );
  }
  return endpoint;
}

export function getContactFormConfiguration(
  value: string | undefined = process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT,
  configuredSiteUrl: string = siteUrl
): ContactFormConfiguration {
  if (value === undefined || value.length === 0) {
    return { available: false, issue: "missing" };
  }
  try {
    return {
      available: true,
      endpoint: parseContactFormEndpoint(value, configuredSiteUrl).href
    };
  } catch {
    return { available: false, issue: "invalid" };
  }
}

export function requireContactFormEndpoint(
  value: string | undefined = process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT,
  configuredSiteUrl: string = siteUrl
) {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${contactFormEndpointEnvironmentVariable} is required for a release build.`
    );
  }
  return parseContactFormEndpoint(value, configuredSiteUrl);
}

export function assertContactFormBuildEnvironment(
  mode: "release",
  environment?: NodeJS.ProcessEnv
): URL;
export function assertContactFormBuildEnvironment(
  mode: "non-release",
  environment?: NodeJS.ProcessEnv
): ContactFormConfiguration;
export function assertContactFormBuildEnvironment(
  mode: "non-release" | "release",
  environment: NodeJS.ProcessEnv = process.env
) {
  if (mode === "release") {
    return requireContactFormEndpoint(
      environment[contactFormEndpointEnvironmentVariable]
    );
  }
  return getContactFormConfiguration(
    environment[contactFormEndpointEnvironmentVariable]
  );
}

export function getContactFormBoundaryData(
  locale: Locale,
  endpoint: string | undefined = process.env.NEXT_PUBLIC_CONTACT_FORM_ENDPOINT,
  configuredSiteUrl: string = siteUrl
): ContactFormBoundaryData {
  const configuration = getContactFormConfiguration(endpoint, configuredSiteUrl);
  return configuration.available
    ? {
      available: true,
      endpoint: configuration.endpoint,
      locale,
      returnUrl: new URL(getContactSuccessPath(locale), configuredSiteUrl).toString()
    }
    : {
      available: false,
      issue: configuration.issue,
      locale
    };
}
