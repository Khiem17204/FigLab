import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { Button, IconButton } from "./button";
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from "./icons";

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

export interface ToastItem extends ToastInput {
  id: string;
}

export const MAX_TOASTS = 4;

type ToastAction = { type: "add"; toast: ToastItem } | { type: "dismiss"; id: string };

/** Newest last; the oldest toast is dropped once more than MAX_TOASTS are queued. */
export function toastReducer(state: ToastItem[], action: ToastAction): ToastItem[] {
  if (action.type === "dismiss") return state.filter((toast) => toast.id !== action.id);
  return [...state.filter((toast) => toast.id !== action.toast.id), action.toast].slice(
    -MAX_TOASTS,
  );
}

export function defaultToastDuration(tone: ToastTone = "info"): number {
  return tone === "error" ? 9000 : 5000;
}

interface ToastApi {
  show: (toast: ToastInput & { id?: string }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

/**
 * Hosts transient notifications in one polite live region. Toasts deliberately carry no
 * status/alert role: persistent inline status text stays the source of truth.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const counter = useRef(0);
  const dismiss = useCallback((id: string) => dispatch({ type: "dismiss", id }), []);
  const show = useCallback((toast: ToastInput & { id?: string }) => {
    counter.current += 1;
    const id = toast.id ?? `toast-${counter.current}`;
    dispatch({ type: "add", toast: { ...toast, id } });
    return id;
  }, []);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section aria-label="Notifications" className="fl-toast-region">
        <ol aria-live="polite" aria-relevant="additions" className="fl-toast-viewport">
          {toasts.map((toast) => (
            <Toast key={toast.id} onDismiss={() => dismiss(toast.id)} toast={toast} />
          ))}
        </ol>
      </section>
    </ToastContext.Provider>
  );
}

/** Returns the toast API, or a no-op outside a provider (for isolated component tests). */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noopToasts;
}

const noopToasts: ToastApi = { show: () => "", dismiss: () => undefined };

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const tone = toast.tone ?? "info";
  const duration = toast.duration ?? defaultToastDuration(tone);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useCallback(() => {
    clearTimeout(timer.current);
    if (duration > 0) timer.current = setTimeout(onDismiss, duration);
  }, [duration, onDismiss]);
  const pause = () => clearTimeout(timer.current);
  useEffect(() => {
    start();
    return () => clearTimeout(timer.current);
  }, [start]);
  const Icon = tone === "success" ? CheckIcon : tone === "error" ? AlertIcon : InfoIcon;
  return (
    <li
      className="fl-toast"
      data-tone={tone}
      onBlur={start}
      onFocus={pause}
      onPointerEnter={pause}
      onPointerLeave={start}
    >
      <span className="fl-toast-icon">
        <Icon size={16} />
      </span>
      <div>
        <p className="fl-toast-title">{toast.title}</p>
        {toast.description && <p className="fl-toast-description">{toast.description}</p>}
        {toast.action && (
          <Button
            className="fl-toast-action"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            size="sm"
          >
            {toast.action.label}
          </Button>
        )}
      </div>
      <IconButton
        icon={<CloseIcon size={16} />}
        label="Dismiss notification"
        onClick={onDismiss}
        size="sm"
        tooltip={false}
      />
    </li>
  );
}
