const GREEK = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "omicron",
  "pi",
  "rho",
  "sigma",
  "tau",
  "upsilon",
  "phi",
  "chi",
  "psi",
  "omega",
];

/** Backslash shortcuts typed in figure text, for symbols common in figure labels. */
export const SYMBOL_SHORTCUTS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    GREEK.map((name, index) => [name, String.fromCodePoint(0x3b1 + index + (index > 16 ? 1 : 0))]),
  ),
  ...Object.fromEntries(
    GREEK.map((name, index) => [
      name[0]?.toUpperCase() + name.slice(1),
      String.fromCodePoint(0x391 + index + (index > 16 ? 1 : 0)),
    ]),
  ),
  pm: "±",
  deg: "°",
  times: "×",
  leq: "≤",
  geq: "≥",
  approx: "≈",
  micro: "µ",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  minus: "−",
};

const SHORTCUT_PATTERN = new RegExp(
  `\\\\(${Object.keys(SYMBOL_SHORTCUTS)
    .sort((left, right) => right.length - left.length)
    .join("|")})`,
  "g",
);

/**
 * Replaces `\name` with its symbol as soon as the name is complete, so `\mu` then `M` gives
 * `μM`. No shortcut name is a prefix of another, so every one can be typed in full.
 */
export function replaceSymbolShortcuts(text: string): string {
  return text.replace(SHORTCUT_PATTERN, (_match, name: string) => SYMBOL_SHORTCUTS[name] ?? name);
}
