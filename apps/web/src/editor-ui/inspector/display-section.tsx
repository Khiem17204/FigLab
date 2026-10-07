import type { ImageViewObjectV1 } from "@figlab/figure-schema";

export function TransformControls({
  object,
  onChange,
}: {
  object: ImageViewObjectV1;
  onChange: (display: ImageViewObjectV1["view"]["display"]) => void;
}) {
  const display = object.view.display;
  const range = (
    label: string,
    key: "brightness" | "contrast" | "gamma",
    min: number,
    max: number,
    step: number,
  ) => (
    <label>
      {label}
      <input
        aria-label={label}
        max={max}
        min={min}
        onChange={(event) => onChange({ ...display, [key]: Number(event.target.value) })}
        step={step}
        type="range"
        value={display[key]}
      />
      <output>{display[key]}</output>
    </label>
  );
  return (
    <div className="transform-controls">
      {range("Brightness", "brightness", -1, 1, 0.01)}
      {range("Contrast", "contrast", 0, 4, 0.01)}
      {range("Gamma", "gamma", 0.1, 10, 0.1)}
      <label>
        <input
          aria-label="Invert"
          checked={display.invert}
          onChange={(event) => onChange({ ...display, invert: event.target.checked })}
          type="checkbox"
        />
        Invert
      </label>
    </div>
  );
}
