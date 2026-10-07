import { Button } from "@figlab/ui";

import type { SaveStatus } from "../editor/autosave";

export function EditorToolbar({
  projectName,
  saveStatus,
  canUndo,
  canRedo,
  onBack,
  onUndo,
  onRedo,
}: {
  projectName: string;
  saveStatus: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <header className="app-header editor-header">
      <Button onClick={onBack}>Projects</Button>
      <h1>{projectName}</h1>
      <span role="status">
        {saveStatus === "conflict"
          ? "Save conflict"
          : saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "error"
              ? "Save error"
              : "Saved"}
      </span>
      <Button disabled={!canUndo} onClick={onUndo}>
        Undo
      </Button>
      <Button disabled={!canRedo} onClick={onRedo}>
        Redo
      </Button>
    </header>
  );
}

export function SaveProblemBanner({
  saveStatus,
  onReload,
  onDownloadJson,
}: {
  saveStatus: SaveStatus;
  onReload: () => void;
  onDownloadJson: () => void;
}) {
  if (saveStatus !== "conflict" && saveStatus !== "error") return null;
  return (
    <div className="conflict-banner" role="alert">
      {saveStatus === "conflict"
        ? "The project changed on the server. Your local work is retained."
        : "The project could not be saved. Your local work is retained."}
      <Button onClick={onReload}>Reload latest</Button>
      <Button onClick={onDownloadJson}>Download my JSON</Button>
    </div>
  );
}
