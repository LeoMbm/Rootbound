import { realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { registerProject, resolveProjectRoot } from "./project-registry.mjs";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerWorkspaceTools(server, { store