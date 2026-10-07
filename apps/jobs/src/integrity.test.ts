import { createHash } from "node:crypto";
import { InMemoryFigLabRepository } from "@figlab/database";
import { FakeObjectStore } from "@figlab/storage";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createTaskList } from "./index.js";

async function readyPng(
  repository: InMemoryFigLabRepository,
  store: FakeObjectStore,
  projectId: string,
) {
  // 4 × 2 gray ramp; the right column is saturated white.
  const raw = Buffer.from([0, 80, 160, 255, 0, 80, 160, 255]);
  const bytes = new Uint8Array(
    await sharp(raw, { raw: { width: 4, height: 2, channels: 1 } })
      .png()
      .toBuffer(),
  );
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await repository.createUpload({
    projectId,
    filename: "ramp.png",
    mimeType: "image/png",
    contentLength: bytes.byteLength,
    checksumSha256,
    storageKey: `ramp-${projectId}`,
  });
  await store.putForTest(`ramp-${projectId}`, bytes, "image/png");
  await repository.updateAsset(upload.assetId, {
    status: "ready",
    widthPx: 4,
    heightPx: 2,
    bitDepth: 8,
    channelCount: 4,
  });
  return { assetId: upload.assetId, checksumSha256 };
}

describe("integrity_report job", () => {
  it("computes a report from the stored original at the requested revision", async () => {
    const repository = new InMemoryFigLabRepository();
    const store = new FakeObjectStore();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Ramp");
    const { assetId, checksumSha256 } = await readyPng(repository, store, project.id);
    const current = (await repository.getDocument(project.id)).document as {
      artboards: { id: string }[];
    };
    await repository.saveDocument(project.id, 0, {
      ...current,
      schemaVersion: 3,
      sources: [],
      objects: [
        {
          id: "panel",
          type: "image-view",
          artboardId: current.artboards[0]?.id,
          transform: { xPt: 0, yPt: 0, widthPt: 40, heightPt: 20, rotationDeg: 0 },
          zIndex: 0,
          locked: false,
          hidden: false,
          view: {
            sourceAssetId: assetId,
            plane: 0,
            channel: null,
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            display: {
              levels: { black: 0, white: 1 },
              brightness: 0,
              contrast: 1,
              gamma: 2,
              invert: false,
              lut: "none",
            },
          },
        },
      ],
      groups: [],
      constraints: [],
      styles: [],
    });
    const requested = await repository.requestIntegrityReport(project.id, 1);
    await createTaskList(repository, store).integrity_report?.(
      { reportId: requested.id },
      {} as never,
    );
    const record = await repository.getIntegrityReport(requested.id);
    expect(record.status).toBe("ready");
    const report = record.report as {
      revision: number;
      panels: {
        readings: { checksumSha256: string; cropPx: unknown; stats: { sourceSaturated: number } }[];
        findings: { code: string }[];
      }[];
    };
    expect(report.revision).toBe(1);
    expect(report.panels[0]?.readings[0]).toMatchObject({
      checksumSha256,
      cropPx: { x: 0, y: 0, width: 4, height: 2 },
    });
    // RGB samples of a gray ramp: one of four columns is at the maximum.
    expect(report.panels[0]?.readings[0]?.stats.sourceSaturated).toBeCloseTo(0.25);
    expect(report.panels[0]?.findings.map((finding) => finding.code)).toEqual([
      "gamma",
      "source-saturation",
    ]);
  });

  it("marks the report failed when an original cannot be read", async () => {
    const repository = new InMemoryFigLabRepository();
    const store = new FakeObjectStore();
    const principal = await repository.bootstrapSingleUser();
    const project = await repository.createProject(principal.workspaceId, "Missing");
    const { assetId } = await readyPng(repository, store, project.id);
    const current = (await repository.getDocument(project.id)).document as {
      artboards: { id: string }[];
    };
    await repository.saveDocument(project.id, 0, {
      ...current,
      schemaVersion: 3,
      sources: [],
      objects: [
        {
          id: "panel",
          type: "image-view",
          artboardId: current.artboards[0]?.id,
          transform: { xPt: 0, yPt: 0, widthPt: 40, heightPt: 20, rotationDeg: 0 },
          zIndex: 0,
          locked: false,
          hidden: false,
          view: {
            sourceAssetId: assetId,
            plane: 0,
            channel: 2,
            viewport: { x: 0, y: 0, width: 1, height: 1 },
            rotationDeg: 0,
            flipX: false,
            flipY: false,
            display: {
              levels: { black: 0, white: 1 },
              brightness: 0,
              contrast: 1,
              gamma: 1,
              invert: false,
              lut: "none",
            },
          },
        },
      ],
      groups: [],
      constraints: [],
      styles: [],
    });
    await store.delete(`ramp-${project.id}`);
    const requested = await repository.requestIntegrityReport(project.id, 1);
    await createTaskList(repository, store).integrity_report?.(
      { reportId: requested.id },
      {} as never,
    );
    expect(await repository.getIntegrityReport(requested.id)).toMatchObject({ status: "failed" });
  });
});
