import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { TextDecoder } from "node:util";
import { createGunzip } from "node:zlib";

export type SqlValue = string | null;

export interface SqlInsertRow {
  readonly [column: string]: SqlValue;
}

export interface SqlInsert {
  readonly table: string;
  readonly columns: readonly string[];
  readonly row: SqlInsertRow;
}

export interface SqlCreateTable {
  readonly table: string;
  readonly columns: readonly string[];
}

export interface SqlDumpHandlers {
  onInsert?: (insert: SqlInsert) => void;
  onCreateTable?: (table: SqlCreateTable) => void;
  getTableColumns?: (table: string) => readonly string[] | undefined;
}

export interface SqlDumpLimits {
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxStatementBytes: number;
  maxRows: number;
}

export interface SqlDumpStats {
  readonly format: "sql" | "gzip";
  readonly compressedBytes: number;
  readonly decompressedBytes: number;
  readonly sqlDecompressedSha256: string;
  readonly statements: number;
  readonly insertStatements: number;
  readonly rows: number;
  readonly createTables: number;
  readonly insertsByTable: Readonly<Record<string, {
    insertStatements: number;
    rows: number;
  }>>;
}

export const defaultSqlDumpLimits: SqlDumpLimits = {
  maxCompressedBytes: 128 * 1024 * 1024,
  maxDecompressedBytes: 512 * 1024 * 1024,
  maxStatementBytes: 16 * 1024 * 1024,
  maxRows: 2_000_000
};

export class SqlDumpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SqlDumpError";
    this.code = code;
  }
}

class ByteLimitTransform extends Transform {
  bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly code: string,
    private readonly description: string
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.bytes += buffer.byteLength;
    if (this.bytes > this.maxBytes) {
      callback(
        new SqlDumpError(
          this.code,
          `${this.description} exceeded the configured safety limit.`
        )
      );
      return;
    }
    callback(null, buffer);
  }
}

export class SqlStatementScanner {
  private buffer = "";
  private quote: "'" | '"' | "`" | null = null;
  private lineComment = false;
  private blockComment = false;
  private pendingSuffix = "";
  private statementBytes = 0;

  constructor(private readonly maxStatementBytes: number) {}

  private append(value: string) {
    this.buffer += value;
    this.statementBytes += Buffer.byteLength(value, "utf8");
    if (this.statementBytes > this.maxStatementBytes) {
      throw new SqlDumpError(
        "statement-limit",
        "A SQL statement exceeded the configured safety limit."
      );
    }
  }

  feed(input: string): string[] {
    const statements: string[] = [];
    const text = `${this.pendingSuffix}${input}`;
    this.pendingSuffix = "";

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index] ?? "";
      const next = text[index + 1] ?? "";
      if (this.lineComment) {
        this.append(character);
        if (character === "\n" || character === "\r") {
          this.lineComment = false;
        }
        continue;
      }

      if (this.blockComment) {
        if (character === "*" && !next) {
          this.pendingSuffix = character;
          break;
        }
        if (character === "*" && next === "/") {
          this.append(`${character}${next}`);
          index += 1;
          this.blockComment = false;
        } else {
          this.append(character);
        }
        continue;
      }

      if (this.quote !== null) {
        if (character === "\\") {
          if (!next) {
            this.pendingSuffix = character;
            break;
          }
          this.append(`${character}${next}`);
          index += 1;
          continue;
        }
        if (character === this.quote) {
          if (!next) {
            this.pendingSuffix = character;
            break;
          }
          if (next === this.quote) {
            this.append(`${character}${next}`);
            index += 1;
          } else {
            this.append(character);
            this.quote = null;
          }
        } else {
          this.append(character);
        }
        continue;
      }

      if (character === "'" || character === '"' || character === "`") {
        this.append(character);
        this.quote = character;
        continue;
      }
      if (character === "#") {
        this.append(character);
        this.lineComment = true;
        continue;
      }
      if (character === "-") {
        if (!next) {
          this.pendingSuffix = character;
          break;
        }
        if (next === "-") {
          const after = text[index + 2] ?? "";
          if (!after) {
            this.pendingSuffix = `${character}${next}`;
            break;
          }
          if (/\s/u.test(after)) {
            this.append(`${character}${next}`);
            index += 1;
            this.lineComment = true;
            continue;
          }
        }
        this.append(character);
        continue;
      }
      if (character === "/") {
        if (!next) {
          this.pendingSuffix = character;
          break;
        }
        if (next === "*") {
          this.append(`${character}${next}`);
          index += 1;
          this.blockComment = true;
          continue;
        }
        this.append(character);
        continue;
      }
      if (character === ";") {
        this.append(character);
        statements.push(this.buffer.slice(0, -1));
        this.buffer = "";
        this.statementBytes = 0;
        continue;
      }
      this.append(character);
    }

    return statements;
  }

  finish(): string[] {
    if (this.pendingSuffix) {
      if (this.quote !== null && this.pendingSuffix === "\\") {
        throw new SqlDumpError("malformed-sql", "The SQL dump ended inside a quoted value.");
      }
      if (this.quote !== null && this.pendingSuffix === this.quote) {
        this.append(this.pendingSuffix);
        this.quote = null;
      } else {
        this.append(this.pendingSuffix);
      }
      this.pendingSuffix = "";
    }
    if (this.quote !== null) {
      throw new SqlDumpError("malformed-sql", "The SQL dump ended inside a quoted value.");
    }
    if (this.blockComment) {
      throw new SqlDumpError("malformed-sql", "The SQL dump ended inside a comment.");
    }
    const trailing = this.buffer.trim();
    this.buffer = "";
    this.statementBytes = 0;
    return trailing ? [trailing] : [];
  }
}

class SqlCursor {
  position = 0;

  constructor(readonly input: string) {}

  skipWhitespace() {
    while (/\s/u.test(this.input[this.position] ?? "")) {
      this.position += 1;
    }
  }

  get current() {
    return this.input[this.position] ?? "";
  }

  readKeyword() {
    this.skipWhitespace();
    const start = this.position;
    while (/[A-Za-z0-9_$-]/u.test(this.input[this.position] ?? "")) {
      this.position += 1;
    }
    if (this.position === start) {
      throw new SqlDumpError("malformed-sql", "A SQL keyword was expected.");
    }
    return this.input.slice(start, this.position);
  }

  expectKeyword(keyword: string) {
    const actual = this.readKeyword();
    if (actual.toLowerCase() !== keyword.toLowerCase()) {
      throw new SqlDumpError("unsupported-sql", `Expected SQL keyword ${keyword}.`);
    }
  }

  readIdentifier() {
    this.skipWhitespace();
    const opening = this.current;
    if (opening === "`") {
      this.position += 1;
      let result = "";
      while (this.position < this.input.length) {
        const character = this.input[this.position] ?? "";
        if (character === "`") {
          if (this.input[this.position + 1] === "`") {
            result += "`";
            this.position += 2;
            continue;
          }
          this.position += 1;
          if (!result) {
            throw new SqlDumpError("malformed-sql", "An SQL identifier cannot be empty.");
          }
          return result;
        }
        result += character;
        this.position += 1;
      }
      throw new SqlDumpError("malformed-sql", "The SQL dump ended inside an identifier.");
    }

    const start = this.position;
    while (/[A-Za-z0-9_$-]/u.test(this.input[this.position] ?? "")) {
      this.position += 1;
    }
    if (this.position === start) {
      throw new SqlDumpError("malformed-sql", "An SQL identifier was expected.");
    }
    return this.input.slice(start, this.position);
  }

  readQualifiedIdentifier() {
    const first = this.readIdentifier();
    this.skipWhitespace();
    if (this.current !== ".") {
      return first;
    }
    this.position += 1;
    return this.readIdentifier();
  }
}

function stripLeadingComments(statement: string) {
  let remaining = statement.trimStart();
  while (remaining) {
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end === -1) {
        throw new SqlDumpError("malformed-sql", "The SQL dump ended inside a comment.");
      }
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    if (remaining.startsWith("#")) {
      const newline = remaining.search(/[\r\n]/u);
      remaining = (newline === -1 ? "" : remaining.slice(newline + 1)).trimStart();
      continue;
    }
    if (remaining.startsWith("--") && /\s/u.test(remaining[2] ?? "")) {
      const newline = remaining.search(/[\r\n]/u);
      remaining = (newline === -1 ? "" : remaining.slice(newline + 1)).trimStart();
      continue;
    }
    break;
  }
  return remaining;
}

function parseSqlString(cursor: SqlCursor): string {
  const quote = cursor.current;
  if (quote !== "'" && quote !== '"') {
    throw new SqlDumpError("malformed-sql", "A quoted SQL value was expected.");
  }
  cursor.position += 1;
  let result = "";
  while (cursor.position < cursor.input.length) {
    const character = cursor.input[cursor.position] ?? "";
    if (character === "\\") {
      const escaped = cursor.input[cursor.position + 1];
      if (escaped === undefined) {
        throw new SqlDumpError("malformed-sql", "The SQL dump ended inside a string.");
      }
      result += ({
        "0": "\0",
        b: "\b",
        n: "\n",
        r: "\r",
        t: "\t",
        Z: "\x1a",
        "\\": "\\",
        "'": "'",
        '"': '"'
      } as Record<string, string>)[escaped] ?? escaped;
      cursor.position += 2;
      continue;
    }
    if (character === quote) {
      if (cursor.input[cursor.position + 1] === quote) {
        result += quote;
        cursor.position += 2;
        continue;
      }
      cursor.position += 1;
      return result;
    }
    result += character;
    cursor.position += 1;
  }
  throw new SqlDumpError("malformed-sql", "The SQL dump ended inside a string.");
}

function parseSqlValue(cursor: SqlCursor): SqlValue {
  cursor.skipWhitespace();
  if (cursor.current === "'" || cursor.current === '"') {
    return parseSqlString(cursor);
  }

  const start = cursor.position;
  while (cursor.current && cursor.current !== "," && cursor.current !== ")") {
    cursor.position += 1;
  }
  const value = cursor.input.slice(start, cursor.position).trim();
  if (!value) {
    throw new SqlDumpError("malformed-sql", "An SQL value cannot be empty.");
  }
  return value.toLowerCase() === "null" ? null : value;
}

function parseColumns(cursor: SqlCursor) {
  cursor.skipWhitespace();
  if (cursor.current !== "(") {
    throw new SqlDumpError(
      "unsupported-sql",
      "INSERT statements without an explicit column list are not supported."
    );
  }
  cursor.position += 1;
  const columns: string[] = [];
  while (true) {
    const column = cursor.readIdentifier();
    if (columns.includes(column)) {
      throw new SqlDumpError("malformed-sql", "An INSERT column was repeated.");
    }
    columns.push(column);
    cursor.skipWhitespace();
    const current = cursor.input[cursor.position] ?? "";
    if (current === ")") {
      cursor.position += 1;
      return columns;
    }
    if (current !== ",") {
      throw new SqlDumpError("malformed-sql", "An INSERT column list is malformed.");
    }
    cursor.position += 1;
  }
}

function parseInsert(
  statement: string,
  onRow: (table: string, columns: readonly string[], row: SqlInsertRow) => void,
  getTableColumns: ((table: string) => readonly string[] | undefined) | undefined
) {
  const cursor = new SqlCursor(statement);
  cursor.expectKeyword("INSERT");
  cursor.skipWhitespace();
  const modifier = cursor.readKeyword().toLowerCase();
  if (modifier !== "into" && modifier !== "ignore" && modifier !== "low_priority") {
    throw new SqlDumpError("unsupported-sql", "The INSERT statement uses an unsupported modifier.");
  }
  if (modifier !== "into") {
    cursor.expectKeyword("into");
  }
  const table = cursor.readQualifiedIdentifier();
  cursor.skipWhitespace();
  const columns = cursor.current === "("
    ? parseColumns(cursor)
    : getTableColumns?.(table);
  if (!columns || columns.length === 0) {
    throw new SqlDumpError(
      "unsupported-sql",
      "INSERT statements without a known column list are not supported."
    );
  }
  cursor.expectKeyword("VALUES");

  let rowCount = 0;
  while (true) {
    cursor.skipWhitespace();
    if (cursor.current !== "(") {
      throw new SqlDumpError("malformed-sql", "An INSERT row was expected.");
    }
    cursor.position += 1;
    const values: SqlValue[] = [];
    while (true) {
      values.push(parseSqlValue(cursor));
      cursor.skipWhitespace();
      const current = cursor.input[cursor.position] ?? "";
      if (current === ")") {
        cursor.position += 1;
        break;
      }
      if (current !== ",") {
        throw new SqlDumpError("malformed-sql", "An INSERT row is malformed.");
      }
      cursor.position += 1;
    }
    if (values.length !== columns.length) {
      throw new SqlDumpError("malformed-sql", "An INSERT row has the wrong number of values.");
    }
    const row: Record<string, SqlValue> = {};
    for (const [index, column] of columns.entries()) {
      const value = values[index];
      if (value === undefined) {
        throw new SqlDumpError("malformed-sql", "An INSERT row value was missing.");
      }
      row[column] = value;
    }
    onRow(table, columns, row);
    rowCount += 1;

    cursor.skipWhitespace();
    const current = cursor.input[cursor.position] ?? "";
    if (!current) {
      return rowCount;
    }
    if (current === ";") {
      cursor.position += 1;
      cursor.skipWhitespace();
      if (!cursor.input[cursor.position]) {
        return rowCount;
      }
    }
    if (current !== ",") {
      throw new SqlDumpError(
        "malformed-sql",
        `An INSERT statement for ${table} has trailing data (character code ${
          current.codePointAt(0) ?? 0
        }).`
      );
    }
    cursor.position += 1;
  }
}

function findCreateBody(statement: string, start: number) {
  let quote: "'" | '"' | "`" | null = null;
  let depth = 0;
  for (let index = start; index < statement.length; index += 1) {
    const character = statement[index] ?? "";
    if (quote !== null) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        if (statement[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return { start, end: index };
      }
      if (depth < 0) {
        break;
      }
    }
  }
  throw new SqlDumpError("malformed-sql", "A CREATE TABLE definition is incomplete.");
}

function parseCreateTable(statement: string): SqlCreateTable {
  const cursor = new SqlCursor(statement);
  cursor.expectKeyword("CREATE");
  cursor.expectKeyword("TABLE");
  cursor.skipWhitespace();
  if (cursor.input.slice(cursor.position, cursor.position + 2).toLowerCase() === "if") {
    cursor.expectKeyword("IF");
    cursor.expectKeyword("NOT");
    cursor.expectKeyword("EXISTS");
  }
  const table = cursor.readQualifiedIdentifier();
  const opening = cursor.input.indexOf("(", cursor.position);
  if (opening === -1) {
    throw new SqlDumpError("malformed-sql", "A CREATE TABLE definition has no columns.");
  }
  const body = findCreateBody(statement, opening);
  const columns: string[] = [];
  let segmentStart = body.start + 1;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  const segments: string[] = [];
  for (let index = segmentStart; index < body.end; index += 1) {
    const character = statement[index] ?? "";
    if (quote !== null) {
      if (character === "\\" && quote !== "`") {
        index += 1;
      } else if (character === quote) {
        if (statement[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) {
        throw new SqlDumpError("malformed-sql", "A CREATE TABLE column definition is malformed.");
      }
    } else if (character === "," && depth === 0) {
      segments.push(statement.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  if (quote !== null || depth !== 0) {
    throw new SqlDumpError("malformed-sql", "A CREATE TABLE column definition is malformed.");
  }
  segments.push(statement.slice(segmentStart, body.end));
  for (const segment of segments) {
    const trimmed = segment.trimStart();
    if (!trimmed.startsWith("`")) {
      continue;
    }
    const columnCursor = new SqlCursor(trimmed);
    columns.push(columnCursor.readIdentifier());
  }
  return { table, columns };
}

function processStatement(
  statement: string,
  handlers: SqlDumpHandlers
):
  | { kind: "insert"; table: string; rows: number }
  | { kind: "create" | "other"; rows: number } {
  const normalized = stripLeadingComments(statement).trim();
  if (!normalized) {
    return { kind: "other", rows: 0 };
  }

  const keyword = normalized.match(/^[A-Za-z]+/u)?.[0]?.toLowerCase();
  if (keyword === "insert") {
    let rows = 0;
    let table: string | undefined;
    rows = parseInsert(
      normalized,
      (insertTable, columns, row) => {
        table = insertTable;
        handlers.onInsert?.({ table: insertTable, columns, row });
      },
      handlers.getTableColumns
    );
    if (table === undefined) {
      throw new SqlDumpError("malformed-sql", "An INSERT table was missing.");
    }
    return { kind: "insert", table, rows };
  }
  if (keyword === "create") {
    const table = parseCreateTable(normalized);
    handlers.onCreateTable?.(table);
    return { kind: "create", rows: 0 };
  }
  if (
    keyword === undefined
    || keyword === "set"
    || keyword === "lock"
    || keyword === "unlock"
    || keyword === "drop"
    || keyword === "alter"
    || keyword === "truncate"
    || keyword === "use"
    || keyword === "start"
    || keyword === "commit"
    || keyword === "rollback"
    || keyword === "delimiter"
  ) {
    return { kind: "other", rows: 0 };
  }
  throw new SqlDumpError(
    "unsupported-sql",
    `Unsupported SQL statement type: ${keyword}.`
  );
}

function mergeLimits(limits: Partial<SqlDumpLimits> | undefined) {
  const merged = { ...defaultSqlDumpLimits, ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`SQL dump limit ${key} must be a positive safe integer.`);
    }
  }
  return merged;
}

export async function scanSqlDump(
  databasePath: string,
  handlers: SqlDumpHandlers = {},
  inputLimits?: Partial<SqlDumpLimits>
): Promise<SqlDumpStats> {
  const limits = mergeLimits(inputLimits);
  const isGzip = databasePath.toLowerCase().endsWith(".gz");
  const source = createReadStream(databasePath);
  const compressed = new ByteLimitTransform(
    limits.maxCompressedBytes,
    "compressed-byte-limit",
    "Compressed SQL input"
  );
  const decompressed = new ByteLimitTransform(
    limits.maxDecompressedBytes,
    "decompressed-byte-limit",
    "Decompressed SQL input"
  );
  const gunzip = isGzip ? createGunzip() : null;
  source.pipe(compressed);
  const content = gunzip
    ? compressed.pipe(gunzip).pipe(decompressed)
    : compressed.pipe(decompressed);

  const scanner = new SqlStatementScanner(limits.maxStatementBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decompressedHash = createHash("sha256");
  let statements = 0;
  let insertStatements = 0;
  let rows = 0;
  let createTables = 0;
  const insertsByTable = new Map<string, {
    insertStatements: number;
    rows: number;
  }>();

  function recordInsert(table: string, rowCount: number) {
    const current = insertsByTable.get(table) ?? {
      insertStatements: 0,
      rows: 0
    };
    current.insertStatements += 1;
    current.rows += rowCount;
    insertsByTable.set(table, current);
  }

  try {
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      decompressedHash.update(buffer);
      const text = decoder.decode(buffer, {
        stream: true
      });
      for (const statement of scanner.feed(text)) {
        const result = processStatement(statement, handlers);
        statements += 1;
        if (result.kind === "insert") {
          insertStatements += 1;
          rows += result.rows;
          recordInsert(result.table, result.rows);
          if (rows > limits.maxRows) {
            throw new SqlDumpError(
              "row-limit",
              "The SQL dump exceeded the configured row safety limit."
            );
          }
        } else if (result.kind === "create") {
          createTables += 1;
        }
      }
    }
    const finalText = decoder.decode();
    for (const statement of scanner.feed(finalText)) {
      const result = processStatement(statement, handlers);
      statements += 1;
      if (result.kind === "insert") {
        insertStatements += 1;
        rows += result.rows;
        recordInsert(result.table, result.rows);
      } else if (result.kind === "create") {
        createTables += 1;
      }
    }
    for (const statement of scanner.finish()) {
      const result = processStatement(statement, handlers);
      statements += 1;
      if (result.kind === "insert") {
        insertStatements += 1;
        rows += result.rows;
        recordInsert(result.table, result.rows);
      } else if (result.kind === "create") {
        createTables += 1;
      }
    }
    if (rows > limits.maxRows) {
      throw new SqlDumpError(
        "row-limit",
        "The SQL dump exceeded the configured row safety limit."
      );
    }
  } catch (error) {
    source.destroy();
    compressed.destroy();
    gunzip?.destroy();
    decompressed.destroy();
    if (error instanceof SqlDumpError) {
      throw error;
    }
    if (
      error
      && typeof error === "object"
      && "name" in error
      && error.name === "SourceEvidenceError"
    ) {
      throw error;
    }
    if (error instanceof Error) {
      throw new SqlDumpError("input-error", "The SQL dump could not be read.");
    }
    throw error;
  }

  return {
    format: isGzip ? "gzip" : "sql",
    compressedBytes: compressed.bytes,
    decompressedBytes: decompressed.bytes,
    sqlDecompressedSha256: decompressedHash.digest("hex"),
    statements,
    insertStatements,
    rows,
    createTables,
    insertsByTable: Object.fromEntries(
      [...insertsByTable.entries()].sort(([left], [right]) => left.localeCompare(right))
    )
  };
}
