import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const readonly = (names) => Object.fromEntries(names.split(" ").map((name) => [name, "readonly"]));

const testGlobals = readonly("Buffer process __dirname");

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
  },
  // webapp/ is TypeScript (tsc checks it); its build script is plain Node.
  {
    files: ["webapp/scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...testGlobals, console: "readonly", URL: "readonly" },
    },
    rules: { "no-undef": "error", "no-unused-vars": "error" },
  },
  {
    ignores: ["dist/", "webapp/dist/", "node_modules/"],
  },
);
