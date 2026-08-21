import { open, readFile, unlink } from "node:fs/promises";
import { ensureRootboundStateDirs } from "./state-paths.mjs";
import { isProcessAlive } from "./runtime-state.mjs";

export async function withRuntimeMutationLock(paths, fn) {
  if (!paths?.runtimeMutationLockPath) throw new Error("runtime mutation lock requires Rootbound paths");
  if (typeof fn !== "function") throw new Error("runtime mutation lock requires a function");
  await ensureRootboundStateDirs(paths);
  const lockPath = paths.runtimeMutationLockPath;
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
    if (Number.isInteger(owner?.pid) && isProcessAlive(owner.pid)) throw runtimeLockError(`Rootbound runtime is being changed by pid ${owner.pid}.`);
    await unlink(lockPath).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
    try { handle = await open(lockPath, "wx", 0o600); }
    catch (retryError) {
      if (retryError?.code === "EEXIST") throw runtimeLockError("Rootbound runtime is being changed by another process.");
      throw retryError;
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    await handle.sync();
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

function runtimeLockError(message) {
  const error = new Error(message);
  error.code = "RUNTIME_MUTATION_BUSY";
  return error;
}
