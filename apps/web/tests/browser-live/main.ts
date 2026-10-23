import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
} from "../../src/browser/serverPictureInPicture";
import type { EnvironmentId } from "@specweave-studio/contracts";
const stats = {
  nativeRequests: 0,
  nativeExits: 0,
  lastError: "",
  opened: 0,
  gate: null as (() => void) | null,
  delayNextPlay: false,
  painted: 0,
};
let current: HTMLVideoElement | null = null;
const nativePlay = HTMLVideoElement.prototype.play;
HTMLVideoElement.prototype.play = function () {
  const play = nativePlay.call(this);
  if (!stats.delayNextPlay) return play;
  stats.delayNextPlay = false;
  return play.then(
    () =>
      new Promise<void>((resolve) => {
        stats.gate = resolve;
      }),
  );
};
Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, get: () => true });
Object.defineProperty(document, "pictureInPictureElement", {
  configurable: true,
  get: () => current,
});
HTMLVideoElement.prototype.requestPictureInPicture = async function () {
  stats.nativeRequests += 1;
  current = this;
  return {} as PictureInPictureWindow;
};
document.exitPictureInPicture = async () => {
  stats.nativeExits += 1;
  current = null;
};
const proof = document.querySelector<HTMLCanvasElement>("#proof")!;
function paint() {
  if (current && current.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    proof.width = current.videoWidth || 640;
    proof.height = current.videoHeight || 400;
    proof.getContext("2d")!.drawImage(current, 0, 0, proof.width, proof.height);
    stats.painted += 1;
  }
  requestAnimationFrame(paint);
}
requestAnimationFrame(paint);
const open = async (tabId = "tab-a") => {
  try {
    await openServerPictureInPicture({
      environmentId: "fixture" as EnvironmentId,
      threadId: "fixture",
      tabId,
      seed: null,
    });
    stats.opened += 1;
  } catch (error) {
    stats.lastError = String(error);
  }
  document.querySelector("#status")!.textContent = JSON.stringify(stats, null, 2);
};
document.querySelector("#open")!.addEventListener("click", () => void open());
document.querySelector("#close")!.addEventListener("click", closeServerPictureInPicture);
Object.assign(window, { liveStats: stats, openLive: open, closeLive: closeServerPictureInPicture });
