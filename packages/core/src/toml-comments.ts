export interface TomlComment {
  /** 1-based line number in the scanned lines. */
  line: number;
  /** Dotted path of the key or table the comment belongs to. */
  key: string;
  /** Comment text without the leading `#`. */
  text: string;
}

/**
 * Finds every comment in TOML lines, both on their own line and after a value.
 * A comment after a value belongs to that value's key. A comment on its own line
 * belongs to the value it sits inside (multi-line arrays and inline tables), or
 * else to the next key or table header. `#` inside strings is not a comment.
 */
export function findComments(lines: string[], firstLine = 1): TomlComment[] {
  const comments: TomlComment[] = [];
  const arrayTables = new Map<string, number>();
  let table = "";
  let key = "";
  let depth = 0;
  let multiline: '"""' | "'''" | undefined;
  let pending: Omit<TomlComment, "key">[] = [];

  const path = (name: string) => (table === "" ? name : `${table}.${name}`);
  const attach = (target: string) => {
    for (const comment of pending) comments.push({ ...comment, key: target });
    pending = [];
  };

  lines.forEach((line, index) => {
    const startsInValue = depth > 0 || multiline !== undefined;
    let i = 0;
    if (!startsInValue) {
      const trimmed = line.trim();
      const header = /^\[(\[)?\s*([^\]]+?)\s*\]\]?/.exec(trimmed);
      const assignment = /^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/.exec(trimmed);
      if (header) {
        const name = header[2]!.replace(/\s*\.\s*/g, ".");
        if (header[1]) {
          const count = arrayTables.get(name) ?? 0;
          arrayTables.set(name, count + 1);
          table = `${name}[${count}]`;
        } else {
          table = name;
        }
        key = table;
        attach(table);
        i = line.indexOf(header[0]) + header[0].length;
      } else if (assignment) {
        key = path(assignment[1]!.replace(/\s*\.\s*/g, "."));
        attach(key);
        i = line.indexOf(assignment[0]) + assignment[0].length;
      }
    }

    while (i < line.length) {
      if (multiline !== undefined) {
        const end = line.indexOf(multiline, i);
        if (end === -1) break;
        i = end + 3;
        multiline = undefined;
        continue;
      }
      const char = line[i]!;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multiline = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
      } else if (char === '"' || char === "'") {
        i++;
        while (i < line.length && line[i] !== char) i += char === '"' && line[i] === "\\" ? 2 : 1;
        i++;
      } else if (char === "[" || char === "{") {
        depth++;
        i++;
      } else if (char === "]" || char === "}") {
        depth = Math.max(0, depth - 1);
        i++;
      } else if (char === "#") {
        const comment = { line: firstLine + index, text: line.slice(i + 1).trim() };
        const ownLine = line.slice(0, i).trim() === "";
        if (ownLine && !startsInValue) pending.push(comment);
        else comments.push({ ...comment, key });
        break;
      } else {
        i++;
      }
    }
  });
  attach(table === "" ? "(end)" : table);
  return comments.sort((a, b) => a.line - b.line);
}
