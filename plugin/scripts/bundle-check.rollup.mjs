import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
export default {
  input: new URL("../../packages/herdr-client/dist/index.js", import.meta.url).pathname,
  output: { file: process.env.OUT, format: "es", inlineDynamicImports: true, intro: 'import { fileURLToPath as __f } from "node:url"; import { dirname as __d } from "node:path"; const __filename = __f(import.meta.url); const __dirname = __d(__filename);' },
  external: ["cpu-features", /sshcrypto\.node$/],
  onwarn(w, warn) { if (w.code !== "CIRCULAR_DEPENDENCY") warn(w); },
  plugins: [
    json(),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs({ ignoreDynamicRequires: true, ignoreTryCatch: true }),
  ],
};
