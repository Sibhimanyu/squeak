# Third-party notices

Squeak for Mac includes the following open-source software. Each keeps its own licence.

## SwiftTerm 1.99.3 (MIT)

The terminal in the Terminal panel (⌘J). https://github.com/migueldeicaza/SwiftTerm

    Copyright (c) 2019-2026 Miguel de Icaza (https://github.com/migueldeicaza)
    Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
    Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
    Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
    Copyright (c) 2016 Ryan L McIntyre (Powerline Extra Symbols flame silhouette, https://github.com/ryanoasis/powerline-extra-symbols)

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
    OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
    WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## JetBrains Mono (SIL Open Font License 1.1)

The terminal's typeface. Licence text: `brand/fonts/JetBrainsMono/OFL.txt` (bundled as `Resources/fonts/OFL.txt`).

## Sparkle 2 (MIT) and Lucide icons (ISC)

Updates (https://github.com/sparkle-project/Sparkle) and the icon set (`icons/LICENSE-lucide.txt`).

## The bundled daemon

Squeak for Mac carries its own copy of the Squeak daemon in `Contents/Resources/daemon/` (`macos/scripts/embed-daemon.sh`). It is one esbuild bundle of Squeak's code plus the packages below, run by the Node.js runtime beside it. Only these production dependencies are in the app: the daemon's root `package.json` lists the Claude Agent SDK, better-sqlite3 and zod, and the SDK has no other runtime npm dependencies in the bundle. Development tools (TypeScript, esbuild, vitest and the like) are not shipped.

## Node.js 22.23.1 (MIT, with bundled third-party notices)

The runtime that runs the daemon (`daemon/node`, the official macOS arm64 build from https://nodejs.org). Node.js is MIT-licensed and bundles its own dependencies (V8, OpenSSL, ICU, npm, zlib and others), each under its own licence. The full list is in the `LICENSE` file of the Node.js distribution: https://github.com/nodejs/node/blob/v22.23.1/LICENSE

    Copyright Node.js contributors. All rights reserved.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to
    deal in the Software without restriction, including without limitation the
    rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
    sell copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
    IN THE SOFTWARE.

## better-sqlite3 12.8.0 (MIT; embeds SQLite, public domain)

The database driver (`daemon/node_modules/better-sqlite3`, a native module built for the bundled Node). It embeds SQLite (https://sqlite.org), which is in the public domain. https://github.com/WiseLibs/better-sqlite3

    The MIT License (MIT)

    Copyright (c) 2017 Joshua Wise

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## bindings 1.5.0 (MIT)

Locates better-sqlite3's native module (`daemon/node_modules/bindings`). https://github.com/TooTallNate/node-bindings

    (The MIT License)

    Copyright (c) 2012 Nathan Rajlich <nathan@tootallnate.net>

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    'Software'), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
    SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## file-uri-to-path 1.0.0 (MIT)

Used by `bindings` (`daemon/node_modules/file-uri-to-path`). https://github.com/TooTallNate/file-uri-to-path

    Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net>

    Permission is hereby granted, free of charge, to any person obtaining
    a copy of this software and associated documentation files (the
    'Software'), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to
    permit persons to whom the Software is furnished to do so, subject to
    the following conditions:

    The above copyright notice and this permission notice shall be
    included in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
    CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
    TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
    SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## zod 4.3.6 (MIT)

Schema validation, bundled into the daemon. https://github.com/colinhacks/zod

    MIT License

    Copyright (c) 2025 Colin McDonnell

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Claude Agent SDK 0.3.319 (Anthropic PBC; not open source)

`@anthropic-ai/claude-agent-sdk`, bundled into the daemon and used to run Claude chats. It is not under an open-source licence. Its `package.json` says `SEE LICENSE IN README.md`, and its `LICENSE.md` reads in full:

    (c) Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.

Its README points to Anthropic's Commercial Terms of Service (https://www.anthropic.com/legal/commercial-terms) and Privacy Policy. Use of the SDK, and of Claude Code, is governed by those terms. Anthropic PBC keeps its copyright.
