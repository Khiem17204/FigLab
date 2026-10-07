import type { FigureDocument } from "@figlab/figure-schema";

export type SaveStatus = "saved" | "saving" | "error" | "conflict";
export type SavedDocument = { document: FigureDocument; revision: number };

export class AutosaveController {
  private status: SaveStatus = "saved";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private localDocument: FigureDocument | undefined;
  private generation = 0;
  private savedGeneration = -1;
  private lastSaved: SavedDocument | undefined;
  private inFlight: Promise<SavedDocument | undefined> | undefined;

  constructor(
    private readonly save: (baseRevision: number, document: FigureDocument) => Promise<number>,
    private readonly readDocument: () => FigureDocument,
    private readonly readRevision: () => number,
    private readonly onStatus?: (status: SaveStatus) => void,
  ) {}

  schedule(): void {
    this.generation += 1;
    if (this.status === "conflict") {
      this.localDocument = structuredClone(this.readDocument());
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(), 1_000);
  }

  async saveNow(): Promise<SavedDocument | undefined> {
    if (this.status === "conflict") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inFlight) {
      const saved = await this.inFlight;
      if (!saved || this.status === "error") return undefined;
      if (this.savedGeneration === this.generation) return cloneSaved(saved);
      return this.saveNow();
    }
    if (this.lastSaved && this.savedGeneration === this.generation) {
      return cloneSaved(this.lastSaved);
    }
    this.localDocument = structuredClone(this.readDocument());
    const generation = this.generation;
    this.setStatus("saving");
    const operation = this.performSave(generation, this.localDocument);
    let tracked: Promise<SavedDocument | undefined>;
    tracked = operation.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  flushBeforeNavigation(): Promise<SavedDocument | undefined> {
    return this.saveNow();
  }

  getStatus(): SaveStatus {
    return this.status;
  }

  getLocalDocument(): FigureDocument | undefined {
    return this.localDocument && structuredClone(this.localDocument);
  }

  downloadMyJson(): Blob {
    this.localDocument = structuredClone(this.readDocument());
    return new Blob([JSON.stringify(this.localDocument, null, 2)], { type: "application/json" });
  }

  resetAfterReload(): void {
    this.localDocument = undefined;
    this.lastSaved = undefined;
    this.savedGeneration = -1;
    this.setStatus("saved");
  }

  private async performSave(
    generation: number,
    document: FigureDocument,
  ): Promise<SavedDocument | undefined> {
    try {
      const revision = await this.save(this.readRevision(), document);
      const saved = { document: structuredClone(document), revision };
      this.savedGeneration = generation;
      this.lastSaved = saved;
      this.setStatus("saved");
      return cloneSaved(saved);
    } catch (error) {
      this.setStatus(isConflict(error) ? "conflict" : "error");
      return undefined;
    }
  }

  private setStatus(status: SaveStatus): void {
    this.status = status;
    this.onStatus?.(status);
  }
}

function cloneSaved(saved: SavedDocument): SavedDocument {
  return { document: structuredClone(saved.document), revision: saved.revision };
}

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 409;
}
