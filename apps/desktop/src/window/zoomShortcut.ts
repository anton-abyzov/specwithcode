/** App zoom uses the native menu; never admit AltGr or other modified chords. */
export const isAppZoomShortcut = (input: Electron.Input, platform: NodeJS.Platform): boolean => {
  if (input.type !== "keyDown" || input.isComposing || input.alt) return false;
  if (platform === "darwin" ? !input.meta || input.control : !input.control || input.meta) {
    return false;
  }
  // Plus may arrive as a plus key, or as "=" with Shift on the equals key.
  if (input.key === "+" || (input.shift && input.code === "Equal")) return true;
  return !input.shift && ["=", "-", "0"].includes(input.key);
};
