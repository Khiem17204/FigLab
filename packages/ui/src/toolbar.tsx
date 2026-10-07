import type { HTMLAttributes, KeyboardEvent } from "react";

import { cx } from "./cx";

const focusableSelector =
  "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** A labelled toolbar. Left/Right arrows move focus between its controls; Tab still works. */
export function Toolbar({
  label,
  className,
  onKeyDown,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: string }) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    if (event.target instanceof HTMLInputElement) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector)];
    const index = items.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      items[(index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  return (
    <div
      aria-label={label}
      className={cx("fl-toolbar", className)}
      onKeyDown={handleKeyDown}
      role="toolbar"
      {...props}
    />
  );
}

export function ToolbarGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("fl-toolbar-group", className)} {...props} />;
}

export function ToolbarSeparator() {
  return <span aria-hidden="true" className="fl-toolbar-separator" />;
}

export function ToolbarSpacer() {
  return <span aria-hidden="true" className="fl-toolbar-spacer" />;
}
