import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { cx } from "./cx";
import { Kbd } from "./kbd";
import { Tooltip } from "./tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon, decorative. */
  icon?: ReactNode;
  /** Shows a spinner and marks the button busy; it stays focusable. */
  loading?: boolean;
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  block = false,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      aria-busy={loading || undefined}
      className={cx("fl-button", className)}
      data-block={block ? "" : undefined}
      data-size={size}
      data-variant={variant}
      type={type}
      {...props}
    >
      {loading ? <span aria-hidden="true" className="fl-spinner" /> : icon}
      {children}
    </button>
  );
}

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  /** Displayed in the tooltip and exposed as aria-keyshortcuts, e.g. "Mod+Z". */
  shortcut?: string;
  variant?: "ghost" | "secondary" | "danger";
  size?: "sm" | "md";
  tooltip?: boolean;
  tooltipSide?: "top" | "bottom";
  tooltipAlign?: "start" | "center" | "end";
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon,
  shortcut,
  variant = "ghost",
  size = "md",
  tooltip = true,
  tooltipSide,
  tooltipAlign,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  const button = (
    <button
      aria-keyshortcuts={shortcut ? toAriaShortcut(shortcut) : undefined}
      aria-label={label}
      className={cx("fl-icon-button", className)}
      data-size={size}
      data-variant={variant}
      type={type}
      {...props}
    >
      {icon}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip
      {...(tooltipAlign ? { align: tooltipAlign } : {})}
      content={
        <>
          {label}
          {shortcut && <Kbd>{formatShortcut(shortcut)}</Kbd>}
        </>
      }
      {...(tooltipSide ? { side: tooltipSide } : {})}
    >
      {button}
    </Tooltip>
  );
}

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** Renders "Mod+Shift+Z" as "⌘⇧Z" on Apple platforms and "Ctrl+Shift+Z" elsewhere. */
export function formatShortcut(shortcut: string, mac = isMac()): string {
  const parts = shortcut.split("+");
  if (!mac) return parts.map((part) => (part === "Mod" ? "Ctrl" : part)).join("+");
  const symbols: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" };
  return parts.map((part) => symbols[part] ?? part).join("");
}

function toAriaShortcut(shortcut: string): string {
  return shortcut.replace(/\bMod\b/g, isMac() ? "Meta" : "Control");
}
