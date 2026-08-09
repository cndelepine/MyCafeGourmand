import assert from "node:assert/strict";
import test from "node:test";
import { SqlStatementScanner } from "../scripts/wordpress/sql-stream";

function scanChunks(chunks: readonly string[]) {
  const scanner = new SqlStatementScanner(4096);
  const statements: string[] = [];
  for (const chunk of chunks) {
    statements.push(...scanner.feed(chunk));
  }
  statements.push(...scanner.finish());
  return statements;
}

const delimiterCases = [
  {
    name: "doubled quotes",
    input: "SELECT 'a'';b';",
    expected: ["SELECT 'a'';b'"]
  },
  {
    name: "line comment",
    input: "SELECT 1 -- comment; still\nSELECT 2;",
    expected: ["SELECT 1 -- comment; still\nSELECT 2"]
  },
  {
    name: "block comment",
    input: "/* comment; */SELECT 'x';",
    expected: ["/* comment; */SELECT 'x'"]
  }
] as const;

for (const delimiterCase of delimiterCases) {
  test(`SQL scanner handles ${delimiterCase.name} in one-byte chunks`, () => {
    const chunks = [...delimiterCase.input].map((character) => character);
    assert.deepEqual(scanChunks(chunks), delimiterCase.expected);
  });

  test(`SQL scanner handles every ${delimiterCase.name} split boundary`, () => {
    for (let split = 1; split < delimiterCase.input.length; split += 1) {
      assert.deepEqual(
        scanChunks([
          delimiterCase.input.slice(0, split),
          delimiterCase.input.slice(split)
        ]),
        delimiterCase.expected,
        `split ${split}`
      );
    }
  });
}
