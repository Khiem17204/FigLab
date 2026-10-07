import {
  cloneElement,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

type TriggerProps = {
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
};

/**
 * Shows a short hint on hover (after a delay) or keyboard focus. The hint is presentational:
 * the trigger must already have an accessible name. Escape hides it.
 */
export function Tooltip({
  content,
  children,
  side = "bottom",
  align = "center",
  delay = 350,
}: {
  content: ReactNode;
  children: ReactElement<TriggerProps>;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  delay?: number;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const show = (immediate: boolean) => {
    clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const props = children.props;
  return (
    <span className="fl-tooltip-anchor">
      {cloneElement(children, {
        onPointerEnter: (event) => {
          props.onPointerEnter?.(event);
          if (event.pointerType === "mouse") show(false);
        },
        onPointerLeave: (event) => {
          props.onPointerLeave?.(event);
          hide();
        },
        onPointerDown: (event) => {
          props.onPointerDown?.(event);
          hide();
        },
        onFocus: (event) => {
          props.onFocus?.(event);
          if (event.currentTarget.matches(":focus-visible")) show(true);
        },
        onBlur: (event) => {
          props.onBlur?.(event);
          hide();
        },
      })}
      {open && (
        <span aria-hidden="true" className="fl-tooltip" data-align={align} data-side={side}>
          {content}
        </span>
      )}
    </span>
  );
}
