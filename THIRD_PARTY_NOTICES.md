# Third-party notices

SpecWithCode is an independently maintained product. No new project-wide license is granted for original SpecWithCode material. Previously distributed material retains the rights granted with those versions. Third-party code and assets retain their own licenses; these notices do not extend those licenses to unrelated original material.

## MIT-licensed code

Portions of this software carry the following notice.

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
