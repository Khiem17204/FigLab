import { expect, it } from "vitest";
import { type FigLabRepository, NotFoundError, type Principal } from "./index.js";

type Setup = () => Promise<{ repository: FigLabRepository; principal: Principal }>;

let board = {
  id: "board",
  name: "Figure 1",
  widthPt: 612,
  heightPt: 792,
  backgroundHex: "#FFFFFF",
};
const document = (objects: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  artboards: [board],
  objects,
  groups: [],
  constraints: [],
  styles: [],
  ...extra,
});
const text = (content: string, xPt = 10) => ({
  id: "text-1",
  type: "text",
  artboardId: board.id,
  transform: { xPt, yPt: 10, widthPt: 40, heightPt: 12, rotationDeg: 0 },
  zIndex: 0,
  locked: false,
  hidden: false,
  text: {
    content,
    style: {
      fontSizePt: 8,
      bold: false,
      italic: false,
      underline: false,
      colorHex: "#000000",
      align: "start",
      backgroundHex: null,
    },
  },
});

/** Audit, version, export, and tombstone behavior every repository implementation must share. */
export function historyContract(setupRepository: Setup): void {
  /** Documents in these tests reuse the project's own artboard, as the editor would. */
  const createProject = async (
    repository: FigLabRepository,
    principal: Principal,
    name: string,
    options = {},
  ) => {
    const project = await repository.createProject(principal.workspaceId, name, options);
    const stored = (await repository.getDocument(project.id)).document as {
      artboards: (typeof board)[];
    };
    board = stored.artboards[0] ?? board;
    return project;
  };
  const setup = setupRepository;

  it("attributes events to their actor and pages them newest first", async () => {
    const { repository, principal } = await setup();
    const actor = { actorUserId: principal.id };
    const project = await createProject(repository, principal, "History", actor);
    await repository.saveDocument(project.id, 0, document([text("A")]), actor);
    await repository.renameProject(project.id, "History 2", actor);

    const all = await repository.listAuditEvents(project.id);
    expect(all.map((event) => event.action)).toEqual([
      "PROJECT_CREATED",
      "DOCUMENT_UPDATED",
      "OBJECT_CREATED",
      "PROJECT_RENAMED",
    ]);
    expect(all.every((event) => event.actor?.email === principal.email)).toBe(true);
    const sequences = all.map((event) => event.sequence);
    expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);

    const first = await repository.pageAuditEvents(project.id, { limit: 3 });
    expect(first.events.map((event) => event.action)).toEqual([
      "PROJECT_RENAMED",
      "OBJECT_CREATED",
      "DOCUMENT_UPDATED",
    ]);
    expect(first.nextBeforeSequence).toBe(first.events.at(-1)?.sequence);
    const second = await repository.pageAuditEvents(project.id, {
      limit: 3,
      beforeSequence: first.nextBeforeSequence as number,
    });
    expect(second.events.map((event) => event.action)).toEqual(["PROJECT_CREATED"]);
    expect(second.nextBeforeSequence).toBeUndefined();
  });

  it("derives events for text, artboards, and groups", async () => {
    const { repository, principal } = await setup();
    const project = await createProject(repository, principal, "Annotations");
    await repository.saveDocument(project.id, 0, document([text("A")]));
    const second = { ...text("B", 20), id: "text-2" };
    await repository.saveDocument(
      project.id,
      1,
      document([text("A2", 15), second], {
        artboards: [
          { ...board, widthPt: 252 },
          { ...board, id: "board-2", name: "Figure 2" },
        ],
        groups: [{ id: "g", objectIds: ["text-1", "text-2"] }],
      }),
    );
    const events = (await repository.listAuditEvents(project.id))
      .filter((event) => event.action !== "PROJECT_CREATED" && event.action !== "DOCUMENT_UPDATED")
      .map(({ action, details }) => ({ action, details }));
    expect(events.map((event) => event.action)).toEqual([
      "OBJECT_CREATED",
      "OBJECT_CHANGED",
      "OBJECT_TRANSFORMED",
      "OBJECT_CREATED",
      "ARTBOARD_CHANGED",
      "ARTBOARD_CREATED",
      "GROUPS_CHANGED",
    ]);
    expect(events[1]?.details).toEqual({
      objectId: "text-1",
      before: { text: text("A").text },
      after: { text: text("A2").text },
    });
    expect(events[4]?.details).toEqual({
      artboardId: board.id,
      before: { widthPt: 612 },
      after: { widthPt: 252 },
    });
  });

  it("lists saved versions and reads one back", async () => {
    const { repository, principal } = await setup();
    const project = await createProject(repository, principal, "Versions");
    for (let revision = 0; revision < 3; revision += 1)
      await repository.saveDocument(project.id, revision, document([text(`v${revision + 1}`)]));
    expect(
      (await repository.listVersions(project.id, { limit: 2 })).map((version) => version.revision),
    ).toEqual([3, 2]);
    expect(
      (await repository.listVersions(project.id, { limit: 5, beforeRevision: 2 })).map(
        (version) => version.revision,
      ),
    ).toEqual([1]);
    const version = await repository.getVersion(project.id, 2);
    expect(version).toMatchObject({ projectId: project.id, revision: 2, schemaVersion: 2 });
    expect(version.document).toEqual(document([text("v2")]));
    await expect(repository.getVersion(project.id, 9)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("records exports with format, figure, and DPI", async () => {
    const { repository, principal } = await setup();
    const project = await createProject(repository, principal, "Exports");
    const base = { projectId: project.id, revision: 0, checksumSha256: "e".repeat(64) };
    await repository.recordExport({ ...base, format: "png", widthPx: 612, heightPx: 792 });
    await repository.recordExport(
      { ...base, format: "tiff", artboardId: board.id, dpi: 600, widthPx: 5100, heightPx: 6600 },
      { actorUserId: principal.id },
    );
    const exports = await repository.listExports(project.id);
    expect(exports.map(({ format, artboardId, dpi }) => ({ format, artboardId, dpi }))).toEqual([
      { format: "tiff", artboardId: board.id, dpi: 600 },
      { format: "png", artboardId: undefined, dpi: undefined },
    ]);
    const audit = (await repository.listAuditEvents(project.id)).at(-1);
    expect(audit?.action).toBe("EXPORT_CREATED");
    expect(audit?.details).toMatchObject({ format: "tiff", dpi: 600, artboardId: board.id });
  });

  it("tombstones deleted projects but keeps their audit trail and export records", async () => {
    const { repository, principal } = await setup();
    const project = await createProject(repository, principal, "Doomed");
    await repository.saveDocument(project.id, 0, document([text("A")]));
    await repository.recordExport({
      projectId: project.id,
      revision: 1,
      format: "pdf",
      widthPx: 612,
      heightPx: 792,
      checksumSha256: "f".repeat(64),
    });
    await repository.markProjectDeleting(project.id, { actorUserId: principal.id });
    await repository.deleteProjectData(project.id);
    await repository.deleteProjectData(project.id);

    await expect(repository.getProject(project.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await repository.listProjects(principal.workspaceId)).some(({ id }) => id === project.id),
    ).toBe(false);
    await expect(repository.getDocument(project.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await repository.listVersions(project.id, { limit: 10 })).toEqual([]);
    expect(await repository.listExports(project.id)).toHaveLength(1);
    const actions = (await repository.listAuditEvents(project.id)).map((event) => event.action);
    expect(actions.slice(-2)).toEqual(["PROJECT_DELETION_REQUESTED", "PROJECT_DELETED"]);
    expect(actions.filter((action) => action === "PROJECT_DELETED")).toHaveLength(1);
  });

  it("tracks integrity reports for saved revisions", async () => {
    const { repository, principal } = await setup();
    const project = await createProject(repository, principal, "Integrity");
    await repository.saveDocument(project.id, 0, document([text("A")]));
    await repository.saveDocument(project.id, 1, document([text("B")]));
    await expect(repository.requestIntegrityReport(project.id, 9)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const older = await repository.requestIntegrityReport(project.id, 1, {
      actorUserId: principal.id,
    });
    const current = await repository.requestIntegrityReport(project.id, 2);
    expect(older).toMatchObject({ revision: 1, status: "pending", requestedBy: principal.id });
    expect((await repository.getDocumentAtRevision(project.id, 1)).document).toEqual(
      document([text("A")]),
    );
    await repository.completeIntegrityReport(older.id, { report: { panels: [] } });
    await repository.completeIntegrityReport(current.id, { error: "original missing" });
    expect(
      (await repository.listIntegrityReports(project.id, 10)).map(({ id, status }) => [id, status]),
    ).toEqual([
      [current.id, "failed"],
      [older.id, "ready"],
    ]);
    expect((await repository.getIntegrityReport(older.id)).report).toEqual({ panels: [] });
    const audit = (await repository.listAuditEvents(project.id)).filter(
      (event) => event.action === "INTEGRITY_REPORT_REQUESTED",
    );
    expect(audit.map((event) => event.details.revision)).toEqual([1, 2]);
  });
}
