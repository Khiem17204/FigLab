import { type HTMLAttributes, type ReactNode, useId, useState } from "react";

import { cx } from "./cx";
import { ChevronDownIcon } from "./icons";

export function Panel({ children, className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx("fl-panel", className)} {...props}>
      {children}
    </section>
  );
}

/**
 * A collapsible inspector section. Tools add themselves to an inspector by rendering one
 * `Section` each; `actions` sit beside the title (for example a reset button).
 */
export function Section({
  title,
  label,
  actions,
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  className,
}: {
  title: ReactNode;
  /** Names the region when it should differ from the visible title. */
  label?: string;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const id = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const toggle = () => {
    setUncontrolledOpen(!open);
    onOpenChange?.(!open);
  };
  return (
    <section
      aria-label={label}
      aria-labelledby={label ? undefined : `${id}-title`}
      className={cx("fl-section", className)}
    >
      <h3 className="fl-section-header">
        <button
          aria-controls={`${id}-body`}
          aria-expanded={open}
          className="fl-section-toggle"
          id={`${id}-title`}
          onClick={toggle}
          type="button"
        >
          {title}
          <ChevronDownIcon size={16} />
        </button>
        {actions}
      </h3>
      <div className="fl-section-body" hidden={!open} id={`${id}-body`}>
        {children}
      </div>
    </section>
  );
}
