import { useEffect, useId, useState } from "react";

import { cx } from "./cx";

export function clampToStep(value: number, min: number, max: number, step: number): number {
  const clamped = Math.min(max, Math.max(min, value));
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number((Math.round((clamped - min) / step) * step + min).toFixed(decimals));
}

/**
 * A labelled range input paired with a number box for exact entry. The range carries the
 * label ("Brightness"); the number box is named "<label> value" so both stay addressable.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  precision = 2,
  className,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  precision?: number;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value.toFixed(precision));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(value.toFixed(precision));
  }, [editing, precision, value]);
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <div className={cx("fl-slider", className)}>
      <label htmlFor={id}>{label}</label>
      <input
        className="fl-range"
        disabled={disabled}
        id={id}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        style={{ "--fl-p": `${percent}%` } as React.CSSProperties}
        type="range"
        value={value}
      />
      <input
        aria-label={`${label} value`}
        className="fl-input"
        disabled={disabled}
        inputMode="decimal"
        max={max}
        min={min}
        onBlur={() => {
          setEditing(false);
          setDraft(value.toFixed(precision));
        }}
        onChange={(event) => {
          setEditing(true);
          setDraft(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(next)) {
            const clamped = clampToStep(next, min, max, step);
            if (clamped !== value) onChange(clamped);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        step={step}
        type="number"
        value={draft}
      />
    </div>
  );
}
