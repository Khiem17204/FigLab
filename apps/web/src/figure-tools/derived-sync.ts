import { syncDerivedTransforms, type TextMetrics } from "@figlab/image-processing";
import { useEffect } from "react";
import type { StoreApi } from "zustand/vanilla";

import type { EditorSessionState } from "../editor/session-store";

/**
 * Keeps the stored boxes of derived annotations (scale bars, lane tables, MW labels, zoom links)
 * equal to what they draw, so selection and arrangement use real bounds. Rendering never
 * depends on these stored sizes, so this is not a separate undo step.
 */
export function useDerivedSync(session: StoreApi<EditorSessionState>, metrics: TextMetrics): void {
  useEffect(() => {
    const sync = (document: EditorSessionState["document"]) => {
      const synced = syncDerivedTransforms(document, metrics);
      if (synced !== document) session.setState({ document: synced });
    };
    sync(session.getState().document);
    return session.subscribe((next, previous) => {
      if (next.document !== previous.document) sync(next.document);
    });
  }, [session, metrics]);
}
