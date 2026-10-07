import type { ImageProvenance } from "@figlab/editor-core";
import { Button } from "@figlab/ui";

export function ProvenanceSection({
  provenance,
  onShowInOriginal,
}: {
  provenance: ImageProvenance | undefined;
  onShowInOriginal: (assetId: string) => void;
}) {
  return (
    <>
      <h3>Provenance</h3>
      {provenance ? (
        <>
          <Button onClick={() => onShowInOriginal(provenance.assetId)}>Show in Original</Button>
          <p>
            Source crop x {provenance.viewport.x}, y {provenance.viewport.y}, width{" "}
            {provenance.viewport.width}, height {provenance.viewport.height}.
          </p>
          <p>
            Sibling panels:{" "}
            {provenance.siblingImageViewIds.length
              ? provenance.siblingImageViewIds.join(", ")
              : "none"}
          </p>
        </>
      ) : (
        <p>Source crop details appear here.</p>
      )}
    </>
  );
}
