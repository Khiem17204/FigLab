import { cropCornersPx } from "@figlab/figure-schema";

export type LadderMark = { yPx: number; kDa: number };

/**
 * Least-squares fit of log10(kDa) against row in the original, the usual semi-log ladder
 * model. Undefined with fewer than two marks at different rows.
 */
export function fitLadder(marks: ReadonlyArray<LadderMark>): ((yPx: number) => number) | undefined {
  const points = marks.filter((mark) => mark.kDa > 0);
  if (new Set(points.map((mark) => mark.yPx)).size < 2) return undefined;
  const n = points.length;
  const meanY = points.reduce((sum, mark) => sum + mark.yPx, 0) / n;
  const meanLog = points.reduce((sum, mark) => sum + Math.log10(mark.kDa), 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const mark of points) {
    covariance += (mark.yPx - meanY) * (Math.log10(mark.kDa) - meanLog);
    variance += (mark.yPx - meanY) ** 2;
  }
  const slope = covariance / variance;
  return (yPx) => 10 ** (meanLog + slope * (yPx - meanY));
}

/** The molecular-weight span a crop covers, from the ladder fit at its top and bottom rows. */
export function cropKDaRange(
  crop: { viewport: { x: number; y: number; width: number; height: number }; rotationDeg: number },
  source: { widthPx: number; heightPx: number },
  marks: ReadonlyArray<LadderMark>,
): { lowKDa: number; highKDa: number } | undefined {
  const fit = fitLadder(marks);
  if (!fit) return undefined;
  const rows = cropCornersPx(crop, source).map(([, y]) => y);
  const ends = [fit(Math.min(...rows)), fit(Math.max(...rows))];
  return { lowKDa: Math.min(...ends), highKDa: Math.max(...ends) };
}

const LOADING_CONTROL =
  /\b(actin|β-actin|beta-actin|gapdh|α-tubulin|alpha-tubulin|β-tubulin|tubulin|vinculin|histone h3|h3|lamin|hsp90|cofilin|ponceau|total protein|coomassie|stain-free)\b/i;

/** Whether a panel's sample info names a common loading control or is marked as one. */
export function isLoadingControl(info: { target?: string; loadingControl?: boolean } | undefined) {
  return info?.loadingControl === true || LOADING_CONTROL.test(info?.target ?? "");
}
