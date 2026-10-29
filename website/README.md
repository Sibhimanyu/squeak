# Squeak website

The static marketing page for Squeak, served at `https://sibhimanyu.github.io/squeak/`.
No framework: semantic HTML from a template, CSS, and one small motion script with
GSAP and ScrollTrigger vendored at a pinned version.

## Layout

| path | owner | what it is |
| --- | --- | --- |
| `index.template.html` | page | the markup; `{{dot.path}}` tokens are filled from content |
| `src/content.ts` | page | all copy and links (default export) |
| `styles.css`, `motion.js` | page | layout and scroll reveals |
| `scroll-score.json` | page | the scroll score the motion was built against |
| `release.json` | tooling | the live Squeak release (from the appcast), imported by content |
| `assets/` | tooling | optimised images, fonts, vendored GSAP, icons, social image |
| `scripts/` | tooling | build, dev server, asset preparation, release check, verifier |
| `dist/` | generated | the built site (git-ignored) |

## Commands

```bash
npm ci                    # exact versions from package-lock.json
npm run build             # template + content -> dist/ (fails on any missing or unexpanded token)
npm run dev               # builds, serves dist/ on 127.0.0.1:55010 (also /squeak/), rebuilds on edit
npm run verify            # typecheck of scripts/, then headless Chromium checks against the running dev server (about 2 minutes)
npm run typecheck         # tsc --noEmit over scripts/ and src/ only
npm run verify -- --baseline   # also screenshots the pre-redesign copy (optional, slower)
npm run release           # re-reads the live appcast and rewrites release.json
node scripts/prepare-assets.mjs  # rebuilds assets/ from brand/ and the release page
```

Requirements: Node 22 or later. `npm run verify` needs the Playwright Chromium build
(`npx playwright install chromium` once). `prepare-assets.mjs` needs nothing beyond
`npm ci`, since the converted fonts and images are committed under `assets/`.

## Build rules

- `build` runs in its own process, so content edits are never served from a cached module.
  The dev server calls it as a child for every rebuild.
- It writes `dist.building/` and only swaps it into `dist/` when every token resolved. A
  failed build leaves the last good `dist/` in place.
- Tokens are HTML-escaped. No raw HTML is injected from content.
- `styles.css`, `motion.js`, `scroll-score.json` and `assets/` are required; the build fails without them.
- Paths are relative, so the same output serves at `/` and `/squeak/`.
- DMG files are never copied into the site. Download links point at the canonical
  `https://sibhimanyu.github.io/squeak/download/<file>` URL from `release.json`.

## Dev server

- Serves only files under `dist/`. A request is decoded once; malformed percent-encoding,
  NUL bytes and any path that leaves `dist/` return 404 (`scripts/serve-paths.ts`).
- Rebuilds on changes to the template, styles, motion, scroll score, `src/` and `assets/`.
  A failed rebuild is printed and the last good build keeps being served.

## Assets

Regenerate with `node scripts/prepare-assets.mjs`. Sources:

- Duck artwork and the product captures come from the read-only release page under
  `.context/release-pages/squeak/` (the mood PNGs are 240 px, the panel 760x1000).
  Those are the only inputs outside this folder, and the page is not built from them: the
  committed outputs are the inputs for `npm ci && npm run build`.
- `duck-brand.svg` and `logo.svg` come from `brand/logo/svg/`.
- `og.png` (1200x630) is rendered from the approved lockup and duck with Figtree from the
  installed brand font.
- Fonts were converted to WOFF2 from the bundled sources with fontTools (`fonttools` and
  `brotli` in a Python 3 environment; `python -m fontTools.ttLib.woff2 compress`). Licences
  are in `assets/fonts/licenses/`.
- Lenis 1.3.27 (`lenis.min.js`, MIT) is copied from the pinned npm package, minus its source-map comment.
- GSAP 3.15.0 (`gsap.min.js`, `ScrollTrigger.min.js`, `SplitText.min.js`) is copied from the pinned npm package. The page uses ScrollTrigger for the Mac, remote-access, and entrance motion.
  Its licence is the GSAP "Standard no charge" licence (https://gsap.com/standard-license);
  the npm package carries that reference rather than the full text.

- `ducks.js` (the hero's physics duck pile, canvas) and `webgl.js` (the pond-light backdrop behind it, raw WebGL with
  one fragment shader, no library) are first-party scripts copied to `dist/` by the build. `assets/logo-paper.svg` is
  the paper lockup from `brand/logo/svg/`, used on the Ink hero stage.

## Release metadata

`scripts/release-meta.mjs` reads `https://sibhimanyu.github.io/squeak/appcast.xml`, takes the
newest item, checks that its enclosure is an https URL under `/squeak/download/` with a
matching file name, downloads the DMG to a temporary folder, and writes `release.json`
(version, length, sha256, Sparkle signature, publish date, minimum macOS, release notes).
The temporary copy is deleted. Nothing is written into the site.

The Sparkle `length` matches the decoded body. The CDN's `HEAD` reports the gzip size, so
the check uses the downloaded bytes rather than `Content-Length` from `HEAD`.

## Verification

Run `npm run build`, start `npm run dev`, then run `npm run verify`. The browser checks exercise
1440px desktop, 834px tablet and 390px phone layouts; verify the Conductor-first section order,
Mac download CTA, the separate calling options and setup notes, the web link, no horizontal overflow,
keyboard skip link, reduced-motion and no-JavaScript readability, static metadata, and release files.
It writes screenshots and `results.json` to `.context/squeak-redesign/verify/`.

The page has no pinned story. Its scroll score records the measured page heights and section order in
`scroll-score.json`; page length is evidence rather than a pass/fail limit.

## Build-generated JSON-LD

The build writes one `SoftwareApplication` block (category `DeveloperApplication`, macOS
minimum from `release.json`, iOS as the iPhone companion, free offer, canonical URL, description,
version, download URL, release notes, publish date and file size) before `</head>`. It is
JSON-encoded, then `<` and the two line separators are escaped, so no value can close the script.
The build refuses a template that already contains JSON-LD, so there is only ever one block.

## Staging a preview copy (does not publish)

```bash
npm run build
node scripts/stage-copy.mjs
```

This copies `.context/release-pages/squeak/` into a new temporary folder, overlays `dist/` onto
that copy, and then checks that `appcast.xml` and every DMG are byte-identical to the recorded
manifest (`.context/squeak-redesign/haiku-work/release-pages-manifest.sha256`). It also checks that
the real tree did not change. The report is written to `.context/squeak-redesign/stage-report.json`.
To preview, serve the printed `site` folder (for example `npx --yes serve -l 8000 <folder>`) and
open `http://localhost:8000/squeak/`. Remove the temporary folder afterwards.

## Publication status

Nothing has been published. No commit has been made, nothing has been pushed to the release
repository, and `.context/release-pages/` has not been written to. Publishing is a later step that
needs an explicit go-ahead: it would copy `dist/` over the real `squeak/` folder in the Pages
repository, leaving `appcast.xml` and `download/` untouched.

## Known limits and trade-offs

- The duck mood images (`assets/duck-*.webp`) are the shipped app's own state artwork (240 px),
  used on purpose: the moods show what the product really displays. The hero and logo use the
  approved brand vectors from `brand/logo/svg/`.
- Page length after the restructure: about 8.2k px at 1440x900 and 10.4k px at 390x844. Measurements are recorded in `scroll-score.json`, not enforced as a gate.
- Automated checks cover text contrast (WCAG AA ratios of rendered text), focus rings on the
  disclosure, 44 px targets, and keyboard order. They do not replace a manual review with
  assistive technology, and nothing here measures how the scrubbed pin feels at speed.
- `Apple silicon` in the page copy matches the app's arm64-only builds.
