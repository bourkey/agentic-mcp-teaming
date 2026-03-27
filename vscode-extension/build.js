const esbuild = require("esbuild");

const minify = process.argv.includes("--minify");

esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !minify,
  minify,
  logLevel: "info",
}).catch(() => process.exit(1));
