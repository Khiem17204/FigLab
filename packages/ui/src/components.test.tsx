import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  acceptsFile,
  Badge,
  Button,
  clampToStep,
  Field,
  formatShortcut,
  IconButton,
  Input,
  initials,
  MAX_TOASTS,
  ProgressBar,
  Section,
  Segmented,
  Slider,
  Switch,
  toastReducer,
} from "./index";

const noop = () => undefined;

describe("Button", () => {
  it("defaults to a secondary button that cannot submit forms by accident", () => {
    const html = renderToStaticMarkup(<Button>Rename</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="secondary"');
  });

  it("marks loading buttons busy and keeps their label", () => {
    const html = renderToStaticMarkup(
      <Button loading variant="primary">
        Create project
      </Button>,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Create project");
  });
});

describe("IconButton", () => {
  it("names the button with its label and exposes the shortcut", () => {
    const html = renderToStaticMarkup(
      <IconButton icon={<span />} label="Undo" shortcut="Mod+Z" tooltip={false} />,
    );
    expect(html).toMatch(/aria-label="Undo"/);
    expect(html).toMatch(/aria-keyshortcuts="(Control|Meta)\+Z"/);
  });
});

describe("formatShortcut", () => {
  it("uses symbols on Apple platforms and words elsewhere", () => {
    expect(formatShortcut("Mod+Shift+Z", true)).toBe("⌘⇧Z");
    expect(formatShortcut("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
  });
});

describe("Field", () => {
  it("labels the control and describes it with hint and error", () => {
    const html = renderToStaticMarkup(
      <Field error="Give your project a name." hint="Shown on the dashboard." label="Project name">
        <Input id="name" />
      </Field>,
    );
    expect(html).toContain('for="name"');
    expect(html).toContain('aria-describedby="name-hint name-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Give your project a name.");
  });
});

describe("Slider", () => {
  it("labels the range with the visible label and the number box separately", () => {
    const html = renderToStaticMarkup(
      <Slider label="Brightness" max={1} min={-1} onChange={noop} step={0.01} value={0.25} />,
    );
    expect(html).toMatch(
      /<label for="([^"]+)">Brightness<\/label><input class="fl-range"[^>]*id="\1"/,
    );
    expect(html).toContain('aria-label="Brightness value"');
    expect(html).toContain('value="0.25"');
    expect(html).toContain("--fl-p:62.5%");
  });

  it("clamps typed values to the range and step", () => {
    expect(clampToStep(5, 0.1, 10, 0.1)).toBe(5);
    expect(clampToStep(12, 0.1, 10, 0.1)).toBe(10);
    expect(clampToStep(-3, -1, 1, 0.01)).toBe(-1);
    expect(clampToStep(0.123, -1, 1, 0.01)).toBe(0.12);
  });
});

describe("Segmented", () => {
  it("renders a named radio group with the current value checked", () => {
    const html = renderToStaticMarkup(
      <Segmented
        label="PNG scale"
        onChange={noop}
        options={[
          { value: "1", label: "1×" },
          { value: "2", label: "2×" },
        ]}
        value="2"
      />,
    );
    expect(html).toContain("<legend");
    expect(html).toContain("PNG scale");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/checked=""[^>]*value="2"/);
  });
});

describe("Switch", () => {
  it("is a native checkbox labelled by its text", () => {
    const html = renderToStaticMarkup(<Switch checked label="Invert" onCheckedChange={noop} />);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Invert");
  });
});

describe("ProgressBar", () => {
  it("reports determinate progress as a percentage", () => {
    const html = renderToStaticMarkup(<ProgressBar label="Uploading cells.png" value={0.42} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("width:42%");
  });

  it("omits the value while indeterminate", () => {
    const html = renderToStaticMarkup(<ProgressBar label="Verifying" />);
    expect(html).not.toContain("aria-valuenow");
    expect(html).toContain("data-indeterminate");
  });
});

describe("Section", () => {
  it("toggles a labelled region and hides the body when closed", () => {
    const html = renderToStaticMarkup(
      <Section defaultOpen={false} title="Display">
        <p>Body</p>
      </Section>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/class="fl-section-body" hidden=""/);
  });
});

describe("Badge", () => {
  it("carries its tone as data", () => {
    expect(renderToStaticMarkup(<Badge tone="success">Verified</Badge>)).toContain(
      'data-tone="success"',
    );
  });
});

describe("toastReducer", () => {
  it("adds, replaces by id, caps the queue and dismisses", () => {
    let state = toastReducer([], { type: "add", toast: { id: "a", title: "Saved" } });
    state = toastReducer(state, { type: "add", toast: { id: "a", title: "Saved again" } });
    expect(state).toEqual([{ id: "a", title: "Saved again" }]);
    for (let index = 0; index < MAX_TOASTS + 2; index += 1)
      state = toastReducer(state, { type: "add", toast: { id: `t${index}`, title: "x" } });
    expect(state).toHaveLength(MAX_TOASTS);
    expect(state.at(-1)?.id).toBe(`t${MAX_TOASTS + 1}`);
    state = toastReducer(state, { type: "dismiss", id: `t${MAX_TOASTS + 1}` });
    expect(state.map((toast) => toast.id)).not.toContain(`t${MAX_TOASTS + 1}`);
  });
});

describe("acceptsFile", () => {
  const accept = "image/png,image/jpeg,image/tiff,.tif,.tiff";
  it("matches MIME types and extensions", () => {
    expect(acceptsFile({ name: "cells.png", type: "image/png" }, accept)).toBe(true);
    expect(acceptsFile({ name: "stack.TIF", type: "" }, accept)).toBe(true);
    expect(acceptsFile({ name: "notes.pdf", type: "application/pdf" }, accept)).toBe(false);
    expect(acceptsFile({ name: "any.bin", type: "" }, "image/*")).toBe(false);
    expect(acceptsFile({ name: "a.gif", type: "image/gif" }, "image/*")).toBe(true);
  });
});

describe("initials", () => {
  it("uses two name parts when present", () => {
    expect(initials("khiem.le@lab.org")).toBe("KL");
    expect(initials("ada@lab.org")).toBe("AD");
  });
});
