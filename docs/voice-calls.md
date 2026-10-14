# Voice calls

Voice replies default to free on-device speech. The native helper chooses the highest-quality installed voice for the system language, prefers natural Siri voices and modern Apple voices over legacy synthesizers at equal quality, and speaks at a calm conversational rate. No speech API key or subscription is needed. Normal agent text usage still applies.

Open **Voice settings** (the audio-wave icon beside the call button) while a call is ended. Choose Automatic or an installed local voice, set Relaxed/Natural/Brisk pacing, and use **Preview free voice** without opening the microphone. Enhanced/Premium voices can be downloaded through macOS Accessibility → Read & Speak (Spoken Content on earlier macOS); this app never silently downloads voices or changes system preferences.

## Optional ElevenLabs

Choose **ElevenLabs · Your own key**, enter your personal ElevenLabs API key and voice ID, and save. Reply text goes to ElevenLabs and is billed to that key's account; microphone transcription remains local. No developer key or personal cloned voice ships in the app. A downloaded MP3 is a sample, not a voice ID.

The desktop main process encrypts the key with OS-backed Electron safeStorage and stores device-local preferences in its private state directory. Getters return only a saved-key indicator; settings are never included in synced client settings. If encryption is unavailable, saving a key is refused. Remove the key to return to free local speech. Environment variables do not opt users into paid speech.

Flash v2.5 generates 44.1 kHz MP3 with neutral speed, stability 0.5 and similarity 0.75. Requests time out after 30 seconds. Ending a call cancels outstanding cloud synthesis. Cloud errors remain explicit rather than silently changing voices. The normal spoken-answer length limit applies.

Managed premium voice is labeled **Coming soon** only. There is no checkout, credential fulfillment, shared billing, or paid entitlement yet.

API reference: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
