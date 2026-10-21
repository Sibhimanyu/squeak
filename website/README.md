# Squeak website

The static marketing page for Squeak, served at `https://sibhimanyu.github.io/squeak/`.
No framework: semantic HTML from a template, CSS, and one small motion script with
GSAP and ScrollTrigger vendored at a pinned version.

## Layout

| path | owner | what it is |
| --- | --- | --- |
| `index.template.html` | page | the markup; `{{dot.path}}` tokens are filled from content |
| `src/content.ts` | page | all copy and links (default export) |
| `styles.css`, `motion.js`, `ducks.js` | page | layout, the pinned "moment" sequence, the hero stage growth, and the duck-pile physics |
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
- `styles.css`, `motion.js`, `ducks.js`, `scroll-score.json` and `assets/` are required; the build fails without them.
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
- GSAP 3.15.0 (`gsap.min.js`, `ScrollTrigger.min.js`) is copied from the pinned npm package.
  Its licence is the GSAP "Standard no charge" licence (https://gsap.com/standard-license);
  the npm package carries that reference rather than the full text.

## Release metadata

`scripts/release-meta.mjs` reads `https://sibhimanyu.github.io/squeak/appcast.xml`, takes the
newest item, checks that its enclosure is an https URL under `/squeak/download/` with a
matching file name, downloads the DMG to a temporary folder, and writes `release.json`
(version, length, sha256, Sparkle signature, publish date, minimum macOS, release notes).
The temporary copy is deleted. Nothing is written into the site.

The Sparkle `length` matches the decoded body. The CDN's `HEAD` reports the gzip size, so
the check uses the downloaded bytes rather than `Content-Length` from `HEAD`.

## Verification

`npm run verify` first type-checks the scripts, then runs headless Chromium against the running dev server (`npm run dev`, port
55010). Browser-side snippets are plain JavaScript strings, parse-checked before any browser starts
(`preflight()` in `verify.ts`), because tsx's `__name` helper cannot run in a page. Input is Playwright's CDP mouse wheel and keyboard, so each scroll is what a user
produces. It writes screenshots, contact sheets and `results.json` under
`.context/squeak-redesign/verify/`; `verify/README.md` there lists the artifacts and the manual
review notes, which are kept apart from the automated checks. Nothing is run against the
production release tree.

### The reachability gate, and why there are two numbers

The gate is the **primary CTA**: the hero "Download for Mac" button. It must be fully inside the
first screen with no scrolling, point at `release.json`'s `downloadUrl`, and be reached by Tab
from the top. It is checked at 1440x900, 834x1112 and 390x844.

Page length is a separate, reviewed matter. The layout budget (about 7 to 9 desktop screens) was
checked in design review and is recorded as evidence, not asserted by this gate. The verifier also records the closing install
section's distance from the top and the page height as evidence, and it counts how many 100 px
wheel notches it takes to bring the closing section into view. That count is a **diagnostic**: it is
printed and stored in `results.json` under `closingDiagnostic`, and it is not a pass or a fail.
The latest run measured 66 notches (closing section top 7,116 px of 7,880 px) with 100 px steps.

### What the checks cover

- desktop 1440x900: first-screen transfer, three real wheel notches, horizontal overflow at seven
  depths, the pin holding and releasing, four progress points, the Replay button, End escaping the
  pin, image decoding, resize removing and restoring one pin trigger, console and network errors,
  total transfer
- primary CTA at 1440x900, 834x1112 and 390x844: no scroll needed, fully on screen, URL, download
  attribute, keyboard reachable
- pin fit at 1280x720 and 1024x768: choice and receipt not clipped; End escapes
- disclosures at desktop and mobile: every `details > summary` is at least 44x44 px, shows a focus
  ring, Enter and Space toggle it, opening it shows content without horizontal overflow; no
  interactive control inside `aria-hidden`
- contrast at desktop and mobile: every visible text run against its nearest opaque background,
  WCAG AA (4.5:1, or 3:1 for large text)
- tablet 834x1112: no overflow, no pin below 900 px wide
- mobile 390x844: no overflow, no pin, all four states readable and ordered, 44 px buttons and CTAs,
  skip link first, keyboard order
- reduced motion and no-JavaScript (desktop and mobile): all states and sections present, reveals
  visible, replay hidden
- static: no missing tokens or placeholder text; release version and DMG links match `release.json`;
  exactly one JSON-LD `SoftwareApplication` that parses, carries the release, and has no raw `<`;
  `/squeak/` and `/squeak/styles.css` resolve; canonical URL; og:image is the canonical `/squeak/`
  path, mapped to the local file, and is 1200x630; title and description; in-page anchors; external
  links; bundled fonts load; `dist/` size; `scroll-score.json` in dist; the appcast and every DMG in
  `.context/release-pages/squeak/` still match the recorded manifest
- `npm run verify -- --baseline` also captures the pre-redesign page (screenshots only, no checks)

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
- Page length was reviewed and approved: 7,880 px at 1440x900 (8.76 desktop viewports) and about
  9,100 px at 390x844. The 66-notch closing-section figure is a diagnostic, not a gate.
- Automated checks cover text contrast (WCAG AA ratios of rendered text), focus rings on the
  disclosure, 44 px targets, and keyboard order. They do not replace a manual review with
  assistive technology, and nothing here measures how the scrubbed pin feels at speed.
- `Apple silicon` in the page copy matches the app's arm64-only builds.
