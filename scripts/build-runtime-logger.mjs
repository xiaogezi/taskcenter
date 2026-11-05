import { rolldown } from "rolldown";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function buildRuntimeLogger(root) {
  const directory = resolve(root, "dist/runtime");
  mkdirSync(directory, { recursive: true });
  const bundle = await rolldown({ input: resolve(root, "scripts/runtime-logger.mjs"), platform: "node", external: [/^node:/] });
  try {
    const { output } = await bundle.write({ file: join(directory, "logger.cjs"), format: "cjs", minify: true });
    const packages = new Set();
    for (const chunk of output) {
      for (const id of Object.keys(chunk.modules || {})) {
        const match = id.replaceAll("\\", "/").match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
        if (match) packages.add(match[1]);
      }
    }
    const notices = [];
    for (const path of [...packages].sort()) {
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      const license = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENSE.MD"].find(name => existsSync(join(path, name)));
      if (!license) throw new Error(`Missing bundled license: ${manifest.name}`);
      notices.push(`${manifest.name}@${manifest.version} (${manifest.license})\n${readFileSync(join(path, license), "utf8")}`);
    }
    if (!notices.length) throw new Error("Logger bundle has no dependency notices");
    writeFileSync(join(directory, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n---\n\n") + "\n");
  } finally { await bundle.close(); }
}
