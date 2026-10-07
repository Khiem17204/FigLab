import type { ImageViewObjectV3 } from "@figlab/figure-schema";
import { Button, Section, Slider, Switch } from "@figlab/ui";

type Display = ImageViewObjectV3["view"]["display"];

/** The settings this section owns; levels and LUT live in the panel inspector. */
export const NEUTRAL_DISPLAY = { brightness: 0, contrast: 1, gamma: 1, invert: false } as const;

export function isNeutralDisplay(display: Pick<Display, keyof typeof NEUTRAL_DISPLAY>): boolean {
  return (
    display.brightness === NEUTRAL_DISPLAY.brightness &&
    display.contrast === NEUTRAL_DISPLAY.contrast &&
    display.gamma === NEUTRAL_DISPLAY.gamma &&
    display.invert === NEUTRAL_DISPLAY.invert
  );
}

/** Non-destructive display settings; export applies the same math to the original samples. */
export function DisplaySection({
  object,
  onChange,
}: {
  object: ImageViewObjectV3;
  onChange: (display: Display) => void;
}) {
  const display = object.view.display;
  return (
    <Section
      actions={
        <Button
          disabled={isNeutralDisplay(display)}
          onClick={() => onChange({ ...display, ...NEUTRAL_DISPLAY })}
          size="sm"
          variant="ghost"
        >
          Reset
        </Button>
      }
      title="Display"
    >
      <Slider
        label="Brightness"
        max={1}
        min={-1}
        onChange={(brightness) => onChange({ ...display, brightness })}
        step={0.01}
        value={display.brightness}
      />
      <Slider
        label="Contrast"
        max={4}
        min={0}
        onChange={(contrast) => onChange({ ...display, contrast })}
        step={0.01}
        value={display.contrast}
      />
      <Slider
        label="Gamma"
        max={10}
        min={0.1}
        onChange={(gamma) => onChange({ ...display, gamma })}
        step={0.1}
        value={display.gamma}
      />
      <Switch
        checked={display.invert}
        label="Invert"
        labelSide="start"
        onCheckedChange={(invert) => onChange({ ...display, invert })}
      />
    </Section>
  );
}
