import { cx } from "./cx";

/** A thin progress bar. Omit `value` for indeterminate work. `value` is 0–1. */
export function ProgressBar({
  value,
  label,
  tone = "primary",
  className,
}: {
  value?: number;
  label: string;
  tone?: "primary" | "success" | "danger";
  className?: string;
}) {
  const percent =
    value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent}
      className={cx("fl-progress", className)}
      data-indeterminate={percent === undefined ? "" : undefined}
      data-tone={tone}
      role="progressbar"
    >
      <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
    </span>
  );
}
