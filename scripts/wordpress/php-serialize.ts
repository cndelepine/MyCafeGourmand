export interface PhpArray {
  [key: string]: PhpValue;
}

export type PhpValue =
  | null
  | boolean
  | number
  | string
  | PhpArray;

export interface PhpSerializationLimits {
  readonly maxInputBytes: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxStringBytes: number;
  readonly rejectDuplicateKeys?: boolean;
}

export class PhpSerializationError extends Error {
  readonly code:
    | "malformed"
    | "depth-limit"
    | "entry-limit"
    | "string-limit"
    | "unsupported-type";

  constructor(
    code: PhpSerializationError["code"],
    message: string
  ) {
    super(message);
    this.name = "PhpSerializationError";
    this.code = code;
  }
}

const unboundedPhpSerializationLimits: PhpSerializationLimits = {
  maxInputBytes: Number.MAX_SAFE_INTEGER,
  maxDepth: Number.MAX_SAFE_INTEGER,
  maxEntries: Number.MAX_SAFE_INTEGER,
  maxStringBytes: Number.MAX_SAFE_INTEGER,
  rejectDuplicateKeys: false
};

function mergedLimits(input: Partial<PhpSerializationLimits> | undefined) {
  const limits = {
    ...unboundedPhpSerializationLimits,
    ...input
  };
  for (const value of [
    limits.maxInputBytes,
    limits.maxDepth,
    limits.maxEntries,
    limits.maxStringBytes
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PhpSerializationError(
        "malformed",
        "PHP serialization limits must be positive safe integers."
      );
    }
  }
  return limits;
}

export function parsePhpSerialized(
  input: string,
  inputLimits?: Partial<PhpSerializationLimits>
): PhpValue {
  const limits = mergedLimits(inputLimits);
  if (Buffer.byteLength(input, "utf8") > limits.maxInputBytes) {
    throw new PhpSerializationError(
      "string-limit",
      "The serialized PHP value exceeded its input safety limit."
    );
  }

  let position = 0;
  let entries = 0;

  function malformed(message: string): never {
    throw new PhpSerializationError("malformed", message);
  }

  function readUntil(token: string) {
    const end = input.indexOf(token, position);
    if (end === -1) {
      malformed("Unexpected end of serialized value.");
    }
    const result = input.slice(position, end);
    position = end + token.length;
    return result;
  }

  function readUtf8String(byteLength: number) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      malformed("Invalid serialized string length.");
    }
    if (byteLength > limits.maxStringBytes) {
      throw new PhpSerializationError(
        "string-limit",
        "A serialized string exceeded its safety limit."
      );
    }

    const start = position;
    let bytes = 0;

    while (bytes < byteLength && position < input.length) {
      const point = input.codePointAt(position);
      if (point === undefined) {
        break;
      }
      const character = String.fromCodePoint(point);
      bytes += Buffer.byteLength(character, "utf8");
      position += character.length;
    }

    if (bytes !== byteLength) {
      malformed("Invalid serialized UTF-8 string length.");
    }
    return input.slice(start, position);
  }

  function parseValue(currentDepth: number): PhpValue {
    if (currentDepth > limits.maxDepth) {
      throw new PhpSerializationError(
        "depth-limit",
        "The serialized PHP value exceeded its depth safety limit."
      );
    }
    const type = input[position++];
    if (type === undefined) {
      malformed("Unexpected end of serialized value.");
    }

    if (type === "N") {
      if (input[position++] !== ";") {
        malformed("Invalid serialized null.");
      }
      return null;
    }
    if (input[position++] !== ":") {
      malformed("Invalid serialized value.");
    }

    if (type === "s") {
      const lengthText = readUntil(":");
      const length = Number(lengthText);
      if (
        !Number.isSafeInteger(length)
        || length < 0
        || input[position++] !== "\""
      ) {
        malformed("Invalid serialized string.");
      }
      const result = readUtf8String(length);
      if (input.slice(position, position + 2) !== "\";") {
        malformed("Invalid serialized string terminator.");
      }
      position += 2;
      return result;
    }

    if (type === "i" || type === "d") {
      const value = Number(readUntil(";"));
      if (!Number.isFinite(value)) {
        malformed("Invalid serialized number.");
      }
      return value;
    }

    if (type === "b") {
      const value = readUntil(";");
      if (value !== "0" && value !== "1") {
        malformed("Invalid serialized boolean.");
      }
      return value === "1";
    }

    if (type === "a") {
      const length = Number(readUntil(":"));
      if (
        !Number.isSafeInteger(length)
        || length < 0
        || input[position++] !== "{"
      ) {
        malformed("Invalid serialized array.");
      }

      const result: Record<string, PhpValue> = Object.create(null) as Record<
        string,
        PhpValue
      >;
      for (let index = 0; index < length; index += 1) {
        entries += 1;
        if (entries > limits.maxEntries) {
          throw new PhpSerializationError(
            "entry-limit",
            "The serialized PHP value exceeded its entry safety limit."
          );
        }
        const key = parseValue(currentDepth + 1);
        if (typeof key !== "string" && typeof key !== "number") {
          malformed("Serialized array keys must be strings or numbers.");
        }
        if (
          limits.rejectDuplicateKeys === true
          && Object.prototype.hasOwnProperty.call(result, String(key))
        ) {
          malformed("Serialized array keys must be unique.");
        }
        result[String(key)] = parseValue(currentDepth + 1);
      }
      if (input[position++] !== "}") {
        malformed("Invalid serialized array terminator.");
      }
      return result;
    }

    throw new PhpSerializationError(
      "unsupported-type",
      `Unsupported serialized type: ${type}.`
    );
  }

  const value = parseValue(1);
  if (position !== input.length) {
    malformed("Unexpected trailing serialized data.");
  }
  return value;
}
