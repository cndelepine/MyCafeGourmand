const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  deg: "°",
  eacute: "é",
  egrave: "è",
  ellip: "…",
  emdash: "—",
  ensp: " ",
  endash: "–",
  euro: "€",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  quot: "\"",
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  thinsp: " ",
  trade: "™",
  zwnj: "",
  zwj: ""
};

const blockElements = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul"
]);

const lineBreakElements = new Set(["br", "wbr"]);
const unsupportedTextlessElements = new Set(["noscript", "script", "style", "template"]);
const voidElements = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

export type WprmRichTextNormalizationCode =
  | "rich-text-normalization-limit"
  | "malformed-wprm-rich-text";

export class WprmRichTextNormalizationError extends Error {
  readonly code: WprmRichTextNormalizationCode;

  constructor(code: WprmRichTextNormalizationCode) {
    super("Unable to normalize WPRM rich text.");
    this.name = "WprmRichTextNormalizationError";
    this.code = code;
  }
}

export type WprmRichTextNormalizationOptions = {
  readonly maxInputBytes: number;
  readonly maxOutputBytes?: number;
  readonly maxTokens?: number;
};

type HtmlToken =
  | {
    readonly end: number;
    readonly kind: "comment";
  }
  | {
    readonly end: number;
    readonly kind: "cdata";
    readonly text: string;
  }
  | {
    readonly closing: boolean;
    readonly end: number;
    readonly kind: "tag";
    readonly name: string;
    readonly selfClosing: boolean;
  };

function fail(code: WprmRichTextNormalizationCode): never {
  throw new WprmRichTextNormalizationError(code);
}

function validLimit(value: number | undefined, fallback: number) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    fail("rich-text-normalization-limit");
  }
  return resolved;
}

function isControlCharacter(value: string) {
  const code = value.codePointAt(0);
  return code !== undefined
    && code < 0x20
    && value !== "\t"
    && value !== "\n"
    && value !== "\r";
}

function decodeEntity(value: string) {
  if (value.startsWith("#")) {
    const hexadecimal = value.startsWith("#x") || value.startsWith("#X");
    const digits = value.slice(hexadecimal ? 2 : 1);
    if (
      digits.length === 0
      || !new RegExp(`^[0-9${hexadecimal ? "a-fA-F" : ""}]+$`, "u").test(digits)
    ) {
      fail("malformed-wprm-rich-text");
    }
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (
      !Number.isSafeInteger(codePoint)
      || codePoint === 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      fail("malformed-wprm-rich-text");
    }
    return String.fromCodePoint(codePoint);
  }
  const decoded = namedEntities[value];
  if (decoded === undefined) {
    fail("malformed-wprm-rich-text");
  }
  return decoded;
}

function decodeText(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index]!;
    if (current !== "&") {
      result += current;
      continue;
    }
    const delimiter = value.indexOf(";", index + 1);
    if (delimiter === -1 || delimiter - index > 64) {
      result += current;
      continue;
    }
    const entity = value.slice(index + 1, delimiter);
    if (!/^(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+)$/u.test(entity)) {
      result += current;
      continue;
    }
    result += decodeEntity(entity);
    index = delimiter;
  }
  return result;
}

function tagAt(value: string, start: number): HtmlToken {
  const first = value[start + 1];
  if (first === undefined) {
    fail("malformed-wprm-rich-text");
  }
  if (value.startsWith("<!--", start)) {
    const end = value.indexOf("-->", start + 4);
    if (end === -1) {
      fail("malformed-wprm-rich-text");
    }
    return { end: end + 3, kind: "comment" };
  }
  if (value.startsWith("<![CDATA[", start)) {
    const end = value.indexOf("]]>", start + 9);
    if (end === -1) {
      fail("malformed-wprm-rich-text");
    }
    return {
      end: end + 3,
      kind: "cdata",
      text: value.slice(start + 9, end)
    };
  }
  if (first === "!" || first === "?") {
    fail("malformed-wprm-rich-text");
  }

  let index = start + 1;
  let closing = false;
  if (value[index] === "/") {
    closing = true;
    index += 1;
  }
  const nameStart = index;
  while (index < value.length && /[A-Za-z0-9:-]/u.test(value[index]!)) {
    index += 1;
  }
  const name = value.slice(nameStart, index);
  if (!/^[A-Za-z][A-Za-z0-9:-]*$/u.test(name)) {
    fail("malformed-wprm-rich-text");
  }

  let quote: "\"" | "'" | null = null;
  let lastNonWhitespace = "";
  for (; index < value.length; index += 1) {
    const current = value[index]!;
    if (isControlCharacter(current)) {
      fail("malformed-wprm-rich-text");
    }
    if (quote !== null) {
      if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
      continue;
    }
    if (current === "<") {
      fail("malformed-wprm-rich-text");
    }
    if (current === ">") {
      if (closing && lastNonWhitespace.length > 0) {
        fail("malformed-wprm-rich-text");
      }
      return {
        closing,
        end: index + 1,
        kind: "tag",
        name: name.toLowerCase(),
        selfClosing: !closing && lastNonWhitespace === "/"
      };
    }
    if (!/\s/u.test(current)) {
      lastNonWhitespace = current;
    }
  }
  fail("malformed-wprm-rich-text");
}

function normalizeWhitespace(value: string) {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v \u00a0]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function normalizeWprmRichText(
  value: string | null,
  options: WprmRichTextNormalizationOptions
) {
  if (value === null || value.length === 0) {
    return null;
  }
  const maxInputBytes = validLimit(options.maxInputBytes, 1_048_576);
  const maxOutputBytes = validLimit(options.maxOutputBytes, maxInputBytes);
  const maxTokens = validLimit(options.maxTokens, 100_000);
  if (Buffer.byteLength(value, "utf8") > maxInputBytes) {
    fail("rich-text-normalization-limit");
  }

  const text: string[] = [];
  let outputBytes = 0;
  let tokens = 0;
  const appendText = (input: string) => {
    if (input.length === 0) {
      return;
    }
    const decoded = decodeText(input);
    for (const character of decoded) {
      if (isControlCharacter(character)) {
        fail("malformed-wprm-rich-text");
      }
    }
    outputBytes += Buffer.byteLength(decoded, "utf8");
    if (outputBytes > maxOutputBytes) {
      fail("rich-text-normalization-limit");
    }
    text.push(decoded);
  };
  const appendBreak = (value: string) => {
    text.push(value);
  };

  let textStart = 0;
  let index = 0;
  const openTags: string[] = [];
  while (index < value.length) {
    if (value[index] !== "<") {
      index += 1;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined || !/[A-Za-z!/?]/u.test(next)) {
      index += 1;
      continue;
    }
    appendText(value.slice(textStart, index));
    const token = tagAt(value, index);
    tokens += 1;
    if (tokens > maxTokens) {
      fail("rich-text-normalization-limit");
    }
    if (token.kind === "cdata") {
      appendText(token.text);
    } else if (token.kind === "tag") {
      if (unsupportedTextlessElements.has(token.name)) {
        fail("malformed-wprm-rich-text");
      }
      if (token.closing) {
        if (voidElements.has(token.name) || openTags.pop() !== token.name) {
          fail("malformed-wprm-rich-text");
        }
      } else if (!voidElements.has(token.name) && !token.selfClosing) {
        openTags.push(token.name);
      }
      if (blockElements.has(token.name)) {
        appendBreak("\n\n");
      } else if (lineBreakElements.has(token.name)) {
        appendBreak("\n");
      }
    }
    index = token.end;
    textStart = index;
  }
  appendText(value.slice(textStart));
  if (openTags.length > 0) {
    fail("malformed-wprm-rich-text");
  }
  const normalized = normalizeWhitespace(text.join(""));
  if (normalized.length === 0) {
    return null;
  }
  if (Buffer.byteLength(normalized, "utf8") > maxOutputBytes) {
    fail("rich-text-normalization-limit");
  }
  return normalized;
}

export function containsRenderableHtmlMarkup(value: string) {
  return /(?:<!--|<\s*\/?\s*[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*)?\/?\s*>)/u.test(value);
}

export type WprmDescriptionNormalizationCode = WprmRichTextNormalizationCode;
export type WprmDescriptionNormalizationOptions = WprmRichTextNormalizationOptions;
export const normalizeWprmDescription = normalizeWprmRichText;
export const WprmDescriptionNormalizationError = WprmRichTextNormalizationError;
