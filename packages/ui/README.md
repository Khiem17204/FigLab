# @figlab/ui

FigLab's design system ("Bench Notebook"): CSS-variable tokens, self-hosted fonts, and
accessible React primitives. Apps import the stylesheet once and the components where needed.

```ts
import "@figlab/ui/styles.css";
import { Button, Section, Slider, useToast } from "@figlab/ui";
```

## Tokens and themes

`src/styles/tokens.css` defines every color, radius, shadow, font and duration as `--fl-*`
variables. Light values sit on `:root`; the dusk-blue dark theme applies when the OS prefers
dark (unless `<html data-theme="light">`) or when `<html data-theme="dark">`. `useThemePreference`
reads and stores the user's choice. Components use tokens only, so new UI should too: no
literal colors outside `tokens.css`. The two exceptions are scientific surfaces that must not
follow the theme: the white artboard paper and the fixed neutral surround behind originals.

Text pairs in both themes meet WCAG AA. The web app's `e2e/a11y.spec.ts` runs axe (WCAG 2.2 AA)
over the dashboard, dialogs and editor in light and dark; add new screens to it.

## Components

| Component | Notes |
| --- | --- |
| `Button` | `variant`: primary, secondary, ghost, danger, danger-solid. `size`, `icon`, `loading`, `block`. Defaults to `type="button"`. |
| `IconButton` | `label` is the accessible name and the tooltip; `shortcut` (e.g. `"Mod+Z"`) shows in the tooltip and sets `aria-keyshortcuts`. |
| `Tooltip`, `Kbd` | Presentational hint on hover/focus; the trigger must already have a name. |
| `Input`, `Field` | `Field` labels one control and wires `hint`/`error` through `aria-describedby` and `aria-invalid`. |
| `Slider` | Range plus exact number entry. The range is named by `label`; the number box is "`label` value". |
| `Segmented` | Native radio group in a `fieldset`. |
| `Switch` | Styled native checkbox, so it keeps the checkbox role. |
| `Panel`, `Section` | `Section` is a collapsible inspector block with optional `actions` beside its title. |
| `Toolbar`, `ToolbarGroup`, `ToolbarSeparator` | `role="toolbar"`; arrow keys move between controls. |
| `ToastProvider`, `useToast` | One polite live region. Toasts carry no status/alert role, so keep persistent inline status text for anything tests or screen readers must find. |
| `Dialog`, `DialogContent`, `ConfirmDialog` | Radix Dialog. Focus returns to the control that opened it, even without `DialogTrigger`. |
| `EmptyState`, `Mascot` | Friendly empty states with Pip, the pipette-drop mascot (`mood`: happy, sleepy, working, oops, proud). Pip is decorative (`aria-hidden`). |
| `DropZone` | Drag-and-drop plus a real file input named by `inputLabel`. |
| `ProgressBar`, `Badge`, `Avatar`, `AccountMenu` | Progress takes 0–1 or nothing for indeterminate. |

## Adding an editor tool

The inspector in `apps/web/src/editor-ui/figlab-editor.tsx` is a stack of `Section`s. A new tool
is a component under `apps/web/src/editor-ui/inspector/` that renders one `Section` (title,
controls, optional `actions`) and receives the selected object plus a callback that issues an
editor command. Toolbar actions go in `editor-toolbar.tsx` as `IconButton`s with a `shortcut`,
and new shortcuts belong in `shortcuts-dialog.tsx`.
