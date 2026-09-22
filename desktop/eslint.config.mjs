// desktop/ is plain JavaScript with no build step, so it is invisible to tsc
// and to `eslint src/`. Two real bugs reached the user through that gap: an
// identifier used but never declared, and an edit that silently failed to
// apply. This config exists so that class cannot recur.
//
// `files` patterns are resolved against the directory eslint runs from — the
// repo root — not against this file. They must be repo-relative.
//
// The extension is .mjs rather than .js on purpose: adding "type": "module"
// to desktop/package.json would break main.js and preload.js, which are
// CommonJS and use require().

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  __dirname: "readonly",
  process: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  Buffer: "readonly",
};

const browserGlobals = {
  document: "readonly",
  window: "readonly",
  fetch: "readonly",
  location: "readonly",
  Image: "readonly",
  URLSearchParams: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  requestAnimationFrame: "readonly",
  console: "readonly",
};

export default [
  {
    files: ["desktop/main.js", "desktop/preload.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: nodeGlobals },
    rules: { "no-undef": "error", "no-unused-vars": "error" },
  },
  {
    files: ["desktop/renderer/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: browserGlobals },
    rules: { "no-undef": "error", "no-unused-vars": "error" },
  },
];
