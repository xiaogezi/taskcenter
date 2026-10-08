import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Old launchers fail before reading inputs; external review reporting remains available.
export function reviewerCommand() {
  throw new Error("RETIRED_CODEX_EXECUTION: use external Agent review reporting");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("RETIRED_CODEX_EXECUTION: use external Agent review reporting");
  process.exitCode = 1;
}
