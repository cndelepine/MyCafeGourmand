import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  ParsedSitemap,
  RawSitemapChild,
  RawSitemapUrl,
  XmlObject
} from "./types";

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  isArray: (name: string) =>
    ["image", "link", "sitemap", "url"].includes(name.replace(/^.*:/, "")),
  parseTagValue: false,
  removeNSPrefix: true,
  textNodeName: "#text",
  trimValues: true
});

function isRecord(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

function childValues(parent: XmlObject, name: string): unknown[] {
  return asValues(parent[name]);
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const text = textValue(child);
      if (text) {
        return text;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    return textValue(value["#text"]);
  }
  return undefined;
}

function attributeValue(parent: XmlObject, name: string): string | undefined {
  const direct = parent[`@_${name}`];
  if (typeof direct === "string" || typeof direct === "number") {
    const value = String(direct).trim();
    return value.length > 0 ? value : undefined;
  }

  const matchingKey = Object.keys(parent).find(
    (key) => key.toLowerCase() === `@_${name.toLowerCase()}`
  );
  if (!matchingKey) {
    return undefined;
  }
  return textValue(parent[matchingKey]);
}

function localName(name: string) {
  return name.replace(/^.*:/, "");
}

function formatValidationError(value: unknown) {
  if (isRecord(value)) {
    const message = textValue(value.msg) ?? "XML validation failed";
    const line = textValue(value.line);
    const col = textValue(value.col);
    return [message, line && `line ${line}`, col && `column ${col}`]
      .filter((part): part is string => Boolean(part))
      .join(" at ");
  }
  return String(value);
}

function parseXmlDocument(xml: string, source: string): XmlObject {
  if (xml.trim().length === 0) {
    throw new Error(`Malformed XML in "${source}": document is empty.`);
  }
  if (/<!doctype\b/i.test(xml)) {
    throw new Error(`XML with a DOCTYPE is not supported in "${source}".`);
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Malformed XML in "${source}": ${formatValidationError(validation)}.`);
  }

  try {
    const parsed: unknown = parser.parse(xml);
    if (!isRecord(parsed)) {
      throw new Error("XML document has no object root.");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed XML in "${source}": ${message}`, { cause: error });
  }
}

export function parseSitemapDocument(xml: string, source = "<xml>"): ParsedSitemap {
  const parsed = parseXmlDocument(xml, source);
  const rootKeys = Object.keys(parsed).filter(
    (key) => !key.startsWith("?") && !key.startsWith("@_")
  );

  if (rootKeys.length !== 1) {
    throw new Error(
      `Unexpected XML root in "${source}": expected one sitemap root, found ${rootKeys.length}.`
    );
  }

  const rootKey = rootKeys[0];
  if (!rootKey) {
    throw new Error(`Unexpected XML root in "${source}": document has no sitemap root.`);
  }

  const root = localName(rootKey);
  const rootValue = parsed[rootKey];
  if (!isRecord(rootValue)) {
    throw new Error(`Unexpected XML root in "${source}": "${rootKey}" is not an element.`);
  }

  if (root === "sitemapindex") {
    const children: RawSitemapChild[] = [];
    for (const [index, rawChild] of childValues(rootValue, "sitemap").entries()) {
      if (!isRecord(rawChild)) {
        throw new Error(
          `Unexpected sitemap entry ${index + 1} in "${source}": expected an element.`
        );
      }
      const loc = textValue(rawChild.loc);
      if (!loc) {
        throw new Error(
          `Sitemap entry ${index + 1} in "${source}" is missing a <loc> element.`
        );
      }
      const lastmod = textValue(rawChild.lastmod);
      children.push({
        loc,
        ...(lastmod ? { lastmod } : {})
      });
    }
    return { kind: "index", children };
  }

  if (root === "urlset") {
    const urls: RawSitemapUrl[] = [];
    for (const [index, rawUrl] of childValues(rootValue, "url").entries()) {
      if (!isRecord(rawUrl)) {
        throw new Error(
          `Unexpected URL entry ${index + 1} in "${source}": expected an element.`
        );
      }
      const loc = textValue(rawUrl.loc);
      if (!loc) {
        throw new Error(
          `URL entry ${index + 1} in "${source}" is missing a <loc> element.`
        );
      }

      const imageUrls = childValues(rawUrl, "image").flatMap((rawImage) => {
        if (!isRecord(rawImage)) {
          return [];
        }
        const imageLoc = textValue(rawImage.loc);
        return imageLoc ? [imageLoc] : [];
      });
      const alternates = childValues(rawUrl, "link").flatMap((rawLink) => {
        if (!isRecord(rawLink)) {
          return [];
        }
        const rel = attributeValue(rawLink, "rel")?.toLowerCase();
        const hreflang = attributeValue(rawLink, "hreflang");
        const href = attributeValue(rawLink, "href");
        return rel?.split(/\s+/u).includes("alternate") && hreflang && href
          ? [{ hreflang, href }]
          : [];
      });

      const lastmod = textValue(rawUrl.lastmod);
      urls.push({
        loc,
        ...(lastmod ? { lastmod } : {}),
        imageUrls,
        alternates
      });
    }
    return { kind: "urlset", urls };
  }

  throw new Error(
    `Unexpected XML root in "${source}": expected <sitemapindex> or <urlset>, found <${rootKey}>.`
  );
}
