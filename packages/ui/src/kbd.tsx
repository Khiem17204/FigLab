import type { HTMLAttributes } from "react";

import { cx } from "./cx";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx("fl-kbd", className)} {...props} />;
}
