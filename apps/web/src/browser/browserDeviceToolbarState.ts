import type { PreviewViewportSetting } from "@specweave-studio/contracts";

export async function commitViewportAndAspectRatio(
  setting: PreviewViewportSetting,
  aspectRatio: number | null,
  onChange: (setting: PreviewViewportSetting) => Promise<void>,
  onAspectRatioChange: (aspectRatio: number | null) => void,
): Promise<void> {
  await onChange(setting);
  onAspectRatioChange(aspectRatio);
}
