// Builds the web app to webapp/dist: one JS bundle (Preact inlined), one CSS file, index.html, and the brand SVGs copied
// from brand/logo/svg (never redrawn). `SQUEAK_WEB_ENV=production` picks config/production.json (default: development).
//   node webapp/scripts/build.mjs [outdir]            build once
//   node webapp/scripts/build.mjs --serve [outdir]    build, serve on http://localhost:5173 and rebuild the bundle on change
import { build, context } from "esbuild";
import { createServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serve = process.argv.includes("--serve");
const out = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(root, "dist"));
const env = process.env.SQUEAK_WEB_ENV ?? "development";
const config = JSON.parse(await readFile(path.join(root, "config", `${env}.json`), "utf8"));

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "brand"), { recursive: true });
const options = {
  entryPoints: { app: path.join(root, "src/main.tsx") },
  outdir: out,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  define: { __SQUEAK_CONFIG__: JSON.stringify(config) },
  logLevel: "warning",
};
if (serve) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
const css = await Promise.all(["styles.css", "ponds.css"].map((f) => readFile(path.join(root, "src", f), "utf8")));
await writeFile(path.join(out, "app.css"), css.join("\n"));
await cp(path.join(root, "index.html"), path.join(out, "index.html"));
// Slate's static hosting ignores redirect rules, so the emailed invite link (/join#<code>) needs a real page at /join.
await mkdir(path.join(out, "join"), { recursive: true });
const entry = (await readFile(path.join(root, "index.html"), "utf8")).replace(
  "<head>",
  '<head>\n    <base href="/" />',
);
await writeFile(path.join(out, "join", "index.html"), entry);
for (const name of ["squeak-lockup-stacked-ink", "squeak-lockup-stacked-paper", "squeak-duck-full-color"]) {
  await cp(path.join(root, "..", "brand/logo/svg", `${name}.svg`), path.join(out, "brand", `${name}.svg`));
}
await cp(path.join(root, "..", "brand/logo/png/duckThread.png"), path.join(out, "brand", "duckThread.png"));
console.log(`built ${out} (${env})`);

if (serve) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".map": "application/json",
  };
  createServer(async (req, res) => {
    let file = path.join(out, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (!file.startsWith(out)) return res.writeHead(403).end();
    if (!path.extname(file)) file = path.join(file, "index.html");
    try {
      res
        .writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" })
        .end(await readFile(file));
    } catch {
      res.writeHead(404).end("not found");
    }
  }).listen(5173, () => console.log("http://localhost:5173"));
}
