import type { VoiceCallMicrophone } from "@specweave-studio/client-runtime/voice-call";

const FRAME_SIZE = 1024;

/**
 * Opens the microphone with the browser's echo cancellation on, so the
 * coordinator's voice coming out of the speakers is not heard as the caller.
 * That only works because replies are played through this page's audio too.
 */
export async function openCallMicrophone(
  onFrame: (frame: Float32Array) => void,
): Promise<VoiceCallMicrophone> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This window cannot use a microphone.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new Error(
        "Microphone access is off for SpecWithCode. Turn it on in System Settings › Privacy & Security › Microphone.",
        { cause: error },
      );
    }
    if (name === "NotFoundError") throw new Error("No microphone was found.", { cause: error });
    throw new Error("Could not open the microphone.", { cause: error });
  }
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let silent: GainNode;
  try {
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    // ScriptProcessor keeps this free of a separately loaded worklet module; a
    // 1024-sample frame is ~21 ms at 48 kHz, plenty for voice detection.
    processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);
    silent = context.createGain();
  } catch (error) {
    // The microphone is already open; never leave it on for a call that failed to start.
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => undefined);
    throw new Error("Could not open the microphone.", { cause: error });
  }
  silent.gain.value = 0;
  processor.onaudioprocess = (event) => {
    onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  return {
    sampleRate: context.sampleRate,
    close: () => {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      silent.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
    },
  };
}

/** Plays encoded audio; resolves when it ends or the signal aborts. */
export async function playCallAudio(audio: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const context = new AudioContext();
  try {
    const copy = audio.slice().buffer;
    const buffer = await context.decodeAudioData(copy);
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const stop = () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        resolve();
      };
      source.addEventListener("ended", () => resolve(), { once: true });
      signal.addEventListener("abort", stop, { once: true });
      source.start();
    });
  } finally {
    void context.close().catch(() => undefined);
  }
}
