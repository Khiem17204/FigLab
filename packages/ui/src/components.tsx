import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from "react";

export function Button({
  children,
  className = "",
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return (
    <button className={`figlab-button ${className}`} type="button" {...props}>
      {children}
    </button>
  );
}

export function Panel({
  children,
  className = "",
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <section className={`figlab-panel ${className}`} {...props}>
      {children}
    </section>
  );
}
