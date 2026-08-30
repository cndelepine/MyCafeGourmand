import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import {
  publicContentLimits,
  richTextBlockSchema,
  type RichTextBlock
} from "../../src/content/editorial-schema";

type HtmlChildNode = DefaultTreeAdapterMap["childNode"];
type HtmlCommentNode = DefaultTreeAdapterMap["commentNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type HtmlTextNode = DefaultTreeAdapterMap["textNode"];
type LeafInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "break" };
type StyledInline = {
  readonly type: "emphasis" | "strong";
  readonly children: readonly LeafInline[];
};
type LinkChild = LeafInline | StyledInline;
type LinkInline = {
  readonly type: "link";
  readonly href: string;
  readonly children: readonly LinkChild[];
};
type MappedInline = LeafInline | StyledInline | LinkInline;
type MappedImageBlock = {
  readonly type: "image";
  readonly mediaId: string;
  readonly alt: string | null;
  readonly caption: string | null;
};

const inlineTags = new Set([
  "a",
  "b",
  "br",
  "code",
  "em",
  "i",
  "span",
  "strong"
]);
const blockWrapperTags = new Set(["div"]);
const blockCommentNames = new Set(["heading", "list", "paragraph", "shortcode"]);
const maxHtmlDepth = 32;
const maxHtmlNodes = 10_000;
const maxShortcodeAttributes = 32;
const maxShortcodeValueLength = 4_096;
const voidTags = new Set(["br", "img"]);

export type WordPressShortcode = {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
};

export type WordPressImage = {
  readonly alt: string | null;
  readonly classNames: readonly string[];
  readonly source: string;
};

export type WordPressHtmlMappingContext = {
  readonly mapImage: (image: WordPressImage) => {
    readonly alt: string | null;
    readonly mediaId: string;
  };
  readonly mapLink: (href: string) => string;
  readonly mapShortcode: (shortcode: WordPressShortcode) => RichTextBlock | null;
  readonly mapTwBwgBlock: () => RichTextBlock;
  readonly maxBlocks?: number;
};

export class EditorialHtmlMappingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("The WordPress editorial HTML could not be mapped safely.");
    this.name = "EditorialHtmlMappingError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new EditorialHtmlMappingError(code);
}

function isTextNode(node: HtmlChildNode): node is HtmlTextNode {
  return node.nodeName === "#text";
}

function isCommentNode(node: HtmlChildNode): node is HtmlCommentNode {
  return node.nodeName === "#comment";
}

function isElement(node: HtmlChildNode): node is HtmlElement {
  return !isTextNode(node)
    && !isCommentNode(node)
    && node.nodeName !== "#documentType";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function elementAttributes(element: HtmlElement, allowed: ReadonlySet<string>) {
  const values = new Map<string, string>();
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    if (!allowed.has(name) || values.has(name)) {
      fail("unsupported-html-attribute");
    }
    values.set(name, attribute.value);
  }
  return values;
}

function isWhitespace(value: string) {
  return /^\s*$/u.test(value);
}

function parseShortcodeAt(value: string, start: number) {
  let offset = start + 1;
  if (value[offset] === "/") {
    fail("unsupported-shortcode-closing-tag");
  }
  const nameMatch = value.slice(offset).match(/^[A-Za-z][A-Za-z0-9_-]*/u);
  if (nameMatch === null) {
    fail("malformed-shortcode");
  }
  const name = nameMatch[0]!;
  offset += nameMatch[0]!.length;
  const attributes = new Map<string, string>();

  while (offset < value.length) {
    while (/\s/u.test(value[offset] ?? "")) {
      offset += 1;
    }
    if (value[offset] === "]") {
      return {
        end: offset + 1,
        shortcode: { name, attributes } satisfies WordPressShortcode
      };
    }
    if (value[offset] === "/") {
      offset += 1;
      while (/\s/u.test(value[offset] ?? "")) {
        offset += 1;
      }
      if (value[offset] !== "]") {
        fail("malformed-shortcode");
      }
      return {
        end: offset + 1,
        shortcode: { name, attributes } satisfies WordPressShortcode
      };
    }
    if (attributes.size >= maxShortcodeAttributes) {
      fail("shortcode-attribute-limit");
    }
    const attributeMatch = value.slice(offset).match(/^[A-Za-z][A-Za-z0-9_-]*/u);
    if (attributeMatch === null) {
      fail("malformed-shortcode");
    }
    const attributeName = attributeMatch[0]!.toLowerCase();
    offset += attributeMatch[0]!.length;
    while (/\s/u.test(value[offset] ?? "")) {
      offset += 1;
    }
    if (value[offset] !== "=" || attributes.has(attributeName)) {
      fail("malformed-shortcode");
    }
    offset += 1;
    while (/\s/u.test(value[offset] ?? "")) {
      offset += 1;
    }
    const quote = value[offset];
    let attributeValue: string;
    if (quote === "\"" || quote === "'") {
      offset += 1;
      const valueStart = offset;
      while (offset < value.length && value[offset] !== quote) {
        if (value[offset] === "[" || value[offset] === "]") {
          fail("malformed-shortcode");
        }
        offset += 1;
      }
      if (value[offset] !== quote) {
        fail("malformed-shortcode");
      }
      attributeValue = value.slice(valueStart, offset);
      offset += 1;
    } else {
      const valueStart = offset;
      while (
        offset < value.length
        && !/\s/u.test(value[offset] ?? "")
        && value[offset] !== "]"
        && value[offset] !== "/"
      ) {
        offset += 1;
      }
      attributeValue = value.slice(valueStart, offset);
      if (attributeValue.length === 0) {
        fail("malformed-shortcode");
      }
    }
    if (
      attributeValue.length > maxShortcodeValueLength
      || /[\u0000-\u001f\u007f]/u.test(attributeValue)
    ) {
      fail("malformed-shortcode");
    }
    attributes.set(attributeName, attributeValue);
  }
  fail("malformed-shortcode");
}

type TextToken =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "shortcode"; readonly shortcode: WordPressShortcode };

function tokenizeText(value: string): TextToken[] {
  const tokens: TextToken[] = [];
  let offset = 0;
  while (offset < value.length) {
    const start = value.indexOf("[", offset);
    if (start === -1) {
      if (offset < value.length) {
        tokens.push({ type: "text", value: value.slice(offset) });
      }
      break;
    }
    if (start > offset) {
      tokens.push({ type: "text", value: value.slice(offset, start) });
    }
    const parsed = parseShortcodeAt(value, start);
    tokens.push(parsed.shortcode.name === parsed.shortcode.name.toLowerCase()
      ? { type: "shortcode", shortcode: parsed.shortcode }
      : { type: "text", value: value.slice(start, parsed.end) });
    offset = parsed.end;
  }
  return tokens;
}

type ParsedBlockComment =
  | { readonly kind: "close"; readonly name: string }
  | { readonly kind: "open"; readonly name: string }
  | { readonly kind: "tw-bwg" };

function parseBlockComment(value: string): ParsedBlockComment {
  const trimmed = value.trim();
  const closing = trimmed.match(/^\/wp:([A-Za-z0-9_/-]+)\s*$/u);
  if (closing !== null) {
    const name = closing[1]!.toLowerCase();
    if (!blockCommentNames.has(name)) {
      fail("unsupported-wordpress-block");
    }
    return { kind: "close", name };
  }
  const opening = trimmed.match(/^wp:([A-Za-z0-9_/-]+)(?<rest>[\s\S]*)$/u);
  if (opening === null) {
    fail("unsupported-html-comment");
  }
  const name = opening[1]!.toLowerCase();
  const rest = opening.groups?.rest?.trim() ?? "";
  if (name === "tw/bwg") {
    if (!rest.endsWith("/")) {
      fail("malformed-wordpress-block");
    }
    const attributeJson = rest.slice(0, -1).trim();
    let attributes: unknown;
    try {
      attributes = JSON.parse(attributeJson) as unknown;
    } catch {
      fail("malformed-wordpress-block");
    }
    if (
      !isRecord(attributes)
      || Object.keys(attributes).length !== 2
      || !Object.prototype.hasOwnProperty.call(attributes, "notInitial")
      || !Object.prototype.hasOwnProperty.call(attributes, "popupOpened")
      || typeof attributes.notInitial !== "boolean"
      || typeof attributes.popupOpened !== "boolean"
    ) {
      fail("unsupported-wordpress-block");
    }
    return { kind: "tw-bwg" };
  }
  if (!blockCommentNames.has(name)) {
    fail("unsupported-wordpress-block");
  }
  if (rest.length > 0) {
    let attributes: unknown;
    try {
      attributes = JSON.parse(rest) as unknown;
    } catch {
      fail("malformed-wordpress-block");
    }
    if (
      !isRecord(attributes)
      || (
        name === "heading"
        && (
          Object.keys(attributes).length !== 1
          || typeof attributes.level !== "number"
          || !Number.isInteger(attributes.level)
          || attributes.level < 1
          || attributes.level > 6
        )
      )
      || (
        name === "list"
        && (
          Object.keys(attributes).length !== 1
          || typeof attributes.ordered !== "boolean"
        )
      )
      || (name !== "heading" && name !== "list")
    ) {
      fail("unsupported-wordpress-block");
    }
  }
  return { kind: "open", name };
}

function visitComments(nodes: readonly HtmlChildNode[]) {
  const stack: string[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (isCommentNode(node)) {
      const comment = parseBlockComment(node.data);
      if (comment.kind === "open") {
        stack.push(comment.name);
      } else if (comment.kind === "close") {
        if (stack.pop() !== comment.name) {
          fail("malformed-wordpress-block");
        }
      }
    }
    if (isElement(node)) {
      pending.push(...[...node.childNodes].reverse());
    }
  }
  if (stack.length > 0) {
    fail("malformed-wordpress-block");
  }
}

function assertTreeBounds(nodes: readonly HtmlChildNode[]) {
  let count = 0;
  const pending = nodes.map((node) => ({ node, depth: 1 }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    count += 1;
    if (count > maxHtmlNodes || current.depth > maxHtmlDepth) {
      fail("html-structure-limit");
    }
    if (isElement(current.node)) {
      if (
        !voidTags.has(current.node.tagName)
        && current.node.sourceCodeLocation?.endTag === undefined
      ) {
        fail("malformed-html");
      }
      for (const child of current.node.childNodes) {
        pending.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
}

function parseHtml(value: string) {
  if (Buffer.byteLength(value, "utf8") > publicContentLimits.maxFileBytes) {
    fail("html-input-limit");
  }
  const parseErrors: string[] = [];
  const fragment = parseFragment(value, {
    sourceCodeLocationInfo: true,
    onParseError: () => {
      parseErrors.push("parse-error");
    }
  });
  if (parseErrors.length > 0) {
    fail("malformed-html");
  }
  assertTreeBounds(fragment.childNodes);
  visitComments(fragment.childNodes);
  return fragment;
}

function textInline(value: string): Array<Extract<LeafInline, { type: "text" }>> {
  return value.length === 0 ? [] : [{ type: "text", value }];
}

function nonEmptyInline<T>(children: T[]) {
  if (children.length === 0) {
    fail("empty-rich-text-node");
  }
  if (children.length > publicContentLimits.maxInlineChildren) {
    fail("inline-child-limit");
  }
  return children;
}

function leafChildren(
  nodes: readonly HtmlChildNode[]
) {
  const children: LeafInline[] = [];
  for (const node of nodes) {
    if (isCommentNode(node)) {
      continue;
    }
    if (isTextNode(node)) {
      for (const token of tokenizeText(node.value)) {
        if (token.type === "shortcode") {
          fail("shortcode-inline-context");
        }
        children.push(...textInline(token.value));
      }
      continue;
    }
    if (!isElement(node)) {
      fail("unsupported-html-node");
    }
    if (node.tagName === "br") {
      elementAttributes(node, new Set());
      children.push({ type: "break" });
      continue;
    }
    if (node.tagName === "code") {
      elementAttributes(node, new Set());
      const value = codeText(node.childNodes);
      children.push({ type: "code", value });
      continue;
    }
    fail("unsupported-inline-nesting");
  }
  return nonEmptyInline(children);
}

function codeText(nodes: readonly HtmlChildNode[]) {
  let value = "";
  for (const node of nodes) {
    if (isCommentNode(node)) {
      continue;
    }
    if (!isTextNode(node)) {
      fail("unsupported-code-markup");
    }
    value += node.value;
  }
  if (value.length === 0) {
    fail("empty-rich-text-node");
  }
  return value;
}

function inlineChildren(
  nodes: readonly HtmlChildNode[],
  context: WordPressHtmlMappingContext,
  insideLink = false
): MappedInline[] {
  const children: MappedInline[] = [];
  for (const node of nodes) {
    if (isCommentNode(node)) {
      continue;
    }
    if (isTextNode(node)) {
      for (const token of tokenizeText(node.value)) {
        if (token.type === "shortcode") {
          fail("shortcode-inline-context");
        }
        children.push(...textInline(token.value));
      }
      continue;
    }
    if (!isElement(node)) {
      fail("unsupported-html-node");
    }
    const tagName = node.tagName;
    if (!inlineTags.has(tagName)) {
      fail("unsupported-html-tag");
    }
    if (tagName === "span") {
      elementAttributes(node, new Set([
        "aria-haspopup",
        "class",
        "data-g-spell-status",
        "id",
        "role",
        "tabindex"
      ]));
      if (node.childNodes.every((child) =>
        isCommentNode(child) || (isTextNode(child) && child.value.length === 0)
      )) {
        continue;
      }
      children.push(...inlineChildren(node.childNodes, context, insideLink));
      continue;
    }
    if (tagName === "br") {
      elementAttributes(node, new Set());
      children.push({ type: "break" });
      continue;
    }
    if (tagName === "code") {
      elementAttributes(node, new Set());
      children.push({ type: "code", value: codeText(node.childNodes) });
      continue;
    }
    if (tagName === "a") {
      if (insideLink) {
        fail("nested-link");
      }
      const attributes = elementAttributes(node, new Set(["href", "rel", "target"]));
      const href = attributes.get("href");
      if (href === undefined || href.length === 0) {
        fail("malformed-link");
      }
      const linkChildren: LinkChild[] = [];
      for (const child of inlineChildren(node.childNodes, context, true)) {
        if (child.type === "link") {
          fail("nested-link");
        }
        linkChildren.push(child);
      }
      children.push({
        type: "link",
        href: context.mapLink(href),
        children: nonEmptyInline(linkChildren)
      });
      continue;
    }
    if (tagName === "strong" || tagName === "b") {
      elementAttributes(node, new Set());
      children.push({
        type: "strong",
        children: leafChildren(node.childNodes)
      });
      continue;
    }
    if (tagName === "em" || tagName === "i") {
      elementAttributes(node, new Set());
      children.push({
        type: "emphasis",
        children: leafChildren(node.childNodes)
      });
      continue;
    }
    fail("unsupported-html-tag");
  }
  return nonEmptyInline(children);
}

function blockShortcodes(
  nodes: readonly HtmlChildNode[],
  context: WordPressHtmlMappingContext
) {
  const shortcodes: WordPressShortcode[] = [];
  for (const node of nodes) {
    if (isCommentNode(node)) {
      continue;
    }
    if (!isTextNode(node)) {
      return null;
    }
    for (const token of tokenizeText(node.value)) {
      if (token.type === "text") {
        if (!isWhitespace(token.value)) {
          return null;
        }
      } else {
        if (shortcodes.length >= (context.maxBlocks ?? publicContentLimits.maxBlocks)) {
          fail("block-limit");
        }
        shortcodes.push(token.shortcode);
      }
    }
  }
  if (shortcodes.length === 0) {
    return null;
  }
  return shortcodes.flatMap((shortcode) => {
    const mapped = context.mapShortcode(shortcode);
    return mapped === null ? [] : [mapped];
  });
}

function imageBlock(
  element: HtmlElement,
  context: WordPressHtmlMappingContext
): MappedImageBlock {
  const attributes = elementAttributes(element, new Set([
    "alt",
    "class",
    "height",
    "src",
    "width"
  ]));
  const source = attributes.get("src");
  if (source === undefined || source.length === 0 || element.childNodes.length > 0) {
    fail("malformed-image");
  }
  const classNames = (attributes.get("class") ?? "")
    .split(/\s+/u)
    .filter((value) => value.length > 0);
  const image = context.mapImage({
    source,
    alt: attributes.get("alt") === undefined || attributes.get("alt") === ""
      ? null
      : attributes.get("alt")!,
    classNames
  });
  return {
    type: "image",
    mediaId: image.mediaId,
    alt: image.alt,
    caption: null
  };
}

function plainCaption(nodes: readonly HtmlChildNode[], context: WordPressHtmlMappingContext) {
  const children = inlineChildren(nodes, context);
  const inlineText = (child: MappedInline | LinkChild): string => {
    if (child.type === "text" || child.type === "code") {
      return child.value;
    }
    if (child.type === "break") {
      return "\n";
    }
    return child.children.map(inlineText).join("");
  };
  const text = children.map(inlineText).join("");
  return text.length === 0 ? null : text;
}

function figureBlock(
  element: HtmlElement,
  context: WordPressHtmlMappingContext
): MappedImageBlock {
  elementAttributes(element, new Set(["class"]));
  const meaningful = element.childNodes.filter((node) =>
    !isCommentNode(node) && (!isTextNode(node) || !isWhitespace(node.value))
  );
  const images = meaningful.filter(
    (node): node is HtmlElement => isElement(node) && node.tagName === "img"
  );
  if (images.length !== 1) {
    fail("malformed-image");
  }
  const image = images[0]!;
  const captions = meaningful.filter(
    (node): node is HtmlElement => isElement(node) && node.tagName === "figcaption"
  );
  if (
    meaningful.some((node) =>
      node !== image && (!isElement(node) || node.tagName !== "figcaption")
    )
    || captions.length > 1
  ) {
    fail("unsupported-figure-markup");
  }
  const mapped = imageBlock(image, context);
  const caption = captions[0];
  if (caption === undefined) {
    return mapped;
  }
  elementAttributes(caption, new Set(["class"]));
  return {
    ...mapped,
    caption: plainCaption(caption.childNodes, context)
  };
}

function listBlock(
  element: HtmlElement,
  context: WordPressHtmlMappingContext
): unknown {
  elementAttributes(element, new Set());
  const items = [];
  for (const child of element.childNodes) {
    if (isCommentNode(child) || (isTextNode(child) && isWhitespace(child.value))) {
      continue;
    }
    if (!isElement(child) || child.tagName !== "li") {
      fail("unsupported-list-markup");
    }
    elementAttributes(child, new Set());
    items.push({ children: inlineChildren(child.childNodes, context) });
  }
  if (items.length === 0 || items.length > publicContentLimits.maxListItems) {
    fail("list-item-limit");
  }
  return {
    type: "list",
    ordered: element.tagName === "ol",
    items
  };
}

function blockquoteBlock(
  element: HtmlElement,
  context: WordPressHtmlMappingContext
): unknown {
  elementAttributes(element, new Set());
  const children: unknown[] = [];
  for (const child of element.childNodes) {
    if (isCommentNode(child) || (isTextNode(child) && isWhitespace(child.value))) {
      continue;
    }
    if (!isElement(child)) {
      fail("unsupported-blockquote-markup");
    }
    if (child.tagName === "p") {
      elementAttributes(child, new Set());
      children.push({
        type: "paragraph",
        children: inlineChildren(child.childNodes, context)
      });
      continue;
    }
    if (child.tagName === "ul" || child.tagName === "ol") {
      children.push(listBlock(child, context));
      continue;
    }
    fail("unsupported-blockquote-markup");
  }
  if (children.length === 0) {
    fail("empty-rich-text-node");
  }
  return { type: "blockquote", children };
}

function mapElementBlocks(
  element: HtmlElement,
  context: WordPressHtmlMappingContext
): unknown[] {
  const tagName = element.tagName;
  if (tagName === "p") {
    elementAttributes(element, new Set());
    if (element.childNodes.every((child) =>
      isCommentNode(child) || (isTextNode(child) && child.value.length === 0)
    )) {
      return [];
    }
    const shortcodeBlocks = blockShortcodes(element.childNodes, context);
    if (shortcodeBlocks !== null) {
      return shortcodeBlocks;
    }
    return [{ type: "paragraph", children: inlineChildren(element.childNodes, context) }];
  }
  if (/^h[1-6]$/u.test(tagName)) {
    elementAttributes(element, new Set(["class", "id"]));
    const level = Number(tagName.slice(1));
    return [{ type: "heading", level, children: inlineChildren(element.childNodes, context) }];
  }
  if (tagName === "ul" || tagName === "ol") {
    return [listBlock(element, context)];
  }
  if (tagName === "blockquote") {
    return [blockquoteBlock(element, context)];
  }
  if (tagName === "img") {
    return [imageBlock(element, context)];
  }
  if (tagName === "figure") {
    return [figureBlock(element, context)];
  }
  if (blockWrapperTags.has(tagName)) {
    elementAttributes(element, new Set(["class", "id"]));
    return mapBlocks(element.childNodes, context);
  }
  if (inlineTags.has(tagName)) {
    return [{ type: "paragraph", children: inlineChildren([element], context) }];
  }
  fail("unsupported-html-tag");
}

function mapBlocks(
  nodes: readonly HtmlChildNode[],
  context: WordPressHtmlMappingContext
): unknown[] {
  const blocks: unknown[] = [];
  const maxBlocks = context.maxBlocks ?? publicContentLimits.maxBlocks;
  const push = (block: unknown) => {
    if (blocks.length >= maxBlocks) {
      fail("block-limit");
    }
    blocks.push(block);
  };
  for (const node of nodes) {
    if (isCommentNode(node)) {
      const comment = parseBlockComment(node.data);
      if (comment.kind === "tw-bwg") {
        push(context.mapTwBwgBlock());
      }
      continue;
    }
    if (isTextNode(node)) {
      const shortcodeBlocks = blockShortcodes([node], context);
      if (shortcodeBlocks !== null) {
        for (const block of shortcodeBlocks) {
          push(block);
        }
      } else if (!isWhitespace(node.value)) {
        let text = "";
        for (const token of tokenizeText(node.value)) {
          if (token.type === "text") {
            text += token.value;
            continue;
          }
          if (!isWhitespace(text)) {
            push({
              type: "paragraph",
              children: textInline(text)
            });
          }
          text = "";
          const mapped = context.mapShortcode(token.shortcode);
          if (mapped !== null) {
            push(mapped);
          }
        }
        if (!isWhitespace(text)) {
          push({
            type: "paragraph",
            children: textInline(text)
          });
        }
      }
      continue;
    }
    if (!isElement(node)) {
      fail("unsupported-html-node");
    }
    for (const block of mapElementBlocks(node, context)) {
      push(block);
    }
  }
  return blocks;
}

export function mapWordPressHtmlToSafeAst(
  value: string | null,
  context: WordPressHtmlMappingContext
) {
  if (value === null || value.length === 0) {
    return null;
  }
  const fragment = parseHtml(value);
  const blocks = mapBlocks(fragment.childNodes, context);
  if (blocks.length > (context.maxBlocks ?? publicContentLimits.maxBlocks)) {
    fail("block-limit");
  }
  if (blocks.length === 0) {
    return null;
  }
  const parsed = richTextBlockSchema.array()
    .max(context.maxBlocks ?? publicContentLimits.maxBlocks)
    .safeParse(blocks);
  if (!parsed.success) {
    fail("mapped-content-schema-invalid");
  }
  return parsed.data;
}

function collectPlainText(
  nodes: readonly HtmlChildNode[],
  blocks: string[]
) {
  for (const node of nodes) {
    if (isCommentNode(node)) {
      fail("unsupported-html-comment");
    }
    if (isTextNode(node)) {
      if (node.value.includes("[")) {
        fail("unsupported-shortcode");
      }
      blocks.push(node.value);
      continue;
    }
    if (!isElement(node)) {
      fail("unsupported-html-node");
    }
    if (node.tagName === "br") {
      elementAttributes(node, new Set());
      blocks.push("\n");
      continue;
    }
    if (
      !new Set([
        "a",
        "b",
        "blockquote",
        "code",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "i",
        "li",
        "ol",
        "p",
        "span",
        "strong",
        "ul"
      ]).has(node.tagName)
    ) {
      fail("unsupported-html-tag");
    }
    if (node.tagName === "a") {
      elementAttributes(node, new Set(["href", "rel", "target"]));
    } else if (node.tagName === "span") {
      elementAttributes(node, new Set([
        "aria-haspopup",
        "class",
        "data-g-spell-status",
        "id",
        "role",
        "tabindex"
      ]));
    } else if (/^h[1-6]$/u.test(node.tagName) || node.tagName === "div") {
      elementAttributes(node, new Set(["class", "id"]));
    } else {
      elementAttributes(node, new Set());
    }
    collectPlainText(node.childNodes, blocks);
    if (new Set(["blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ol", "p", "ul"])
      .has(node.tagName)) {
      blocks.push("\n");
    }
  }
}

export function decodeWordPressPlainText(value: string | null) {
  if (value === null || value.length === 0) {
    return null;
  }
  const fragment = parseHtml(value);
  const text: string[] = [];
  collectPlainText(fragment.childNodes, text);
  const result = text.join("").trim();
  return result.length === 0 ? null : result;
}
