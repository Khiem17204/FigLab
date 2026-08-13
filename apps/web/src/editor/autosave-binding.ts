import type { StoreApi } from "zustand/vanilla";

import type { AutosaveController } from "./autosave";
import type { EditorSessionState } from "./session-store";

export function bindAutosave(
  session: StoreApi<EditorSessionState>,
  autosave: AutosaveController,
): () => void {
  return session.subscribe((next, previous) => {
    if (next.document !== previous.document) autosave.schedule();
  });
}
