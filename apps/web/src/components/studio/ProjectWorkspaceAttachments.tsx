import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatAttachment, EnvironmentId } from "@specweave-studio/contracts";
import { formatAttachmentSize } from "@specweave-studio/client-runtime/state/attachments";
import { FileTextIcon } from "lucide-react";
import { useAssetUrlState } from "../../assets/assetUrls";
import { isImageAttachment } from "../../types";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tip } from "./shell/Tip";

/** A signed URL for one captured attachment's bytes. */
function useAttachmentUrl(environmentId: EnvironmentId, attachment: ChatAttachment) {
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
      disposition: "inline" as const,
    }),
    [attachment.id, attachment.name, attachment.mimeType],
  );
  return useAssetUrlState(environmentId, resource);
}

function ImageThumbnail({
  environmentId,
  attachment,
  onUrl,
  onOpen,
}: {
  environmentId: EnvironmentId;
  attachment: ChatAttachment;
  /** Reports the loaded URL, so the preview can page through every image of the message. */
  onUrl: (id: string, url: string | null) => void;
  onOpen: () => void;
}) {
  const asset = useAttachmentUrl(environmentId, attachment);
  const url = asset._tag === "Success" ? asset.url : null;
  useEffect(() => {
    onUrl(attachment.id, url);
  }, [attachment.id, url, onUrl]);
  return (
    <Tip label={attachment.name}>
      <button
        type="button"
        className="project-captured-image"
        aria-label={`Preview ${attachment.name}`}
        disabled={url === null}
        onClick={onOpen}
      >
        {url ? (
          <img src={url} alt={attachment.name} loading="lazy" />
        ) : (
          <span>{asset._tag === "Failure" ? "Image unavailable" : attachment.name}</span>
        )}
      </button>
    </Tip>
  );
}

export function ProjectWorkspaceAttachments({
  environmentId,
  attachments,
}: {
  environmentId: EnvironmentId;
  attachments: ReadonlyArray<ChatAttachment>;
}) {
  const [urls, setUrls] = useState<Readonly<Record<string, string>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * The gallery is fixed when it opens: an image that finishes loading later
   * must not shift what the arrows step through under the person.
   */
  const [gallery, setGallery] = useState<ExpandedImagePreview | null>(null);
  const close = useCallback(() => {
    setOpenId(null);
    setGallery(null);
  }, []);
  const reportUrl = useCallback((id: string, url: string | null) => {
    setUrls((current) => {
      if ((current[id] ?? null) === url) return current;
      const next = { ...current };
      if (url === null) delete next[id];
      else next[id] = url;
      return next;
    });
  }, []);
  if (!attachments.length) return null;
  const images = attachments.filter(isImageAttachment);
  const files = attachments.filter((attachment) => !isImageAttachment(attachment));
  const openImage = (id: string) =>
    setGallery(
      buildExpandedImagePreview(
        images.map((image) => {
          const previewUrl = urls[image.id];
          return previewUrl ? { ...image, previewUrl } : image;
        }),
        id,
      ),
    );
  const openFile = files.find((file) => file.id === openId);
  return (
    <div className="project-captured-attachments" aria-label="Message attachments">
      {images.length > 0 && (
        <div className="project-captured-images">
          {images.map((image) => (
            <ImageThumbnail
              key={image.id}
              environmentId={environmentId}
              attachment={image}
              onUrl={reportUrl}
              onOpen={() => openImage(image.id)}
            />
          ))}
        </div>
      )}
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          className="project-captured-file"
          aria-label={`Preview ${file.name}`}
          onClick={() => setOpenId(file.id)}
        >
          <FileTextIcon aria-hidden />
          <span className="project-captured-file-name">{file.name}</span>
          {file.sizeBytes > 0 && (
            <span className="project-captured-file-size">
              {formatAttachmentSize(file.sizeBytes)}
            </span>
          )}
        </button>
      ))}
      {gallery && <ExpandedImageDialog preview={gallery} onClose={close} />}
      {openFile && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          <DialogPopup
            className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">{openFile.name}</DialogTitle>
            <AttachmentFilePreview
              name={openFile.name}
              mimeType={openFile.mimeType}
              sizeBytes={openFile.sizeBytes}
              asset={{ environmentId, attachmentId: openFile.id }}
              origin="Coordinator attachment"
              onClose={close}
            />
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
