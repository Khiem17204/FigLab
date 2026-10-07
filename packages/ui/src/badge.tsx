import type { HTMLAttributes } from "react";

import { cx } from "./cx";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

export function Badge({
  tone = "neutral",
  mono,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; mono?: boolean }) {
  return (
    <span
      className={cx("fl-badge", className)}
      data-mono={mono ? "" : undefined}
      data-tone={tone}
      {...props}
    />
  );
}
