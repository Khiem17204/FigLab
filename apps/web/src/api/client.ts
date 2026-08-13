import {
  type AssetDescriptor,
  type AssetStatus,
  apiRoutes,
  type PrepareUploadResponse,
  type Project,
  type ProjectDocumentResponse,
  type SaveDocumentResponse,
} from "@figlab/api-contract";
import type { FigureDocumentV1 } from "@figlab/figure-schema";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(
      typeof body === "object" && body && "message" in body
        ? String(body.message)
        : `HTTP ${status}`,
    );
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type Fetcher = typeof fetch;
export type UploadStage = "reserved" | "uploaded" | "verifying" | "completed" | "rejected";
export type UploadCompletion = { assetId: string; status: AssetStatus };

const path = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`:${key}`, encodeURIComponent(value)),
    template,
  );

export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class FigLabClient {
  constructor(
    private readonly fetcher: Fetcher = (...arguments_) => fetch(...arguments_),
    private readonly pollIntervalMs = 500,
  ) {}

  async listProjects(): Promise<Project[]> {
    return (await this.json<{ projects: Project[] }>(apiRoutes.projects)).projects;
  }

  createProject(name: string): Promise<Project> {
    return this.json(apiRoutes.projects, { method: "POST", body: { name } });
  }

  renameProject(projectId: string, name: string): Promise<Project> {
    return this.json(path(apiRoutes.project, { projectId }), { method: "PATCH", body: { name } });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.json(path(apiRoutes.project, { projectId }), { method: "DELETE" });
  }

  getDocument(projectId: string): Promise<ProjectDocumentResponse> {
    return this.json(path(apiRoutes.projectDocument, { projectId }));
  }

  saveDocument(
    projectId: string,
    baseRevision: number,
    document: FigureDocumentV1,
  ): Promise<SaveDocumentResponse> {
    return this.json(path(apiRoutes.projectDocument, { projectId }), {
      method: "PUT",
      body: { baseRevision, document },
    });
  }

  getAsset(assetId: string): Promise<AssetDescriptor> {
    return this.json(path(apiRoutes.asset, { assetId }));
  }

  async downloadAsset(assetId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
    const instruction = await this.json<{ url: string; expiresAt: string }>(
      path(apiRoutes.assetDownloadUrl, { assetId }),
    );
    const response = await this.fetcher(instruction.url);
    if (!response.ok) throw new ApiError(response.status, await readBody(response));
    return {
      bytes: await response.arrayBuffer(),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async prepareAndUpload(
    projectId: string,
    original: Blob,
    filename: string,
    onStage?: (stage: UploadStage) => void,
  ): Promise<AssetDescriptor> {
    const checksumSha256 = await sha256(original);
    const prepared = await this.json<PrepareUploadResponse>(
      path(apiRoutes.projectUploads, { projectId }),
      {
        method: "POST",
        body: {
          filename,
          contentType: original.type || "application/octet-stream",
          contentLength: original.size,
          checksumSha256,
        },
      },
    );
    onStage?.("reserved");
    const put = await this.fetcher(prepared.upload.url, {
      method: prepared.upload.method,
      headers: prepared.upload.headers,
      body: original,
    });
    if (!put.ok) throw new ApiError(put.status, await readBody(put));
    onStage?.("uploaded");
    const completed = await this.json<UploadCompletion>(
      path(apiRoutes.uploadComplete, { uploadId: prepared.uploadId }),
      {
        method: "POST",
      },
    );
    if (completed.status === "rejected") {
      onStage?.("rejected");
      return this.getAsset(prepared.assetId);
    }
    onStage?.("verifying");
    const asset = await this.pollAsset(prepared.assetId);
    onStage?.(asset.status === "rejected" ? "rejected" : "completed");
    return asset;
  }

  recordExport(
    projectId: string,
    metadata: {
      format: "png";
      revision: number;
      widthPx: number;
      heightPx: number;
      checksumSha256: string;
    },
  ): Promise<void> {
    return this.json(path(apiRoutes.projectExports, { projectId }), {
      method: "POST",
      body: metadata,
    });
  }

  private async json<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.fetcher(url, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
    });
    if (!response.ok) throw new ApiError(response.status, await readBody(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async pollAsset(assetId: string): Promise<AssetDescriptor> {
    for (;;) {
      const asset = await this.getAsset(assetId);
      if (asset.status !== "pending-verification") return asset;
      if (this.pollIntervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }
}

async function readBody(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
