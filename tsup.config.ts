import { createRequire } from "node:module";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as { dependencies?: Record<string, string> };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: false,
  noExternal: Object.keys(packageJson.dependencies ?? {})
});
