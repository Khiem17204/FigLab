import type { AssetDescriptor } from "@figlab/api-contract";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  DropZone,
  IconButton,
  ImageIcon,
  Mascot,
  PanelLeftIcon,
  ProgressBar,
} from "@figlab/ui";

import type { UploadItem } from "./uploads";
import { uploadProgress, uploadStageLabel } from "./uploads";

export const ACCEPTED_ORIGINALS = "image/png,image/jpeg,image/tiff,.png,.jpg,.jpeg,.tif,.tiff";
export const IDLE_UPLOAD_STATUS = "Choose a PNG, JPEG, or TIFF original to upload.";

export function SourceLibrary({
  assets,
  selectedAssetId,
  previewUrl,
  uploads,
  uploadStatus,
  onUpload,
  onRejectedFiles,
  onSelect,
  onDismissUpload,
  onCollapse,
}: {
  assets: AssetDescriptor[];
  selectedAssetId: string | undefined;
  previewUrl: (assetId: string) => string | undefined;
  uploads: UploadItem[];
  uploadStatus: string;
  onUpload: (files: File[]) => void;
  onRejectedFiles: (files: File[]) => void;
  onSelect: (assetId: string) => void;
  onDismissUpload: (key: string) => void;
  onCollapse: () => void;
}) {
  const working = uploads.some((item) => item.state === "active");
  return (
    <aside aria-label="Source library" className="source-library">
      <div className="pane-header">
        <h2>
          Originals <span className="count-pill">{assets.length}</span>
        </h2>
        <IconButton
          icon={<PanelLeftIcon />}
          label="Hide library"
          onClick={onCollapse}
          shortcut="["
          size="sm"
        />
      </div>
      <DropZone
        accept={ACCEPTED_ORIGINALS}
        buttonLabel="Choose files"
        hint="PNG, JPEG or TIFF. Originals are never changed."
        illustration={<Mascot mood={working ? "working" : "happy"} size={40} />}
        inputLabel="Upload original"
        onFiles={onUpload}
        onRejectedFiles={onRejectedFiles}
        title="Drop originals here"
      />
      <p
        className={needsAttention(uploadStatus) ? "library-status" : "fl-visually-hidden"}
        role="status"
      >
        {uploadStatus}
      </p>
      {uploads.length > 0 && (
        <ul aria-label="Uploads" className="upload-list">
          {uploads.map((item) => (
            <li className="upload-row" data-state={item.state} key={item.key}>
              <span className="thumb">
                {item.state === "error" ? <AlertIcon size={18} /> : <ImageIcon size={18} />}
              </span>
              <span className="file-text">
                <b title={item.name}>{item.name}</b>
                <small>{item.state === "error" ? item.message : uploadStageLabel(item)}</small>
                {item.state !== "error" && (
                  <ProgressBar
                    label={`Uploading ${item.name}`}
                    tone={item.state === "done" ? "success" : "primary"}
                    value={uploadProgress(item)}
                  />
                )}
              </span>
              {item.state === "error" && (
                <IconButton
                  icon={<CloseIcon size={16} />}
                  label={`Dismiss ${item.name}`}
                  onClick={() => onDismissUpload(item.key)}
                  size="sm"
                  tooltip={false}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {assets.length > 0 ? (
        <ul aria-label="Originals" className="asset-list">
          {assets.map((asset) => {
            const thumbnail = previewUrl(asset.id);
            return (
              <li key={asset.id}>
                <button
                  aria-current={asset.id === selectedAssetId ? "true" : undefined}
                  aria-label={`Original · ${asset.filename}`}
                  className="asset-item"
                  onClick={() => onSelect(asset.id)}
                  type="button"
                >
                  <span className="thumb">
                    {thumbnail ? <img alt="" src={thumbnail} /> : <ImageIcon size={18} />}
                  </span>
                  <span className="file-text">
                    <b>{asset.filename}</b>
                    <small>
                      {asset.widthPx} × {asset.heightPx} · {asset.bitDepth}-bit
                    </small>
                  </span>
                  <span className="verified-mark" title="Checksum and format verified">
                    <CheckIcon size={16} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        !uploads.length && (
          <p className="library-note fl-hand-note">your originals will live here ✿</p>
        )
      )}
    </aside>
  );
}

/** Progress and success already show in the upload rows and toasts; problems stay on screen. */
function needsAttention(status: string): boolean {
  return status !== IDLE_UPLOAD_STATUS && /rejected|failed|could not/i.test(status);
}
