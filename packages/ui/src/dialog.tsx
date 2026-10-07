import * as RadixDialog from "@radix-ui/react-dialog";
import { type ReactNode, useRef } from "react";
import { Button, IconButton } from "./button";
import { cx } from "./cx";
import { CloseIcon } from "./icons";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

/** Modal content with a title, optional description, a close button, and a footer row. */
export function DialogContent({
  title,
  description,
  children,
  footer,
  size = "md",
  className,
  onOpenAutoFocus,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
  className?: string;
  onOpenAutoFocus?: (event: Event) => void;
}) {
  // Radix restores focus only to a Dialog.Trigger; dialogs opened from other controls would
  // drop focus to <body> on close, so remember what had focus and return to it.
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fl-dialog-overlay" />
      <RadixDialog.Content
        className={cx("fl-dialog", className)}
        data-size={size}
        {...(description ? {} : { "aria-describedby": undefined })}
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        onOpenAutoFocus={(event) => {
          if (document.activeElement instanceof HTMLElement)
            returnFocus.current = document.activeElement;
          onOpenAutoFocus?.(event);
        }}
      >
        <div className="fl-dialog-header">
          <RadixDialog.Title className="fl-dialog-title">{title}</RadixDialog.Title>
          <RadixDialog.Close asChild>
            <IconButton
              className="fl-dialog-close"
              icon={<CloseIcon />}
              label="Close"
              size="sm"
              tooltip={false}
            />
          </RadixDialog.Close>
          {description && (
            <RadixDialog.Description className="fl-dialog-description">
              {description}
            </RadixDialog.Description>
          )}
        </div>
        {children}
        {footer && <div className="fl-dialog-footer">{footer}</div>}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/** A two-button confirmation. Destructive confirmations get the solid danger style. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        description={description}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">{cancelLabel}</Button>
            </DialogClose>
            <Button
              loading={busy ?? false}
              onClick={onConfirm}
              variant={destructive ? "danger-solid" : "primary"}
            >
              {confirmLabel}
            </Button>
          </>
        }
        title={title}
      />
    </Dialog>
  );
}
