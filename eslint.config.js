import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const readonly = (names) => Object.fromEntries(names.split(" ").map((name) => [name, "readonly"]));

const webGlobals = readonly(
  "window document navigator location globalThis crypto fetch AbortController AbortSignal DOMException Blob Response " +
    "ReadableStream TextEncoder TextDecoder DecompressionStream URL URLSearchParams atob btoa setTimeout clearTimeout " +
    "setInterval clearInterval queueMicrotask structuredClone indexedDB console",
);
const testGlobals = readonly("Buffer process __dirname");

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
  },
  // web/ is plain browser JavaScript with no build step, so tsc never sees it.
  // `files` patterns resolve against the directory eslint runs from (the repo
  // root), so they are repo-relative: one that matches nothing passes everything.
  {
    files: ["web/js/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: webGlobals },
    rules: { "no-undef": "error", "no-unused-vars": "error", "no-console": "error" },
  },
  {
    files: ["web/test/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...webGlobals, ...testGlobals } },
    rules: { "no-undef": "error", "no-unused-vars": "error" },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
