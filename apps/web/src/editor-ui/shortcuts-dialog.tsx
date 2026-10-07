import { Dialog, DialogContent, formatShortcut, Kbd } from "@figlab/ui";

export const EDITOR_SHORTCUTS: { group: string; items: { keys: string[]; action: string }[] }[] = [
  {
    group: "Editing",
    items: [
      { keys: ["Mod+Z"], action: "Undo" },
      { keys: ["Mod+Shift+Z"], action: "Redo" },
      { keys: ["Delete", "Backspace"], action: "Delete the selected panel" },
    ],
  },
  {
    group: "View",
    items: [
      { keys: ["Mod+="], action: "Zoom in" },
      { keys: ["Mod+-"], action: "Zoom out" },
      { keys: ["Mod+0"], action: "Fit artboard to screen" },
      { keys: ["Mod+1"], action: "Actual size (100% = 72 dpi)" },
      { keys: ["["], action: "Show or hide the library" },
      { keys: ["]"], action: "Show or hide the inspector" },
    ],
  },
  {
    group: "Help",
    items: [{ keys: ["?"], action: "Show this list" }],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        description="Shortcuts work whenever focus is not in a text field."
        size="lg"
        title="Keyboard shortcuts"
      >
        <div className="shortcut-groups">
          {EDITOR_SHORTCUTS.map((group) => (
            <section aria-label={group.group} className="shortcut-group" key={group.group}>
              <h3>{group.group}</h3>
              <dl>
                {group.items.map((item) => (
                  <div className="shortcut-row" key={item.action}>
                    <dt>{item.action}</dt>
                    <dd>
                      {item.keys.map((key, index) => (
                        <span key={key}>
                          {index > 0 && <span className="shortcut-or">or</span>}
                          <Kbd>{formatShortcut(key)}</Kbd>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
