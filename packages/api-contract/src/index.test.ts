import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import * as apiContract from "./index.js";
import {
  AssetDescriptorSchema,
  apiRoutes,
  PrepareUploadRequestSchema,
  RevisionConflictSchema,
  SaveDocumentRequestSchema,
} from "./index.js";

describe("public API contracts", () => {
  it("freezes versioned route paths", () => {
    expect(apiRoutes).toEqual({
      health: "/health",
      projects: "/v1/projects",
      project: "/v1/projects/:projectId",
      projectDocument: "/v1/projects/:projectId/document",
      projectUploads: "/v1/projects/:projectId/uploads",
      uploadComplete: "/v1/uploads/:uploadId/complete",
      asset: "/v1/assets/:assetId",
      assetDownloadUrl: "/v1/assets/:assetId/download-url",
      projectExports: "/v1/projects/:projectId/exports",
    });
  });

  it("accepts a revisioned save with the schema version inside the document", () => {
    expect(
      Value.Check(SaveDocumentRequestSchema, {
        baseRevision: 4,
        document: {
          schemaVersion: 1,
          artboards: [
            {
              id: "artboard-1",
              name: "Figure 1",
              widthPt: 612,
              heightPt: 792,
              backgroundHex: "#FFFFFF",
            },
          ],
          objects: [],
          groups: [],
          constraints: [],
          styles: [],
        },
      }),
    ).toBe(true);
  });

  it("requires an exact lowercase SHA-256 claim when preparing an upload", () => {
    const request = {
      filename: "source.tif",
      contentType: "image/tiff",
      contentLength: 1024,
      checksumSha256: "a".repeat(64),
    };

    expect(Value.Check(PrepareUploadRequestSchema, request)).toBe(true);
    expect(Value.Check(PrepareUploadRequestSchema, { ...request, checksumSha256: "ABC" })).toBe(
      false,
    );
  });

  it("rejects upload requests larger than 100 MiB", () => {
    const request = {
      filename: "source.tif",
      contentType: "image/tiff",
      contentLength: 104_857_600,
      checksumSha256: "a".repeat(64),
    };

    expect(Value.Check(PrepareUploadRequestSchema, request)).toBe(true);
    expect(
      Value.Check(PrepareUploadRequestSchema, { ...request, contentLength: 104_857_601 }),
    ).toBe(false);
  });

  it("rejects exports over 100 million pixels even when each edge is allowed", () => {
    const validateRecordExportRequest = (
      apiContract as {
        validateRecordExportRequest?: (request: unknown) => boolean;
      }
    ).validateRecordExportRequest;

    expect(validateRecordExportRequest).toBeTypeOf("function");
    expect(
      validateRecordExportRequest?.({
        format: "png",
        revision: 0,
        widthPx: 10_000,
        heightPx: 10_000,
        checksumSha256: "c".repeat(64),
      }),
    ).toBe(true);
    expect(
      validateRecordExportRequest?.({
        format: "png",
        revision: 0,
        widthPx: 10_001,
        heightPx: 10_000,
        checksumSha256: "c".repeat(64),
      }),
    ).toBe(false);
  });

  it("uses the typed revision-conflict error envelope", () => {
    expect(
      Value.Check(RevisionConflictSchema, {
        code: "REVISION_CONFLICT",
        message: "The document changed in another session.",
        currentRevision: 5,
      }),
    ).toBe(true);
  });

  it("keeps storage locations out of public asset descriptors", () => {
    const asset = {
      id: "asset-1",
      projectId: "project-1",
      filename: "source.tif",
      mimeType: "image/tiff",
      checksumSha256: "b".repeat(64),
      widthPx: 2048,
      heightPx: 1024,
      bitDepth: 16,
      channelCount: 1,
      status: "ready",
      metadata: {},
      createdAt: "2026-08-12T00:00:00.000Z",
    };

    expect(Value.Check(AssetDescriptorSchema, asset)).toBe(true);
    expect(Value.Check(AssetDescriptorSchema, { ...asset, storageKey: "secret/key" })).toBe(false);
  });
});
