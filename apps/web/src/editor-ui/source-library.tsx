import type { AssetDescriptor } from "@figlab/api-contract";

export function SourceLibrary({
  assets,
  uploadStatus,
  onUpload,
  onSelect,
}: {
  assets: AssetDescriptor[];
  uploadStatus: string;
  onUpload: (file: File) => void;
  onSelect: (assetId: string) => void;
}) {
  return (
    <aside aria-label="Source library" className="source-library">
      <h2>Source library</h2>
      <label className="upload-control">
        Upload original
        <input
          aria-label="Upload original"
          accept="image/png,image/jpeg,image/tiff"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) onUpload(file);
          }}
          type="file"
        />
      </label>
      <p role="status">{uploadStatus}</p>
      {assets.map((asset) => (
        <button
          className="source-item"
          key={asset.id}
          onClick={() => onSelect(asset.id)}
          type="button"
        >
          Original · {asset.filename}
        </button>
      ))}
    </aside>
  );
}
