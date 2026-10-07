import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { Button } from "./button";
import { Dialog, DialogClose, DialogContent } from "./dialog";
import { Field, Input } from "./field";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  description?: string;
  maxLength?: number;
}

interface DialogsApi {
  /** Resolves true when the user confirms, false when they cancel or dismiss. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Resolves the trimmed value, or undefined when dismissed or left empty. */
  prompt: (options: PromptOptions) => Promise<string | undefined>;
}

type Pending =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | undefined) => void };

const DialogsContext = createContext<DialogsApi | undefined>(undefined);

/**
 * Promise-based replacements for window.confirm and window.prompt, rendered as accessible
 * FigLab dialogs. Wrap the app once; call `useDialogs()` anywhere below it.
 */
export function DialogsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending>();
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ kind: "confirm", options, resolve })),
    [],
  );
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | undefined>((resolve) =>
        setPending({ kind: "prompt", options, resolve }),
      ),
    [],
  );
  const api = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const settle = (value: boolean | string | undefined) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(value === true);
    else pending.resolve(typeof value === "string" ? value : undefined);
    setPending(undefined);
  };
  return (
    <DialogsContext.Provider value={api}>
      {children}
      <Dialog
        onOpenChange={(open) => {
          if (!open) settle(pending?.kind === "confirm" ? false : undefined);
        }}
        open={!!pending}
      >
        {pending?.kind === "confirm" && (
          <DialogContent
            description={pending.options.description}
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="ghost">{pending.options.cancelLabel ?? "Cancel"}</Button>
                </DialogClose>
                <Button
                  onClick={() => settle(true)}
                  variant={pending.options.destructive ? "danger-solid" : "primary"}
                >
                  {pending.options.confirmLabel}
                </Button>
              </>
            }
            title={pending.options.title}
          />
        )}
        {pending?.kind === "prompt" && (
          <PromptBody onSubmit={(value) => settle(value)} options={pending.options} />
        )}
      </Dialog>
    </DialogsContext.Provider>
  );
}

function PromptBody({
  options,
  onSubmit,
}: {
  options: PromptOptions;
  onSubmit: (value: string | undefined) => void;
}) {
  const [value, setValue] = useState(options.initialValue ?? "");
  const formId = "fl-prompt-form";
  return (
    <DialogContent
      description={options.description}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button disabled={!value.trim()} form={formId} type="submit" variant="primary">
            {options.confirmLabel}
          </Button>
        </>
      }
      title={options.title}
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          onSubmit(trimmed || undefined);
        }}
      >
        <Field label={options.label}>
          <Input
            // biome-ignore lint/a11y/noAutofocus: the only field of a prompt dialog takes focus
            autoFocus
            maxLength={options.maxLength}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            value={value}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

/** The dialogs API; outside a provider it falls back to the browser's native dialogs. */
export function useDialogs(): DialogsApi {
  return useContext(DialogsContext) ?? nativeDialogs;
}

const nativeDialogs: DialogsApi = {
  confirm: async (options) => window.confirm(options.title),
  prompt: async (options) =>
    window.prompt(options.label, options.initialValue)?.trim() || undefined,
};
