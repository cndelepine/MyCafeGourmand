type JsonPathPart = number | string;

export type JsonBoundaryOptions = {
  maxDepth: number;
};

function describeKey(value: string) {
  const serialized = JSON.stringify(value);
  return serialized.length <= 120
    ? serialized
    : `${JSON.stringify(Array.from(value).slice(0, 80).join(""))}…`;
}

function formatPath(parts: readonly JsonPathPart[]) {
  return parts.reduce<string>(
    (result, part) => typeof part === "number"
      ? `${result}[${part}]`
      : `${result}[${JSON.stringify(part)}]`,
    "$"
  );
}

class JsonBoundaryScanner {
  private index = 0;

  constructor(
    private readonly input: string,
    private readonly options: JsonBoundaryOptions
  ) {}

  scan() {
    if (!Number.isSafeInteger(this.options.maxDepth) || this.options.maxDepth < 1) {
      throw new Error("JSON maximum depth must be a positive safe integer.");
    }

    this.skipWhitespace();
    this.parseValue(0, []);
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      this.fail("Unexpected trailing JSON content");
    }
  }

  private fail(message: string): never {
    throw new Error(`${message} at character ${this.index}.`);
  }

  private current() {
    return this.input[this.index];
  }

  private skipWhitespace() {
    while (
      this.current() === " "
      || this.current() === "\t"
      || this.current() === "\n"
      || this.current() === "\r"
    ) {
      this.index += 1;
    }
  }

  private parseValue(depth: number, path: readonly JsonPathPart[]) {
    const current = this.current();
    if (current === "{") {
      this.parseObject(depth + 1, path);
      return;
    }
    if (current === "[") {
      this.parseArray(depth + 1, path);
      return;
    }
    if (current === "\"") {
      this.parseString();
      return;
    }
    if (current === "t") {
      this.parseLiteral("true");
      return;
    }
    if (current === "f") {
      this.parseLiteral("false");
      return;
    }
    if (current === "n") {
      this.parseLiteral("null");
      return;
    }
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) {
      this.parseNumber();
      return;
    }
    this.fail("Expected a JSON value");
  }

  private assertDepth(depth: number) {
    if (depth > this.options.maxDepth) {
      this.fail(`JSON nesting exceeds the maximum depth of ${this.options.maxDepth}`);
    }
  }

  private parseObject(depth: number, path: readonly JsonPathPart[]) {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    if (this.current() === "}") {
      this.index += 1;
      return;
    }

    const keys = new Set<string>();
    while (true) {
      if (this.current() !== "\"") {
        this.fail("Expected a JSON object key");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.fail(
          `Duplicate JSON object key ${describeKey(key)} in ${formatPath(path)}`
        );
      }
      keys.add(key);

      this.skipWhitespace();
      if (this.current() !== ":") {
        this.fail("Expected ':' after a JSON object key");
      }
      this.index += 1;
      this.skipWhitespace();
      this.parseValue(depth, [...path, key]);
      this.skipWhitespace();

      if (this.current() === "}") {
        this.index += 1;
        return;
      }
      if (this.current() !== ",") {
        this.fail("Expected ',' or '}' in a JSON object");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number, path: readonly JsonPathPart[]) {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    if (this.current() === "]") {
      this.index += 1;
      return;
    }

    let itemIndex = 0;
    while (true) {
      this.parseValue(depth, [...path, itemIndex]);
      itemIndex += 1;
      this.skipWhitespace();
      if (this.current() === "]") {
        this.index += 1;
        return;
      }
      if (this.current() !== ",") {
        this.fail("Expected ',' or ']' in a JSON array");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString() {
    const start = this.index;
    this.index += 1;

    while (this.index < this.input.length) {
      const current = this.current();
      if (current === "\"") {
        this.index += 1;
        return JSON.parse(this.input.slice(start, this.index)) as string;
      }
      if (current === "\\") {
        this.index += 1;
        const escape = this.current();
        if (
          escape === "\""
          || escape === "\\"
          || escape === "/"
          || escape === "b"
          || escape === "f"
          || escape === "n"
          || escape === "r"
          || escape === "t"
        ) {
          this.index += 1;
          continue;
        }
        if (escape === "u") {
          const digits = this.input.slice(this.index + 1, this.index + 5);
          if (digits.length !== 4 || !/^[0-9a-f]{4}$/iu.test(digits)) {
            this.fail("Invalid Unicode escape in JSON string");
          }
          this.index += 5;
          continue;
        }
        this.fail("Invalid escape in JSON string");
      }
      if (current !== undefined && current.charCodeAt(0) < 0x20) {
        this.fail("Unescaped control character in JSON string");
      }
      this.index += 1;
    }

    this.fail("Unterminated JSON string");
  }

  private parseLiteral(literal: "false" | "null" | "true") {
    if (this.input.slice(this.index, this.index + literal.length) !== literal) {
      this.fail(`Invalid JSON literal; expected '${literal}'`);
    }
    this.index += literal.length;
  }

  private parseNumber() {
    if (this.current() === "-") {
      this.index += 1;
    }

    if (this.current() === "0") {
      this.index += 1;
      if (this.isDigit(this.current())) {
        this.fail("JSON numbers cannot contain leading zeroes");
      }
    } else if (this.isNonZeroDigit(this.current())) {
      do {
        this.index += 1;
      } while (this.isDigit(this.current()));
    } else {
      this.fail("Invalid integer part in JSON number");
    }

    if (this.current() === ".") {
      this.index += 1;
      if (!this.isDigit(this.current())) {
        this.fail("JSON number fraction requires a digit");
      }
      do {
        this.index += 1;
      } while (this.isDigit(this.current()));
    }

    if (this.current() === "e" || this.current() === "E") {
      this.index += 1;
      if (this.current() === "+" || this.current() === "-") {
        this.index += 1;
      }
      if (!this.isDigit(this.current())) {
        this.fail("JSON number exponent requires a digit");
      }
      do {
        this.index += 1;
      } while (this.isDigit(this.current()));
    }
  }

  private isDigit(value: string | undefined): value is string {
    return value !== undefined && value >= "0" && value <= "9";
  }

  private isNonZeroDigit(value: string | undefined): value is string {
    return value !== undefined && value >= "1" && value <= "9";
  }
}

export function parseJsonAtBoundary(
  input: string,
  options: JsonBoundaryOptions
): unknown {
  new JsonBoundaryScanner(input, options).scan();
  return JSON.parse(input) as unknown;
}
