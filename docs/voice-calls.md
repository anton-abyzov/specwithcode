# Voice calls and dictation

Voice is in the coordinator composer of the Mac and Linux desktop apps. The phone button starts a call. The microphone button dictates: press it, talk, and each finished phrase lands at the cursor in the message box, unsent, until you press it again. The microphone is open only during a call or dictation, after one in-app consent. Windows has no voice controls yet.

## Linux

Speech to text is whisper.cpp, bundled in the app, with the Whisper `small` q5_1 model. Replies use Piper with the `en_US-lessac-medium` voice unless ElevenLabs is selected. The first call or dictation downloads about 268 MB, after consent, from pinned URLs checked by SHA-256, into `~/.specwithcode/voice`. After that no network call is made and audio never leaves the machine. Spoken replies are English only. Linux has no system microphone switch for the app to read, so the in-app consent and the per-window permission check are the gate.

Dictation and calls listen in the language chosen in Settings › General › Dictation language. **System** is the computer's language. **Detect from speech** (Linux only) works out the language of each phrase; it runs the model twice, so a phrase takes about one and a half times as long, and background noise can come back as words in any language.

Three things keep a phrase quick and clean:

- A speech detector (Silero VAD, a 0.9 MB file among the speech files) hears each recording before Whisper does. Typing, a breath, a hum or a click has no speech in it, so nothing is written. Without it Whisper answers such sounds with a fluent sentence. An install set up before the detector existed is asked once to download it; if that download fails, voice still works and asks again next time.
- Whisper's encoder window is sized to the recording instead of a fixed 30 seconds, which makes a short phrase two to three times faster with the same text.
- A recording with no speech level at all is never sent to the recognizer.

If no microphone is found, plug in a headset or USB microphone and check the input in Sound settings.

## Your vocabulary

Two lists feed speech recognition: the product's own words, and yours.

The product's words (SpecWithCode, SpecWeave, worktree, increment, coordinator, Claude Code, Codex and the like) ship with the app in `apps/desktop/src/voice/productVocabulary.ts` and work on a new install with nothing typed. Voice settings shows them under the editor.

In Voice settings, **Your vocabulary** lists your names and terms, one per line, or `heard => written`. Earlier lines count most. The list stays in `vocabulary.json` in the voice folder, per machine, and is never sent to a server. Lines that look like passwords, keys, emails or phone numbers are refused.

Both lists are used twice:

- As a hint before recognition. The product's words go first, then yours, about 500 characters in all on Linux (Whisper's limit) and 100 terms on Mac (Apple's contextual strings, whose effect is not guaranteed). A hint raises the odds of a word; it does not guarantee the spelling.
- As a correction after recognition, on every term of both lists. A term fixes casing and split forms ("spec weave" and "spec-weave" become "SpecWeave"), and a `heard => written` line replaces text ("work tree" becomes "worktree"). This is the part that always works, so a word the engine keeps mishearing belongs in a `heard => written` line.

A line of your own for a product word wins when it says something: a replacement, or its own capitals. An all-lowercase line (`specweave`, as an imported list often has) says nothing about casing, so the product's spelling stands. A lowercase term never lowercases an ordinary capital: with `kubernetes` in the list, "Kubernetes" stays as heard.

On Linux the hint terms are passed to `whisper-cli` as a command-line argument, which other users on a shared machine can see in the process list while a phrase is transcribed.

## Diagnostics

Each phrase and each spoken reply adds attributes to its own span in the desktop trace (`userdata/logs/desktop.trace.ndjson`, channel `desktop:voice-transcribe` or `desktop:voice-synthesize`): `voice.engine`, `voice.language`, `voice.audioMs`, `voice.peak`, `voice.engineMs`, `voice.outcome`, `voice.characters`, `voice.hintCharacters` and, on a failure, `voice.error` (`timeout`, `exit 3`, `ENOENT`). `voice.outcome` is `text`, `empty` (the detector or the engine heard no speech), `quiet`, `invented`, `script`, `echo` or `error`. The words themselves and the audio are never written.

## Spoken replies on Mac

Voice replies default to free on-device speech. The native helper chooses the highest-quality installed voice for the system language, prefers natural Siri voices and modern Apple voices over legacy synthesizers at equal quality, and speaks at a calm conversational rate. No speech API key or subscription is needed. Normal agent text usage still applies.

Open **Voice settings** (the audio-wave icon beside the call button) while a call is ended. Choose Automatic or an installed local voice, set Relaxed/Natural/Brisk pacing, and use **Preview free voice** without opening the microphone. Enhanced/Premium voices can be downloaded through macOS Accessibility → Read & Speak (Spoken Content on earlier macOS); this app never silently downloads voices or changes system preferences.

## Optional ElevenLabs

Choose **ElevenLabs · Your own key**, enter your personal ElevenLabs API key and voice ID, and save. Reply text goes to ElevenLabs and is billed to that key's account; microphone transcription remains local. No developer key or personal cloned voice ships in the app. A downloaded MP3 is a sample, not a voice ID.

The desktop main process encrypts the key with OS-backed Electron safeStorage and stores device-local preferences in its private state directory. Getters return only a saved-key indicator; settings are never included in synced client settings. If encryption is unavailable, saving a key is refused. Remove the key to return to free local speech. Environment variables do not opt users into paid speech.

Flash v2.5 generates 44.1 kHz MP3 with neutral speed, stability 0.5 and similarity 0.75. Requests time out after 30 seconds. Ending a call cancels outstanding cloud synthesis. Cloud errors remain explicit rather than silently changing voices. The normal spoken-answer length limit applies.

Managed premium voice is labeled **Coming soon** only. There is no checkout, credential fulfillment, shared billing, or paid entitlement yet.

API reference: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
