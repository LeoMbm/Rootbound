import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const scanRoots = ["src", "scripts", "bin", "test"];
const sourceFiles = [];

for (const relative of scanRoots) await collect(path.join(root, relative));

const importPatterns = [
  /\bimport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const missing = [];
for (const file of sourceFiles) {
  const text = await readFile(file, "utf8");
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (!(await existsImportTarget(target))) missing.push(`${path.relative(root, file)} -> ${specifier}`);
    }
  }
}
assert.deepEqual(missing, [], `missing relative import targets:\n${missing.join("\n")}`);

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const scriptPaths = new Set();
for (const script of Object.values(pkg.scripts ?? {})) {
  for (const match of String(script).matchAll(/(?:^|&&|;)\s*node\s+([^\s;&]+)/g)) {
    const candidate = match[1].replace(/^['"]|['"]$/g, "");
    if (!candidate.startsWith("-")) scriptPaths.add(candidate);
  }
}
for (const relative of scriptPaths) await access(path.join(root, relative));

const binEntry = pkg.bin?.codexless;
assert.equal(typeof binEntry, "string");
await access(path.join(root, binEntry));

assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "package.json#files must be a non-empty array");
for (const relative of pkg.files) {
  assert.equal(typeof relative, "string", "package.json#files entries must be strings");
  assert.equal(/[*!?{}[\]]/.test(relative), false, `release contract uses explicit package paths; glob entry must be reviewed separately: ${relative}`);
  await access(path.join(root, relative));
}

console.log(`source-integrity-v5: ok (${sourceFiles.length} source/test files scanned; ${pkg.files.length} package paths verified)`);

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) sourceFiles.push(full);
  }
}

async function existsImportTarget(target) {
  for (const candidate of [target, `${target}.mjs`, `${target}.js`, path.join(target, "index.mjs"), path.join(target, "index.js")]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return true;
    } catch {}
  }
  return false;
}
