import { type DragEvent, type ReactNode, useRef, useState } from "react";

import { Button } from "./button";
import { cx } from "./cx";
import { UploadIcon } from "./icons";

export function acceptsFile(file: { name: string; type: string }, accept: string): boolean {
  const rules = accept
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  if (!rules.length) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return rules.some((rule) =>
    rule.startsWith(".")
      ? name.endsWith(rule)
      : rule.endsWith("/*")
        ? type.startsWith(rule.slice(0, -1))
        : type === rule,
  );
}

/**
 * Accepts files by drag-and-drop or through a real file input (named by `inputLabel`), so
 * keyboard and assistive-technology users get the native picker.
 */
export function DropZone({
  inputLabel,
  accept,
  multiple = true,
  onFiles,
  onRejectedFiles,
  title,
  hint,
  buttonLabel,
  illustration,
  disabled,
  className,
}: {
  inputLabel: string;
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onRejectedFiles?: (files: File[]) => void;
  title: ReactNode;
  hint?: ReactNode;
  buttonLabel: string;
  illustration?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const deliver = (list: FileList | null | undefined) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const accepted = files.filter((file) => acceptsFile(file, accept));
    const rejected = files.filter((file) => !acceptsFile(file, accept));
    const usable = multiple ? accepted : accepted.slice(0, 1);
    if (usable.length) onFiles(usable);
    if (rejected.length) onRejectedFiles?.(rejected);
  };
  const dragProps = disabled
    ? {}
    : {
        onDragEnter: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          depth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          deliver(event.dataTransfer.files);
        },
      };
  return (
    <div
      className={cx("fl-dropzone", className)}
      data-disabled={disabled ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      {...dragProps}
    >
      {illustration}
      <span className="fl-dropzone-title">{title}</span>
      {hint && <span className="fl-dropzone-hint">{hint}</span>}
      <span className="fl-dropzone-pick">
        <Button aria-hidden="true" icon={<UploadIcon size={16} />} size="sm" tabIndex={-1}>
          {buttonLabel}
        </Button>
        <input
          accept={accept}
          aria-label={inputLabel}
          disabled={disabled}
          multiple={multiple}
          onChange={(event) => {
            deliver(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          title=""
          type="file"
        />
      </span>
    </div>
  );
}
