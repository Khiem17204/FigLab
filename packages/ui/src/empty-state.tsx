import type { ReactNode } from "react";

import { cx } from "./cx";
import { Mascot, type MascotMood } from "./mascot";

export function EmptyState({
  title,
  children,
  actions,
  illustration,
  mood = "happy",
  plain,
  headingLevel = 2,
  className,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Replaces the default mascot. Pass `null` for none. */
  illustration?: ReactNode;
  mood?: MascotMood;
  /** Drops the dashed card treatment. */
  plain?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={cx("fl-empty", className)} data-plain={plain ? "" : undefined}>
      {illustration === undefined ? <Mascot mood={mood} /> : illustration}
      <Heading className="fl-empty-title">{title}</Heading>
      {children && <p className="fl-empty-body">{children}</p>}
      {actions && <div className="fl-empty-actions">{actions}</div>}
    </div>
  );
}
