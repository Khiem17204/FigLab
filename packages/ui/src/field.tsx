import {
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
} from "react";

import { cx } from "./cx";
import { AlertIcon } from "./icons";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: "sm" | "md";
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, size = "md", invalid, ...props }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx("fl-input", className)}
      data-size={size}
      {...props}
    />
  );
}

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
};

/**
 * Labels a single form control and wires its hint and error text to it with
 * aria-describedby. The error is announced through aria-invalid on the control.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement<FieldControlProps>;
  className?: string;
}) {
  const generated = useId();
  const control = isValidElement(children) ? children : undefined;
  const id = control?.props.id ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy =
    [control?.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("fl-field", className)}>
      <label className="fl-field-label" htmlFor={id}>
        {label}
      </label>
      {control &&
        cloneElement(control, {
          id,
          ...(describedBy ? { "aria-describedby": describedBy } : {}),
          ...(error ? { "aria-invalid": true } : {}),
        })}
      {hint && (
        <p className="fl-field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="fl-field-error" id={errorId}>
          <AlertIcon size={15} />
          {error}
        </p>
      )}
    </div>
  );
}
