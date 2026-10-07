import {
  AlertIcon,
  ArrowLeftIcon,
  Button,
  CheckIcon,
  DownloadIcon,
  IconButton,
  KeyboardIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RedoIcon,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  UndoIcon,
} from "@figlab/ui";
import type { ReactNode } from "react";

import type { SaveStatus } from "../editor/autosave";

const saveLabels: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  conflict: "Save conflict",
  error: "Save error",
};

export function EditorToolbar({
  projectName,
  saveStatus,
  canUndo,
  canRedo,
  canExport,
  exporting,
  libraryOpen,
  inspectorOpen,
  account,
  onBack,
  onUndo,
  onRedo,
  onExport,
  onToggleLibrary,
  onToggleInspector,
  onShowShortcuts,
}: {
  projectName: string;
  saveStatus: SaveStatus;
  canUndo: boolean;
  canRedo: boolean;
  canExport: boolean;
  exporting: boolean;
  libraryOpen: boolean;
  inspectorOpen: boolean;
  account?: ReactNode;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onToggleLibrary: () => void;
  onToggleInspector: () => void;
  onShowShortcuts: () => void;
}) {
  const problem = saveStatus === "conflict" || saveStatus === "error";
  return (
    <header className="app-header editor-header">
      <Button icon={<ArrowLeftIcon size={16} />} onClick={onBack} size="sm" variant="ghost">
        Projects
      </Button>
      <span aria-hidden="true" className="header-divider" />
      <h1 className="editor-title" title={projectName}>
        {projectName}
      </h1>
      <span className="save-chip" data-state={saveStatus}>
        {problem ? (
          <AlertIcon size={14} />
        ) : saveStatus === "saving" ? (
          <span aria-hidden="true" className="fl-spinner" />
        ) : (
          <CheckIcon size={14} />
        )}
        <span role="status">{saveLabels[saveStatus]}</span>
      </span>
      <span className="app-header-spacer" />
      <Toolbar className="editor-tools" label="Editor">
        <ToolbarGroup>
          <IconButton
            disabled={!canUndo}
            icon={<UndoIcon />}
            label="Undo"
            onClick={onUndo}
            shortcut="Mod+Z"
          />
          <IconButton
            disabled={!canRedo}
            icon={<RedoIcon />}
            label="Redo"
            onClick={onRedo}
            shortcut="Mod+Shift+Z"
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        <IconButton
          aria-pressed={libraryOpen}
          icon={<PanelLeftIcon />}
          label="Show library"
          onClick={onToggleLibrary}
          shortcut="["
        />
        <IconButton
          aria-pressed={inspectorOpen}
          icon={<PanelRightIcon />}
          label="Show inspector"
          onClick={onToggleInspector}
          shortcut="]"
        />
        <IconButton
          icon={<KeyboardIcon />}
          label="Keyboard shortcuts"
          onClick={onShowShortcuts}
          shortcut="?"
          tooltipAlign="end"
        />
        <Button
          disabled={!canExport}
          icon={<DownloadIcon size={16} />}
          loading={exporting}
          onClick={onExport}
          variant="primary"
        >
          Export PNG
        </Button>
      </Toolbar>
      {account}
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
      <AlertIcon size={18} />
      <p>
        {saveStatus === "conflict"
          ? "The project changed on the server. Your local work is retained."
          : "The project could not be saved. Your local work is retained."}
      </p>
      <Button onClick={onReload} size="sm">
        Reload latest
      </Button>
      <Button onClick={onDownloadJson} size="sm" variant="ghost">
        Download my JSON
      </Button>
    </div>
  );
}
