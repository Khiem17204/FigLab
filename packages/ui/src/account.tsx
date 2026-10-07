import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { cx } from "./cx";
import { CheckIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "./icons";
import type { ThemePreference } from "./theme";

export function initials(email: string): string {
  const name = email.split("@")[0] ?? "";
  const parts = name.split(/[._\-+]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase() || "?";
}

function hue(email: string): number {
  let total = 0;
  for (const char of email) total = (total + char.charCodeAt(0)) % 997;
  return total % 4;
}

export function Avatar({ email, className }: { email: string; className?: string }) {
  return (
    <span aria-hidden="true" className={cx("fl-avatar", className)} data-hue={hue(email)}>
      {initials(email)}
    </span>
  );
}

const themes: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: "system", label: "Match system", icon: <MonitorIcon size={16} /> },
  { value: "light", label: "Light", icon: <SunIcon size={16} /> },
  { value: "dark", label: "Dark", icon: <MoonIcon size={16} /> },
];

/**
 * The signed-in account: avatar and email as a menu button, with theme choices and sign out.
 * `children` render extra menu items (each should be a `MenuItem`).
 */
export function AccountMenu({
  email,
  badge,
  theme,
  onThemeChange,
  onSignOut,
  showEmail = true,
  children,
}: {
  email: string;
  badge?: ReactNode;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSignOut?: () => void;
  showEmail?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role^='menuitem']")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(items.length - 1);
    } else if (event.key === "Tab") setOpen(false);
  };
  return (
    <div className="fl-menu-anchor" ref={anchor}>
      <button
        aria-controls={open ? `${id}-menu` : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={showEmail ? undefined : `Account ${email}`}
        className="fl-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={trigger}
        type="button"
      >
        <Avatar email={email} />
        {showEmail && <span className="fl-menu-trigger-label">{email}</span>}
      </button>
      {badge}
      {open && (
        <div
          aria-label="Account"
          className="fl-menu"
          id={`${id}-menu`}
          onKeyDown={onMenuKey}
          ref={menu}
          role="menu"
        >
          <div className="fl-menu-label" role="presentation">
            Signed in as
            <strong>{email}</strong>
          </div>
          {children}
          <hr className="fl-menu-separator" />
          <div className="fl-menu-label" role="presentation">
            Theme
          </div>
          {themes.map((option) => (
            <button
              aria-checked={theme === option.value}
              className="fl-menu-item"
              key={option.value}
              onClick={() => onThemeChange(option.value)}
              role="menuitemradio"
              tabIndex={-1}
              type="button"
            >
              {option.icon}
              {option.label}
              {theme === option.value && <CheckIcon className="fl-menu-check" size={16} />}
            </button>
          ))}
          {onSignOut && (
            <>
              <hr className="fl-menu-separator" />
              <MenuItem
                icon={<LogOutIcon size={16} />}
                onSelect={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                Sign out
              </MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button className="fl-menu-item" onClick={onSelect} role="menuitem" tabIndex={-1} type="button">
      {icon}
      {children}
    </button>
  );
}
