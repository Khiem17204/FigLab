import type { InputHTMLAttributes } from "react";

import { cx } from "./cx";

/** A native checkbox styled as a toggle, so it keeps the checkbox role and keyboard behavior. */
export function Switch({
  label,
  checked,
  onCheckedChange,
  labelSide = "end",
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  labelSide?: "start" | "end";
}) {
  return (
    <label className={cx("fl-switch", className)} data-label-side={labelSide}>
      <span className="fl-switch-box">
        <input
          checked={checked}
          className="fl-switch-input"
          onChange={(event) => onCheckedChange(event.target.checked)}
          type="checkbox"
          {...props}
        />
        <span aria-hidden="true" className="fl-switch-track" />
      </span>
      <span>{label}</span>
    </label>
  );
}
