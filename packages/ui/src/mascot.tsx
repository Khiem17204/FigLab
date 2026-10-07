import { cx } from "./cx";

export type MascotMood = "happy" | "sleepy" | "working" | "oops" | "proud";

/**
 * Pip, FigLab's pipette-drop mascot. Decorative only: always aria-hidden, so the surrounding
 * copy must carry the meaning.
 */
export function Mascot({
  mood = "happy",
  size = 64,
  animate = true,
  className,
}: {
  mood?: MascotMood;
  size?: number;
  animate?: boolean;
  className?: string;
}) {
  const line = "var(--fl-mascot-line)";
  return (
    <svg
      aria-hidden="true"
      className={cx("fl-mascot", className)}
      data-animate={animate ? "" : undefined}
      data-mood={mood}
      focusable="false"
      height={size}
      viewBox="0 0 64 64"
      width={size}
    >
      <path
        d="M32 5C24 19 14 28 14 40a18 18 0 0 0 36 0C50 28 40 19 32 5Z"
        fill="var(--fl-mascot-body)"
        stroke={line}
        strokeLinejoin="round"
        strokeWidth="2.2"
      />
      <path
        d="M21 33q1-6 6-10"
        fill="none"
        opacity="0.85"
        stroke="var(--fl-mascot-shine)"
        strokeLinecap="round"
        strokeWidth="2.5"
      />
      <Eyes line={line} mood={mood} />
      <Mouth line={line} mood={mood} />
      <ellipse cx="21" cy="47" fill="var(--fl-mascot-cheek)" rx="3" ry="1.8" />
      <ellipse cx="43" cy="47" fill="var(--fl-mascot-cheek)" rx="3" ry="1.8" />
      {mood === "proud" && (
        <path
          d="M52 12l1.2 3.3 3.3 1.2-3.3 1.2L52 21l-1.2-3.3-3.3-1.2 3.3-1.2z"
          fill="var(--fl-highlight)"
          stroke={line}
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
      )}
      {mood === "sleepy" && (
        <text fill={line} fontFamily="var(--fl-font-hand)" fontSize="11" x="47" y="17">
          z
        </text>
      )}
    </svg>
  );
}

function Eyes({ mood, line }: { mood: MascotMood; line: string }) {
  if (mood === "sleepy")
    return (
      <path
        d="M23 41q3 2 6 0M35 41q3 2 6 0"
        fill="none"
        stroke={line}
        strokeLinecap="round"
        strokeWidth="2"
      />
    );
  if (mood === "proud")
    return (
      <path
        d="M23 42q3-3 6 0M35 42q3-3 6 0"
        fill="none"
        stroke={line}
        strokeLinecap="round"
        strokeWidth="2"
      />
    );
  return (
    <>
      <circle cx="26" cy="41" fill={line} r="2.6" />
      <circle cx="38" cy="41" fill={line} r="2.6" />
    </>
  );
}

function Mouth({ mood, line }: { mood: MascotMood; line: string }) {
  const d =
    mood === "oops"
      ? "M29 49.5q3-2.5 6 0"
      : mood === "working"
        ? "M30 48.5h4"
        : mood === "sleepy"
          ? "M30.5 48.5q1.5 1 3 0"
          : "M28.5 47.5q3.5 3 7 0";
  return <path d={d} fill="none" stroke={line} strokeLinecap="round" strokeWidth="2" />;
}
