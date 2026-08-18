import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const strict = process.argv.includes("--strict");
const json = process.argv.includes("--json");

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const shrinkwrap = JSON.parse(await readFile(path.join(root, "npm-shrinkwrap.json"), "utf8"));

const packageRoot = packageLock.packages?.[""] ?? {};
const shrinkRoot = shrinkwrap.packages?.[""] ?? {};
const problems = [];
const metadataDrift = [];

for (const [label, value, expected] of [
  ["package-lock name", packageRoot.name, pkg.name],
  ["package-lock version", packageRoot.version, pkg.version],
  ["shrinkwrap name", shrinkRoot.name, pkg.name],
  ["shrinkwrap version", shrinkRoot.version, pkg.version],
]) {
  if (value !== expected) problems.push(`${label}: ${JSON.stringify(value)} != ${JSON.stringify(expected)}`);
}

for (const [label, value, expected] of [
  ["package-lock dependencies", packageRoot.dependencies ?? {}, pkg.dependencies ?? {}],
  ["package-lock devDependencies", packageRoot.devDependencies ?? {}, pkg.devDependencies ?? {}],
  ["shrinkwrap dependencies", shrinkRoot.dependencies ?? {}, pkg.dependencies ?? {}],
  ["shrinkwrap devDependencies", shrinkRoot.devDependencies ?? {}, pkg.devDependencies ?? {}],
]) {
  if (stable(value) !== stable(expected)) problems.push(`${label} differ from package.json`);
}

for (const [label, value, expected] of [
  ["package-lock engines", packageRoot.engines ?? null, pkg.engines ?? null],
  ["package-lock bin", packageRoot.bin ?? null, pkg.bin ?? null],
  ["shrinkwrap engines", shrinkRoot.engines ?? null, pkg.engines ?? null],
  ["shrinkwrap bin", shrinkRoot.bin ?? null, pkg.bin ?? null],
]) {
  if (stable(value) !== stable(expected)) metadataDrift.push(`${label}: ${stable(value)} -> ${stable(expected)}`);
}

const result = {
  ok: problems.length === 0 && (!strict || metadataDrift.length === 0),
  dependencyCompatible: problems.length === 0,
  strict,
  problems,
  metadataDrift,
  remediation: metadataDrift.length
    ? [
        "On a trusted machine with the intended npm version, regenerate lock metadata from package.json.",
        "Run: npm install --package-lock-only --ignore-scripts",
        "Then regenerate npm-shrinkwrap.json with: npm shrinkwrap",
        "Review the diff and rerun: node scripts/check-lock-root.mjs --strict",
      ]
    : [],
};

if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(`Codexless lock check: ${result.ok ? "PASS" : strict ? "FAIL" : "DRIFT"}\n`);
  for (const problem of problems) process.stdout.write(`[ERROR] ${problem}\n`);
  for (const drift of metadataDrift) process.stdout.write(`[DRIFT] ${drift}\n`);
  for (const action of result.remediation) process.stdout.write(`-> ${action}\n`);
}

process.exitCode = result.ok ? 0 : 1;

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
