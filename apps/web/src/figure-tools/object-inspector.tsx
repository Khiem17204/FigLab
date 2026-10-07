import { textBoxSize, updateObjectCommand } from "@figlab/editor-core";
import type { FigureObject, StrokeV2, TextStyleV2 } from "@figlab/figure-schema";
import type { TextMetrics } from "@figlab/image-processing";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { EditorSessionState } from "../editor/session-store";
import { replaceSymbolShortcuts } from "./text-input";

type TextObject = Extract<FigureObject, { type: "text" }>;
type LineObject = Extract<FigureObject, { type: "line" }>;
type ShapeObject = Extract<FigureObject, { type: "shape" }>;

/** Refits a text box to its content so alignment and backgrounds follow the measured layout. */
export function withText(
  object: TextObject,
  content: string,
  style: TextStyleV2,
  measure: TextMetrics["measure"],
): TextObject {
  return {
    ...object,
    transform: { ...object.transform, ...textBoxSize(content, style, measure) },
    text: { content, style },
  };
}

function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        defaultValue={Number(value.toFixed(2))}
        key={`${label}-${value}`}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        onBlur={(event) => {
          const next = Number(event.currentTarget.value);
          if (!Number.isFinite(next) || next === value) return;
          onCommit(Math.min(max ?? next, Math.max(min ?? next, next)));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        step={step}
        type="number"
      />
    </label>
  );
}

function StrokeFields({
  stroke,
  onChange,
}: {
  stroke: StrokeV2;
  onChange: (stroke: StrokeV2) => void;
}) {
  return (
    <>
      <label>
        Stroke color
        <input
          onChange={(event) => onChange({ ...stroke, colorHex: event.target.value.toUpperCase() })}
          type="color"
          value={stroke.colorHex.toLowerCase()}
        />
      </label>
      <NumberField
        label="Stroke width (pt)"
        max={20}
        min={0.1}
        onCommit={(widthPt) => onChange({ ...stroke, widthPt })}
        step={0.25}
        value={stroke.widthPt}
      />
      <label className="inline">
        <input
          checked={stroke.dashed}
          onChange={(event) => onChange({ ...stroke, dashed: event.target.checked })}
          type="checkbox"
        />
        Dashed
      </label>
    </>
  );
}

/** Properties of the selected text, line, or shape. Image panels use the display inspector. */
export function ObjectInspector({
  session,
  metrics,
}: {
  session: StoreApi<EditorSessionState>;
  metrics: TextMetrics;
}) {
  const state = useStore(session);
  if (state.selectedIds.length !== 1) return null;
  const object = state.document.objects.find((candidate) => candidate.id === state.selectedIds[0]);
  if (!object || object.type === "image-view") return null;
  const update = (replacement: (current: FigureObject) => FigureObject) =>
    session.getState().apply(updateObjectCommand(object.id, replacement));
  const transformField = (key: "xPt" | "yPt", label: string) => (
    <NumberField
      label={label}
      onCommit={(value) =>
        update(
          (current) =>
            ({ ...current, transform: { ...current.transform, [key]: value } }) as FigureObject,
        )
      }
      value={object.transform[key]}
    />
  );

  return (
    <section aria-label="Object inspector" className="figure-tools-panel">
      <h3>
        {object.type === "text"
          ? object.panelLabel
            ? "Panel label"
            : "Text"
          : object.type === "line"
            ? "Line"
            : "Shape"}
      </h3>
      {object.locked && <p>Locked. Unlock it in Figure tools to edit.</p>}
      <fieldset disabled={object.locked}>
        {transformField("xPt", "X (pt)")}
        {transformField("yPt", "Y (pt)")}
        {object.type !== "line" && (
          <NumberField
            label="Rotation (°)"
            max={180}
            min={-180}
            onCommit={(rotationDeg) =>
              update(
                (current) =>
                  ({
                    ...current,
                    transform: { ...current.transform, rotationDeg },
                  }) as FigureObject,
              )
            }
            value={object.transform.rotationDeg}
          />
        )}
        {object.type === "text" && <TextFields object={object} metrics={metrics} update={update} />}
        {object.type === "line" && <LineFields object={object} update={update} />}
        {object.type === "shape" && <ShapeFields object={object} update={update} />}
      </fieldset>
    </section>
  );
}

function TextFields({
  object,
  metrics,
  update,
}: {
  object: TextObject;
  metrics: TextMetrics;
  update: (replacement: (current: FigureObject) => FigureObject) => void;
}) {
  const { content, style } = object.text;
  const setText = (nextContent: string, nextStyle: TextStyleV2 = style) =>
    update((current) =>
      current.type === "text"
        ? withText(current, nextContent, nextStyle, metrics.measure)
        : current,
    );
  const setStyle = (patch: Partial<TextStyleV2>) => setText(content, { ...style, ...patch });
  return (
    <>
      <label>
        Text content
        <textarea
          defaultValue={content}
          key={`${object.id}-${content}`}
          onBlur={(event) => {
            const next = replaceSymbolShortcuts(event.currentTarget.value);
            if (next.trim() && next !== content) setText(next);
          }}
          onInput={(event) => {
            const replaced = replaceSymbolShortcuts(event.currentTarget.value);
            if (replaced !== event.currentTarget.value) event.currentTarget.value = replaced;
          }}
          rows={3}
        />
      </label>
      <small>Type \alpha, \mu, \pm, \deg … for symbols.</small>
      <NumberField
        label="Font size (pt)"
        max={144}
        min={2}
        onCommit={(fontSizePt) => setStyle({ fontSizePt })}
        step={0.5}
        value={style.fontSizePt}
      />
      {(["bold", "italic", "underline"] as const).map((key) => (
        <label className="inline" key={key}>
          <input
            checked={style[key]}
            onChange={(event) => setStyle({ [key]: event.target.checked })}
            type="checkbox"
          />
          {key[0]?.toUpperCase() + key.slice(1)}
        </label>
      ))}
      <label>
        Text color
        <input
          onChange={(event) => setStyle({ colorHex: event.target.value.toUpperCase() })}
          type="color"
          value={style.colorHex.toLowerCase()}
        />
      </label>
      <label>
        Alignment
        <select
          onChange={(event) => setStyle({ align: event.target.value as TextStyleV2["align"] })}
          value={style.align}
        >
          <option value="start">Left</option>
          <option value="middle">Center</option>
          <option value="end">Right</option>
        </select>
      </label>
      <label className="inline">
        <input
          checked={style.backgroundHex !== null}
          onChange={(event) => setStyle({ backgroundHex: event.target.checked ? "#FFFFFF" : null })}
          type="checkbox"
        />
        Background
      </label>
      {style.backgroundHex !== null && (
        <label>
          Background color
          <input
            onChange={(event) => setStyle({ backgroundHex: event.target.value.toUpperCase() })}
            type="color"
            value={style.backgroundHex.toLowerCase()}
          />
        </label>
      )}
    </>
  );
}

function LineFields({
  object,
  update,
}: {
  object: LineObject;
  update: (replacement: (current: FigureObject) => FigureObject) => void;
}) {
  const setLine = (patch: Partial<LineObject["line"]>) =>
    update((current) =>
      current.type === "line" ? { ...current, line: { ...current.line, ...patch } } : current,
    );
  return (
    <>
      <label>
        Arrowheads
        <select
          onChange={(event) =>
            setLine({ heads: event.target.value as LineObject["line"]["heads"] })
          }
          value={object.line.heads}
        >
          <option value="none">None</option>
          <option value="end">At end</option>
          <option value="start">At start</option>
          <option value="both">Both ends</option>
        </select>
      </label>
      <label>
        Slope
        <select
          onChange={(event) =>
            setLine({ direction: event.target.value as LineObject["line"]["direction"] })
          }
          value={object.line.direction}
        >
          <option value="down">Falling (top-left to bottom-right)</option>
          <option value="up">Rising (bottom-left to top-right)</option>
        </select>
      </label>
      <StrokeFields onChange={(stroke) => setLine({ stroke })} stroke={object.line.stroke} />
    </>
  );
}

function ShapeFields({
  object,
  update,
}: {
  object: ShapeObject;
  update: (replacement: (current: FigureObject) => FigureObject) => void;
}) {
  const { shape } = object;
  const setShape = (next: ShapeObject["shape"]) =>
    update((current) => (current.type === "shape" ? { ...current, shape: next } : current));
  if (shape.kind === "bracket")
    return (
      <>
        <label>
          Bracket opens
          <select
            onChange={(event) =>
              setShape({ ...shape, opening: event.target.value as typeof shape.opening })
            }
            value={shape.opening}
          >
            <option value="down">Down</option>
            <option value="up">Up</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        <StrokeFields onChange={(stroke) => setShape({ ...shape, stroke })} stroke={shape.stroke} />
      </>
    );
  return (
    <>
      <label className="inline">
        <input
          checked={shape.stroke !== null}
          onChange={(event) =>
            setShape({
              ...shape,
              stroke: event.target.checked
                ? { colorHex: "#000000", widthPt: 1, dashed: false }
                : null,
              fillHex: event.target.checked || shape.fillHex ? shape.fillHex : "#000000",
            })
          }
          type="checkbox"
        />
        Outline
      </label>
      {shape.stroke && (
        <StrokeFields onChange={(stroke) => setShape({ ...shape, stroke })} stroke={shape.stroke} />
      )}
      <label className="inline">
        <input
          checked={shape.fillHex !== null}
          onChange={(event) =>
            setShape({
              ...shape,
              fillHex: event.target.checked ? "#FFFFFF" : null,
              stroke:
                event.target.checked || shape.stroke
                  ? shape.stroke
                  : { colorHex: "#000000", widthPt: 1, dashed: false },
            })
          }
          type="checkbox"
        />
        Fill
      </label>
      {shape.fillHex !== null && (
        <label>
          Fill color
          <input
            onChange={(event) => setShape({ ...shape, fillHex: event.target.value.toUpperCase() })}
            type="color"
            value={shape.fillHex.toLowerCase()}
          />
        </label>
      )}
    </>
  );
}
