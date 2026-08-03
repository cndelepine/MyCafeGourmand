function unescapeSql(value: string) {
  return value.replace(/\\([\\'0bnrtZ])/g, (_, character: string) => ({
    "0": "\0",
    b: "\b",
    n: "\n",
    r: "\r",
    t: "\t",
    Z: "\x1a"
  })[character] ?? character);
}

export function getPostMeta(sql: string, postId: string) {
  if (!/^\d+$/.test(postId)) {
    throw new Error("WordPress IDs must contain digits only.");
  }

  const metadata = new Map<string, string>();
  const insertPattern = /INSERT\s+INTO\s+`?[\w$-]*postmeta`?\s*(?:\([^;]*?\))?\s*VALUES\s*([\s\S]*?);\s*(?:\r?\n|$)/gi;
  const rowPattern = new RegExp(
    String.raw`\(\s*\d+\s*,\s*${postId}\s*,\s*'((?:\\.|[^'])*)'\s*,\s*(NULL|'((?:\\.|[^'])*)')\s*\)`,
    "g"
  );

  for (const insert of sql.matchAll(insertPattern)) {
    for (const row of insert[1].matchAll(rowPattern)) {
      const key = unescapeSql(row[1]);
      const value = row[2] === "NULL" ? "" : unescapeSql(row[3]);
      if (metadata.has(key)) {
        throw new Error(`Duplicate metadata key ${key} for post ${postId}.`);
      }
      metadata.set(key, value);
    }
  }

  return metadata;
}
