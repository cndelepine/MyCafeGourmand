export interface PhpArray {
  [key: string]: PhpValue;
}

export type PhpValue =
  | null
  | boolean
  | number
  | string
  | PhpArray;

export function parsePhpSerialized(input: string): PhpValue {
  let position = 0;

  function readUntil(token: string) {
    const end = input.indexOf(token, position);
    if (end === -1) {
      throw new Error("Unexpected end of serialized value.");
    }
    const result = input.slice(position, end);
    position = end + token.length;
    return result;
  }

  function readUtf8String(byteLength: number) {
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
      throw new Error("Invalid serialized UTF-8 string length.");
    }
    return input.slice(start, position);
  }

  function parseValue(): PhpValue {
    const type = input[position++];

    if (type === "N") {
      if (input[position++] !== ";") {
        throw new Error("Invalid serialized null.");
      }
      return null;
    }
    if (input[position++] !== ":") {
      throw new Error("Invalid serialized value.");
    }

    if (type === "s") {
      const length = Number(readUntil(":"));
      if (!Number.isInteger(length) || length < 0 || input[position++] !== "\"") {
        throw new Error("Invalid serialized string.");
      }
      const result = readUtf8String(length);
      if (input.slice(position, position + 2) !== "\";") {
        throw new Error("Invalid serialized string terminator.");
      }
      position += 2;
      return result;
    }

    if (type === "i" || type === "d") {
      const value = Number(readUntil(";"));
      if (!Number.isFinite(value)) {
        throw new Error("Invalid serialized number.");
      }
      return value;
    }

    if (type === "b") {
      const value = readUntil(";");
      if (value !== "0" && value !== "1") {
        throw new Error("Invalid serialized boolean.");
      }
      return value === "1";
    }

    if (type === "a") {
      const length = Number(readUntil(":"));
      if (!Number.isInteger(length) || length < 0 || input[position++] !== "{") {
        throw new Error("Invalid serialized array.");
      }

      const result: Record<string, PhpValue> = {};
      for (let index = 0; index < length; index += 1) {
        const key = parseValue();
        if (typeof key !== "string" && typeof key !== "number") {
          throw new Error("Serialized array keys must be strings or numbers.");
        }
        result[String(key)] = parseValue();
      }
      if (input[position++] !== "}") {
        throw new Error("Invalid serialized array terminator.");
      }
      return result;
    }

    throw new Error(`Unsupported serialized type: ${type ?? "end of input"}`);
  }

  const value = parseValue();
  if (position !== input.length) {
    throw new Error("Unexpected trailing serialized data.");
  }
  return value;
}
