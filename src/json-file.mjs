import { readFile } from "node:fs/promises";

export function parseJsonText(text, label = "JSON") {
  if (typeof text !== "string") throw new Error(`${label} text must be a string`);
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readJsonFile(filePath, label = filePath) {
  return parseJsonText(await readFile(filePath, "utf8"), label);
}
