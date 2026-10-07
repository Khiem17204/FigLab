import { type ReactNode, useId } from "react";

import { cx } from "./cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is an icon. */
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * A single-choice group drawn as a pill switcher. It is a native radio group, so arrow keys,
 * form semantics and labels behave as users expect.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  block,
  className,
}: {
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  block?: boolean;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cx("fl-segmented", className)} data-block={block ? "" : undefined}>
      <legend className="fl-visually-hidden">{label}</legend>
      {options.map((option) => (
        <label className="fl-segmented-option" key={option.value}>
          <input
            aria-label={option.ariaLabel}
            checked={option.value === value}
            className="fl-visually-hidden"
            disabled={option.disabled}
            name={name}
            onChange={() => onChange(option.value)}
            type="radio"
            value={option.value}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
