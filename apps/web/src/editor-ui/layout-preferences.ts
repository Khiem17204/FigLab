import { useCallback, useState } from "react";

export interface EditorLayout {
  libraryOpen: boolean;
  inspectorOpen: boolean;
  originalCollapsed: boolean;
}

const storageKey = "figlab-editor-layout";
const defaults: EditorLayout = { libraryOpen: true, inspectorOpen: true, originalCollapsed: false };

function read(): EditorLayout {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? "{}") as unknown;
    if (!stored || typeof stored !== "object") return defaults;
    const value = stored as Partial<Record<keyof EditorLayout, unknown>>;
    return {
      libraryOpen:
        typeof value.libraryOpen === "boolean" ? value.libraryOpen : defaults.libraryOpen,
      inspectorOpen:
        typeof value.inspectorOpen === "boolean" ? value.inspectorOpen : defaults.inspectorOpen,
      originalCollapsed:
        typeof value.originalCollapsed === "boolean"
          ? value.originalCollapsed
          : defaults.originalCollapsed,
    };
  } catch {
    return defaults;
  }
}

/** Which editor panes are open; remembered per browser because it is only a convenience. */
export function useEditorLayout(): [EditorLayout, (patch: Partial<EditorLayout>) => void] {
  const [layout, setLayout] = useState(read);
  const update = useCallback((patch: Partial<EditorLayout>) => {
    setLayout((current) => {
      const next = { ...current, ...patch };
      try {
        globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Unavailable storage only means the layout is not remembered.
      }
      return next;
    });
  }, []);
  return [layout, update];
}
