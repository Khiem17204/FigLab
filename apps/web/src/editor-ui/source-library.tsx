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
import type { ReactNode } from "react";

import type { FigLabClient } from "../api/client";
import { DerivedThumbnail } from "../figure-tools/derived-preview";
import type { UploadItem } from "./uploads";
import { uploadProgress, uploadStageLabel } from "./uploads";

export const ACCEPTED_ORIGINALS = "image/png,image/jpeg,image/tiff,.png,.jpg,.jpeg,.tif,.tiff";
export const IDLE_UPLOAD_STATUS = "Choose a PNG, JPEG, or TIFF original to upload.";

export function SourceLibrary({
  assets,
  loadingAssets = [],
  client,
  children,
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
  /** Originals still downloading; their derived previews show meanwhile. */
  loadingAssets?: AssetDescriptor[];
  client: FigLabClient;
  /** Further library tools, such as the arrange panel. */
  children?: ReactNode;
  selectedAssetId: string | undefined;
  previewUrl: (assetId: string) => string | undefined;
  uploads: UploadItem[];
  uploadStatus: string;
  /** Omitted for viewers, who cannot add originals. */
  onUpload?: (files: File[]) => void;
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
      {onUpload && (
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
      )}
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
      {loadingAssets.length > 0 && (
        <ul aria-label="Originals loading" className="upload-list">
          {loadingAssets.map((asset) => (
            <li className="upload-row loading-row" key={`loading-${asset.id}`}>
              <span className="thumb derived">
                <DerivedThumbnail asset={asset} client={client} minEdge={64} />
              </span>
              <span className="file-text">
                <b title={asset.filename}>{asset.filename}</b>
                <small>Downloading the original…</small>
                <ProgressBar label={`Loading original ${asset.filename}`} />
              </span>
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
        !uploads.length &&
        !loadingAssets.length && (
          <p className="library-note fl-hand-note">your originals will live here ✿</p>
        )
      )}
      {children}
    </aside>
  );
}

/** Progress and success already show in the upload rows and toasts; problems stay on screen. */
function needsAttention(status: string): boolean {
  return status !== IDLE_UPLOAD_STATUS && /rejected|failed|could not/i.test(status);
}
