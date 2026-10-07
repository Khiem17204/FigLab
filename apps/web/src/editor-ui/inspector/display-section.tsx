import type { ImageViewObjectV1 } from "@figlab/figure-schema";
import { Button, Section, Slider, Switch } from "@figlab/ui";

type Display = ImageViewObjectV1["view"]["display"];

export const NEUTRAL_DISPLAY: Display = { brightness: 0, contrast: 1, gamma: 1, invert: false };

export function isNeutralDisplay(display: Display): boolean {
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
  object: ImageViewObjectV1;
  onChange: (display: Display) => void;
}) {
  const display = object.view.display;
  return (
    <Section
      actions={
        <Button
          disabled={isNeutralDisplay(display)}
          onClick={() => onChange(NEUTRAL_DISPLAY)}
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
