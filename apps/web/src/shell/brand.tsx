import { Mascot } from "@figlab/ui";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <Mascot animate={false} size={30} />
      <span className="brand-word">FigLab</span>
      {!compact && <span className="brand-tagline">Scientific figure workspace</span>}
    </span>
  );
}
