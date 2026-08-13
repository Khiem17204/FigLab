import type { FigureDocumentV1 } from "@figlab/figure-schema";

export type SaveStatus = "saved" | "saving" | "error" | "conflict";

export class AutosaveController {
  private status: SaveStatus = "saved";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private localDocument: FigureDocumentV1 | undefined;

  constructor(
    private readonly save: (baseRevision: number, document: FigureDocumentV1) => Promise<void>,
    private readonly readDocument: () => FigureDocumentV1,
    private readonly readRevision: () => number,
    private readonly onStatus?: (status: SaveStatus) => void,
  ) {}

  schedule(): void {
    if (this.status === "conflict") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(), 1_000);
  }

  async saveNow(): Promise<void> {
    if (this.status === "conflict") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.localDocument = structuredClone(this.readDocument());
    this.setStatus("saving");
    try {
      await this.save(this.readRevision(), this.localDocument);
      this.setStatus("saved");
    } catch (error) {
      this.setStatus(isConflict(error) ? "conflict" : "error");
    }
  }

  flushBeforeNavigation(): Promise<void> {
    return this.saveNow();
  }

  getStatus(): SaveStatus {
    return this.status;
  }

  getLocalDocument(): FigureDocumentV1 | undefined {
    return this.localDocument && structuredClone(this.localDocument);
  }

  downloadMyJson(): Blob {
    if (!this.localDocument) this.localDocument = structuredClone(this.readDocument());
    return new Blob([JSON.stringify(this.localDocument, null, 2)], { type: "application/json" });
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    this.onStatus?.(status);
  }
}

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
