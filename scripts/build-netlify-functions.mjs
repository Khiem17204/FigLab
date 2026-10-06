// Prepares the Fastify API and the Graphile job runner for Netlify Functions.
//
// pnpm keeps each app's dependencies (and the TypeScript-source @figlab/* packages) out of the
// root node_modules, so Netlify's own tracer cannot package them. esbuild resolves them from their
// real locations instead. sharp stays external because it loads a native binary at runtime: a flat
// copy of sharp, its JS dependencies and its Linux x64 (glibc) binaries is written to
// netlify/node_modules, which Node resolves from netlify/functions on Netlify. The Linux packages
// are installed even on macOS through supportedArchitectures in pnpm-workspace.yaml.
import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";

rmSync("netlify/dist", { recursive: true, force: true });
await build({
  entryPoints: { api: "netlify/lib/api.ts", jobs: "netlify/lib/jobs.ts" },
  outdir: "netlify/dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  logLevel: "info",
  // Netlify re-bundles these files and injects require/__filename/__dirname itself.
  external: ["sharp"],
  // Optional, lazily required code paths FigLab never takes.
  alias: {
    "pg-native": "./netlify/lib/unavailable.cjs",
    typescript: "./netlify/lib/unavailable.cjs",
  },
});

// Node's lookup order, without require.resolve (several of these packages hide package.json).
function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`Cannot find ${name} from ${from}; run pnpm install`);
  }
}
const sharpDir = packageDir("sharp", realpathSync("apps/jobs"));
const linuxDir = packageDir("@img/sharp-linux-x64", sharpDir);
const packages = {
  sharp: sharpDir,
  "@img/colour": packageDir("@img/colour", sharpDir),
  "detect-libc": packageDir("detect-libc", sharpDir),
  semver: packageDir("semver", sharpDir),
  "@img/sharp-linux-x64": linuxDir,
  "@img/sharp-libvips-linux-x64": packageDir("@img/sharp-libvips-linux-x64", linuxDir),
};
rmSync("netlify/node_modules", { recursive: true, force: true });
for (const [name, source] of Object.entries(packages)) {
  cpSync(source, join("netlify/node_modules", name), { recursive: true, dereference: true });
}
console.log(`Copied ${Object.keys(packages).join(", ")} to netlify/node_modules`);
