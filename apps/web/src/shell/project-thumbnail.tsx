/**
 * A decorative, deterministic sketch of a figure layout. Real previews would need every
 * original downloaded, so dashboard cards show a stable placeholder derived from the ID.
 */
export function ProjectThumbnail({ seed }: { seed: string }) {
  const layout = layouts[hash(seed) % layouts.length] ?? layouts[0];
  const tint = hash(`${seed}tint`) % tints.length;
  return (
    <svg aria-hidden="true" className="project-thumb" viewBox="0 0 160 100">
      <rect className="thumb-paper" height="84" rx="2" width="66" x="47" y="8" />
      {layout?.map(([x, y, width, height], index) => (
        <rect
          className={`thumb-panel tint-${(tint + index) % tints.length}`}
          height={height}
          // biome-ignore lint/suspicious/noArrayIndexKey: static layout geometry
          key={index}
          rx="1"
          width={width}
          x={x}
          y={y}
        />
      ))}
    </svg>
  );
}

const tints = ["sky", "pink", "highlight", "mint"] as const;
type Rect = [number, number, number, number];
const layouts: Rect[][] = [
  [
    [52, 13, 27, 24],
    [81, 13, 27, 24],
    [52, 40, 56, 16],
  ],
  [
    [52, 13, 56, 22],
    [52, 38, 17, 17],
    [71, 38, 17, 17],
    [90, 38, 18, 17],
  ],
  [
    [52, 13, 17, 30],
    [71, 13, 37, 30],
    [52, 46, 56, 12],
    [52, 61, 27, 18],
  ],
  [
    [52, 13, 27, 20],
    [81, 13, 27, 20],
    [52, 36, 27, 20],
    [81, 36, 27, 20],
  ],
];

function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return Math.abs(result);
}
