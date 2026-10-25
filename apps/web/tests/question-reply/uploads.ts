/* Uploads finish at once in the fixture; the rest of the queue is the real one. */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useAttachmentUploadStore } from "../../src/lib/attachmentUploadQueue";

export * from "../../src/lib/attachmentUploadQueue";

declare global {
  interface Window {
    __released?: string[];
  }
}

export function startAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: { readonly id: string };
}): void {
  const uploads = useAttachmentUploadStore.getState().uploadsByImageId;
  if (uploads[input.image.id]) return;
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      ...uploads,
      [input.image.id]: {
        status: "ready",
        environmentId: input.environmentId,
        attachmentId: `uploaded-${input.image.id}`,
      },
    },
  } as never);
}

export async function awaitAttachmentUploads(): Promise<void> {}

export function releaseDraftAttachment(image: { readonly id: string }): void {
  (window.__released ??= []).push(image.id);
}
