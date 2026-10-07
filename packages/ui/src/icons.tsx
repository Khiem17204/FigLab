import type { ReactNode, SVGProps } from "react";

import { cx } from "./cx";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function icon(paths: ReactNode) {
  return function Icon({ size = 18, className, ...props }: IconProps) {
    return (
      <svg
        aria-hidden="true"
        className={cx("fl-icon", className)}
        focusable="false"
        height={size}
        viewBox="0 0 24 24"
        width={size}
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const ArrowLeftIcon = icon(<path d="M15 6l-6 6 6 6" />);
export const ChevronDownIcon = icon(<path d="M6 9l6 6 6-6" />);
export const UndoIcon = icon(
  <>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </>,
);
export const RedoIcon = icon(
  <>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </>,
);
export const UploadIcon = icon(
  <>
    <path d="M12 15V4M7 9l5-5 5 5" />
    <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </>,
);
export const DownloadIcon = icon(
  <>
    <path d="M12 4v11M7 10l5 5 5-5" />
    <path d="M5 20h14" />
  </>,
);
export const CheckIcon = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const MinusIcon = icon(<path d="M5 12h14" />);
export const CloseIcon = icon(<path d="M6 6l12 12M18 6L6 18" />);
export const PencilIcon = icon(
  <>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </>,
);
export const TrashIcon = icon(
  <>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </>,
);
export const PanelLeftIcon = icon(
  <>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M9 4v16" />
  </>,
);
export const PanelRightIcon = icon(
  <>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <path d="M15 4v16" />
  </>,
);
export const KeyboardIcon = icon(
  <>
    <rect height="12" rx="2.5" width="19" x="2.5" y="6" />
    <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9" />
  </>,
);
export const LocateIcon = icon(
  <>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
  </>,
);
export const ImageIcon = icon(
  <>
    <rect height="16" rx="3" width="18" x="3" y="4" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M4 18l5-5 4 4 3-3 4 4" />
  </>,
);
export const AlertIcon = icon(
  <>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17.2h.01" />
  </>,
);
export const InfoIcon = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.8h.01" />
  </>,
);
export const LogOutIcon = icon(
  <>
    <path d="M14 5h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4" />
    <path d="M10 16l-4-4 4-4M6 12h10" />
  </>,
);
export const SunIcon = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
  </>,
);
export const MoonIcon = icon(<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />);
export const MonitorIcon = icon(
  <>
    <rect height="12" rx="2" width="18" x="3" y="4" />
    <path d="M9 20h6M12 16v4" />
  </>,
);
export const FitIcon = icon(
  <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />,
);
export const FolderIcon = icon(
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
);
export const SparkleIcon = icon(
  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
);
