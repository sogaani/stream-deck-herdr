import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.sogaani.herdr.sdPlugin";

/** @type {import('rollup').RollupOptions} */
const config = {
  input: "src/plugin.ts",
  output: {
    file: `${sdPlugin}/bin/plugin.js`,
    format: "es",
    sourcemap: isWatching,
    inlineDynamicImports: true,
    // ssh2 (CommonJS) references __dirname/__filename; provide them in the ES module bundle.
    intro: [
      'import { fileURLToPath as __herdrFileURLToPath } from "node:url";',
      'import { dirname as __herdrDirname } from "node:path";',
      "const __filename = __herdrFileURLToPath(import.meta.url);",
      "const __dirname = __herdrDirname(__filename);",
    ].join("\n"),
    sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
      return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
    },
  },
  // Optional native accelerators of ssh2; the pure-JS fallbacks are used when they are absent.
  external: ["cpu-features", /sshcrypto\.node$/],
  onwarn(warning, warn) {
    if (warning.code === "CIRCULAR_DEPENDENCY") return;
    warn(warning);
  },
  plugins: [
    {
      name: "watch-externals",
      buildStart() {
        this.addWatchFile(`${sdPlugin}/manifest.json`);
      },
    },
    typescript({
      tsconfig: "./tsconfig.json",
      compilerOptions: { module: "esnext", moduleResolution: "bundler" },
      noEmit: false,
      declaration: false,
      outDir: undefined,
      mapRoot: isWatching ? "./" : undefined,
    }),
    json(),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs({ ignoreDynamicRequires: true, ignoreTryCatch: true }),
    !isWatching && terser({ format: { comments: false } }),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
  ],
};

export default config;
