import type { AssetDescriptor } from "@figlab/api-contract";
import { type ImageProvenance, normalizedToPixelRect } from "@figlab/editor-core";
import { Button, LocateIcon, Section } from "@figlab/ui";

export function ProvenanceSection({
  provenance,
  asset,
  onShowInOriginal,
}: {
  provenance: ImageProvenance;
  asset: AssetDescriptor | undefined;
  onShowInOriginal: (assetId: string) => void;
}) {
  const { viewport } = provenance;
  return (
    <Section title="Provenance">
      <Button
        block
        icon={<LocateIcon size={16} />}
        onClick={() => onShowInOriginal(provenance.assetId)}
        size="sm"
      >
        Show in Original
      </Button>
      <dl className="facts">
        <dt>Source</dt>
        <dd title={asset?.filename}>{asset?.filename ?? provenance.assetId}</dd>
        {asset && (
          <>
            <dt>Source pixels</dt>
            <dd className="fl-mono">{formatPixels(asset, viewport)}</dd>
          </>
        )}
      </dl>
      <p className="provenance-detail fl-mono">
        Source crop x {viewport.x}, y {viewport.y}, width {viewport.width}, height {viewport.height}
        .
      </p>
      <p className="provenance-detail">
        Sibling panels:{" "}
        {provenance.siblingImageViewIds.length ? provenance.siblingImageViewIds.join(", ") : "none"}
      </p>
    </Section>
  );
}

function formatPixels(asset: AssetDescriptor, viewport: ImageProvenance["viewport"]): string {
  const rect = normalizedToPixelRect(viewport, asset.widthPx, asset.heightPx);
  return `${rect.width} × ${rect.height}`;
}
