// Production uses the build artifact; development/tests use the same unbundled implementation.
export async function createRuntimeLogger(...args) {
  const module = await import(process.env.TASKCENTER_WEB_MODE === "start"
    ? new URL("../dist/runtime/logger.cjs", import.meta.url)
    : new URL("./runtime-logger.mjs", import.meta.url));
  return module.createRuntimeLogger(...args);
}
