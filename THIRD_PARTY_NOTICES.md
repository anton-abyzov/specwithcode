# Third-party notices

SpecWithCode is an independently maintained product, released under the MIT License in [LICENSE](LICENSE). Third-party code and assets keep their own licenses and notices, listed below.

## Inherited code

The retained portions of T3 Code, pinned in UPSTREAM.md, carry the following original notice verbatim. This attribution describes source provenance, not product affiliation or endorsement.

MIT License

Copyright (c) 2026 T3 Tools Inc.

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

## Linux voice

The Linux app bundles `whisper-cli` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT License, Copyright (c) 2023-2026 The ggml authors), built from tag `v1.9.5`. The license text is in that repository's `LICENSE` file.

With the user's consent, the app downloads these on first use. They are not distributed with SpecWithCode and keep their own terms:

- the OpenAI Whisper `small` model in ggml form (MIT License), from `huggingface.co/ggerganov/whisper.cpp`;
- [Piper](https://github.com/rhasspy/piper) 2023.11.14-2 (MIT License), whose archive includes eSpeak NG (GPL-3.0-or-later) and ONNX Runtime (MIT License);
- the Piper voice `en_US-lessac-medium`, from `huggingface.co/rhasspy/piper-voices`, under the terms in its model card.

## Whiteboards

The whiteboard editor embeds [Excalidraw](https://github.com/excalidraw/excalidraw) `@excalidraw/excalidraw` 0.18.1 (MIT License, Copyright (c) 2020 Excalidraw), with its bundled fonts served from the app, and the [Radix UI primitives](https://github.com/radix-ui/primitives) it depends on (MIT License, Copyright (c) 2022 WorkOS). Each license text is in its repository's `LICENSE` file; the full list of bundled packages and their notices is in Settings, under open source licenses.

## Live documents

Live editing of sheets merges changes with [Yjs](https://github.com/yjs/yjs) `yjs` 13.6.33 (MIT License, Copyright (c) 2023 Kevin Jahns and the Yjs contributors), and the packages it depends on: [lib0](https://github.com/dmonad/lib0) 0.2.120 (MIT License, Copyright (c) 2019 Kevin Jahns) and [isomorphic.js](https://github.com/dmonad/isomorphic.js) 0.2.5 (MIT License, Copyright (c) 2020 Kevin Jahns). Each license text is in its repository's `LICENSE` file; the full list of bundled packages and their notices is in Settings, under open source licenses.
