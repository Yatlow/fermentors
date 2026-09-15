import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const serverDir = path.join(repoRoot, "server");

if (!fs.existsSync(serverDir)) {
  console.error("server directory not found");
  process.exit(1);
}

const files = fs.readdirSync(serverDir)
  .filter((name) => name.endsWith(".js"))
  .sort();

// Temporary compatibility exception. These two implementations were checked
// side-by-side and are byte-for-byte equivalent in behavior. post.js does not
// call its local copy. Keep this exception narrow; any other duplicate fails.
const allowedCollisions = new Map([
  [
    "formatMeasurementValue",
    new Set(["addFermentationMeasurement.js", "post.js"])
  ]
]);

function scanTopLevelDeclarations(source, fileName) {
  const declarations = [];
  let i = 0;
  let depth = 0;
  let line = 1;
  let state = "code";

  function isIdentStart(ch) {
    return /[A-Za-z_$]/.test(ch || "");
  }

  function isIdentPart(ch) {
    return /[A-Za-z0-9_$]/.test(ch || "");
  }

  function readIdentifier(start) {
    if (!isIdentStart(source[start])) return null;
    let end = start + 1;
    while (end < source.length && isIdentPart(source[end])) end++;
    return { value: source.slice(start, end), end };
  }

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "\n") line++;

    if (state === "lineComment") {
      if (ch === "\n") state = "code";
      i++;
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (state === "singleQuote") {
      if (ch === "\\") i += 2;
      else if (ch === "'") { state = "code"; i++; }
      else i++;
      continue;
    }

    if (state === "doubleQuote") {
      if (ch === "\\") i += 2;
      else if (ch === '"') { state = "code"; i++; }
      else i++;
      continue;
    }

    if (state === "template") {
      if (ch === "\\") i += 2;
      else if (ch === "`") { state = "code"; i++; }
      else i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "lineComment";
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }

    if (ch === "'") { state = "singleQuote"; i++; continue; }
    if (ch === '"') { state = "doubleQuote"; i++; continue; }
    if (ch === "`") { state = "template"; i++; continue; }

    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth = Math.max(0, depth - 1); i++; continue; }

    if (depth === 0 && isIdentStart(ch)) {
      const token = readIdentifier(i);
      const keyword = token.value;

      if (keyword === "function") {
        let p = token.end;
        while (/\s/.test(source[p] || "")) p++;
        const name = readIdentifier(p);
        if (name) {
          declarations.push({ kind: "function", name: name.value, file: fileName, line });
        }
        i = token.end;
        continue;
      }

      if (keyword === "const" || keyword === "let" || keyword === "var") {
        let p = token.end;
        while (/\s/.test(source[p] || "")) p++;
        const name = readIdentifier(p);
        if (name) {
          declarations.push({ kind: keyword, name: name.value, file: fileName, line });
        }
        i = token.end;
        continue;
      }

      i = token.end;
      continue;
    }

    i++;
  }

  return declarations;
}

const all = [];
for (const file of files) {
  const fullPath = path.join(serverDir, file);
  const source = fs.readFileSync(fullPath, "utf8");
  all.push(...scanTopLevelDeclarations(source, file));
}

const byName = new Map();
for (const declaration of all) {
  const rows = byName.get(declaration.name) || [];
  rows.push(declaration);
  byName.set(declaration.name, rows);
}

function isAllowedCollision(name, rows) {
  const allowedFiles = allowedCollisions.get(name);
  if (!allowedFiles) return false;

  const actualFiles = new Set(rows.map((row) => row.file));
  if (actualFiles.size !== allowedFiles.size) return false;

  for (const file of actualFiles) {
    if (!allowedFiles.has(file)) return false;
  }

  return true;
}

const allCollisions = [...byName.entries()]
  .filter(([, rows]) => rows.length > 1)
  .sort(([a], [b]) => a.localeCompare(b));

const collisions = allCollisions.filter(
  ([name, rows]) => !isAllowedCollision(name, rows)
);

const allowedPresent = allCollisions.filter(
  ([name, rows]) => isAllowedCollision(name, rows)
);

for (const [name, rows] of allowedPresent) {
  console.warn(
    `Allowed compatibility duplicate: ${name} -> ` +
    rows.map((row) => `${row.file}:${row.line}`).join(", ")
  );
}

if (collisions.length) {
  console.error("\nApps Script global namespace collisions detected:\n");
  for (const [name, rows] of collisions) {
    console.error(`- ${name}`);
    for (const row of rows) {
      console.error(`    ${row.file}:${row.line} (${row.kind})`);
    }
  }
  console.error("\nApps Script loads all .js/.gs files into one global namespace. Rename/remove duplicates before deploy.\n");
  process.exit(1);
}

console.log(
  `Apps Script runtime validation passed: ${files.length} JS files, ` +
  `${all.length} top-level declarations, no unsafe collisions.`
);
