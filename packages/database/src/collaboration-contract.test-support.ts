import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  ConflictError,
  type FigLabRepository,
  InviteUnavailableError,
  MembershipAuthorizer,
  NotFoundError,
  type Principal,
} from "./index.js";

type Setup = () => Promise<FigLabRepository>;

const token = () => createHash("sha256").update(randomUUID()).digest("hex");
const later = () => new Date(Date.now() + 86_400_000).toISOString();

async function users(repository: FigLabRepository, count: number): Promise<Principal[]> {
  const run = randomUUID().slice(0, 8);
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      repository.ensureAuthUser({ id: randomUUID(), email: `user${index}-${run}@lab.test` }),
    ),
  );
}

/** Lab workspaces, invites, folders, search, templates, comments, and admin: one behavior for both repositories. */
export function collaborationContract(setup: Setup): void {
  it("creates labs and accepts invite links once, for the invited email only", async () => {
    const repository = await setup();
    const [pi, student, stranger, late] = await users(repository, 4);
    if (!pi || !student || !stranger || !late) throw new Error("users");
    const lab = await repository.createLabWorkspace(pi.id, "Ramos Lab");
    expect(lab).toMatchObject({ name: "Ramos Lab", kind: "lab", role: "owner", memberCount: 1 });
    expect((await repository.listWorkspaces(pi.id)).map((workspace) => workspace.kind)).toEqual([
      "personal",
      "lab",
    ]);

    const hash = token();
    const invite = await repository.createInvite({
      workspaceId: lab.id,
      role: "editor",
      email: student.email.toUpperCase(),
      createdBy: pi.id,
      tokenSha256: hash,
      expiresAt: later(),
    });
    expect(invite).toMatchObject({ status: "pending", createdBy: { email: pi.email } });
    expect(await repository.previewInvite(hash)).toMatchObject({
      workspaceName: "Ramos Lab",
      role: "editor",
      status: "pending",
    });
    await expect(repository.acceptInvite(hash, stranger)).rejects.toMatchObject({
      reason: "email-mismatch",
    });
    const joined = await repository.acceptInvite(hash, student);
    expect(joined).toMatchObject({ id: lab.id, role: "editor", memberCount: 2 });
    // Members accepting again keep their role; others find the link used.
    expect((await repository.acceptInvite(hash, student)).role).toBe("editor");
    await expect(repository.acceptInvite(hash, late)).rejects.toBeInstanceOf(
      InviteUnavailableError,
    );
    expect((await repository.listInvites(lab.id))[0]).toMatchObject({
      status: "accepted",
      acceptedBy: { id: student.id },
    });

    const revokedHash = token();
    const revoked = await repository.createInvite({
      workspaceId: lab.id,
      role: "viewer",
      createdBy: pi.id,
      tokenSha256: revokedHash,
      expiresAt: later(),
    });
    expect((await repository.revokeInvite(lab.id, revoked.id)).status).toBe("revoked");
    await expect(repository.acceptInvite(revokedHash, late)).rejects.toMatchObject({
      reason: "revoked",
    });
    const expiredHash = token();
    await repository.createInvite({
      workspaceId: lab.id,
      role: "viewer",
      createdBy: pi.id,
      tokenSha256: expiredHash,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(repository.acceptInvite(expiredHash, late)).rejects.toMatchObject({
      reason: "expired",
    });
    await expect(repository.previewInvite(token())).rejects.toBeInstanceOf(NotFoundError);
    await expect(repository.revokeInvite(randomUUID(), revoked.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("enforces roles and always keeps an owner", async () => {
    const repository = await setup();
    const [pi, postdoc, viewer, outsider] = await users(repository, 4);
    if (!pi || !postdoc || !viewer || !outsider) throw new Error("users");
    const lab = await repository.createLabWorkspace(pi.id, "Roles Lab");
    for (const [user, role] of [
      [postdoc, "admin"],
      [viewer, "viewer"],
    ] as const) {
      const hash = token();
      await repository.createInvite({
        workspaceId: lab.id,
        role,
        createdBy: pi.id,
        tokenSha256: hash,
        expiresAt: later(),
      });
      await repository.acceptInvite(hash, user);
    }
    await expect(repository.setMemberRole(lab.id, pi.id, "admin")).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(repository.removeMember(lab.id, pi.id)).rejects.toBeInstanceOf(ConflictError);
    await repository.setMemberRole(lab.id, postdoc.id, "owner");
    expect((await repository.setMemberRole(lab.id, pi.id, "editor")).role).toBe("editor");
    await repository.removeMember(lab.id, viewer.id);
    expect(
      (await repository.listMembers(lab.id)).map((member) => [member.email, member.role]),
    ).toEqual([
      [pi.email, "editor"],
      [postdoc.email, "owner"],
    ]);

    const authorizer = new MembershipAuthorizer(repository);
    expect(await authorizer.requireWorkspace(pi, lab.id, "write")).toBe("editor");
    await expect(authorizer.requireWorkspace(pi, lab.id, "manage")).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    await expect(authorizer.requireWorkspace(outsider, lab.id, "read")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await authorizer.requireWorkspace(outsider, outsider.workspaceId)).toBe("owner");
  });

  it("files projects in folders, filters, and searches names and filenames across labs", async () => {
    const repository = await setup();
    const [pi, other] = await users(repository, 2);
    if (!pi || !other) throw new Error("users");
    const lab = await repository.createLabWorkspace(pi.id, "Folder Lab");
    const blots = await repository.createFolder(lab.id, "Blots");
    const year = await repository.createFolder(lab.id, "2026", blots.id);
    await expect(repository.updateFolder(blots.id, { parentId: year.id })).rejects.toBeInstanceOf(
      ConflictError,
    );
    const foreign = await repository.createFolder(other.workspaceId, "Elsewhere");
    await expect(
      repository.createProject(lab.id, "Bad", { folderId: foreign.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const erk = await repository.createProject(lab.id, "pERK time course", {
      folderId: year.id,
      actorUserId: pi.id,
    });
    const root = await repository.createProject(lab.id, "Microscopy", { actorUserId: pi.id });
    expect(erk).toMatchObject({ folderId: year.id, createdBy: pi.id });
    expect(
      (await repository.listProjects(lab.id, { folderId: null })).map((project) => project.id),
    ).toEqual([root.id]);
    expect(
      (await repository.listProjects(lab.id, { folderId: year.id })).map((project) => project.id),
    ).toEqual([erk.id]);
    expect(
      (await repository.listProjects(lab.id, { query: "perk" })).map((project) => project.id),
    ).toEqual([erk.id]);
    const moved = await repository.moveProject(erk.id, null, { actorUserId: pi.id });
    expect(moved.folderId).toBeUndefined();
    expect((await repository.listAuditEvents(erk.id)).map((event) => event.action).at(-1)).toBe(
      "PROJECT_MOVED",
    );
    const renamed = await repository.updateFolder(year.id, {
      name: "2026 Q4",
      parentId: null,
      archived: true,
    });
    expect(renamed).toMatchObject({ name: "2026 Q4", archived: true });
    expect(renamed.parentId).toBeUndefined();
    expect((await repository.updateFolder(year.id, { archived: false })).archived).toBe(false);

    await repository.createUpload({
      projectId: root.id,
      filename: "Confocal_DAPI_100%.tif",
      mimeType: "image/tiff",
      contentLength: 10,
      checksumSha256: "a".repeat(64),
      storageKey: `search/${randomUUID()}`,
    });
    const byName = await repository.searchProjects(pi.id, "ERK", 10);
    expect(byName.map((hit) => [hit.projectName, hit.workspaceName])).toEqual([
      ["pERK time course", "Folder Lab"],
    ]);
    const byFile = await repository.searchProjects(pi.id, "dapi_100%", 10);
    expect(byFile).toEqual([
      expect.objectContaining({
        projectId: root.id,
        matchedFilenames: ["Confocal_DAPI_100%.tif"],
      }),
    ]);
    expect(await repository.searchProjects(other.id, "ERK", 10)).toEqual([]);
  });

  it("stores workspace templates and starts projects from them", async () => {
    const repository = await setup();
    const [pi] = await users(repository, 1);
    if (!pi) throw new Error("users");
    const document = {
      schemaVersion: 3,
      sources: [],
      artboards: [
        { id: "a", name: "Layout", widthPt: 500, heightPt: 300, backgroundHex: "#FFFFFF" },
      ],
      objects: [],
      groups: [],
      constraints: [],
      styles: [],
    };
    const template = await repository.createTemplate({
      workspaceId: pi.workspaceId,
      name: "Two-column blot",
      document,
      createdBy: pi.id,
    });
    expect(await repository.listTemplates(pi.workspaceId)).toEqual([template]);
    expect((await repository.getTemplate(template.id)).document).toEqual(document);
    const project = await repository.createProject(pi.workspaceId, "From template", {
      document: (await repository.getTemplate(template.id)).document,
    });
    expect((await repository.getDocument(project.id)).document).toEqual(document);
    await repository.deleteTemplate(template.id);
    await expect(repository.getTemplate(template.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("threads anchored comments, resolves them with an audit trail, and removes them with the project", async () => {
    const repository = await setup();
    const [author, reviewer] = await users(repository, 2);
    if (!author || !reviewer) throw new Error("users");
    const project = await repository.createProject(author.workspaceId, "Reviewed");
    const comment = await repository.createComment({
      projectId: project.id,
      authorUserId: reviewer.id,
      body: "Is lane 3 saturated?",
      anchor: { artboardId: "board", objectId: "panel-a", xPt: 12.5, yPt: 40 },
    });
    expect(comment).toMatchObject({
      author: { email: reviewer.email },
      anchor: { artboardId: "board", objectId: "panel-a", xPt: 12.5, yPt: 40 },
    });
    const reply = await repository.createComment({
      projectId: project.id,
      authorUserId: author.id,
      body: "Re-exposed; fixed.",
      parentId: comment.id,
    });
    await expect(
      repository.createComment({
        projectId: project.id,
        authorUserId: author.id,
        body: "nested",
        parentId: reply.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const resolved = await repository.updateComment(
      comment.id,
      { resolvedBy: author.id },
      author.id,
    );
    expect(resolved).toMatchObject({ resolvedBy: { email: author.email } });
    expect(resolved.resolvedAt).toBeDefined();
    const reopened = await repository.updateComment(
      comment.id,
      { resolvedBy: null, body: "Is lane 3 saturated? (see raw)" },
      reviewer.id,
    );
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.body).toBe("Is lane 3 saturated? (see raw)");
    expect((await repository.listComments(project.id)).map((entry) => entry.id)).toEqual([
      comment.id,
      reply.id,
    ]);
    expect(
      (await repository.listAuditEvents(project.id))
        .map((event) => event.action)
        .filter((action) => action.startsWith("COMMENT")),
    ).toEqual(["COMMENT_ADDED", "COMMENT_ADDED", "COMMENT_RESOLVED", "COMMENT_REOPENED"]);
    await repository.deleteComment(comment.id, reviewer.id);
    expect(await repository.listComments(project.id)).toEqual([]);

    await repository.createComment({ projectId: project.id, authorUserId: author.id, body: "x" });
    await repository.deleteProjectData(project.id);
    expect(await repository.listComments(project.id)).toEqual([]);
  });

  it("summarizes users, workspaces, and storage for admins", async () => {
    const repository = await setup();
    const [pi] = await users(repository, 1);
    if (!pi) throw new Error("users");
    const lab = await repository.createLabWorkspace(pi.id, "Admin Lab");
    await repository.createProject(lab.id, "Counted", { actorUserId: pi.id });
    const overview = await repository.adminOverview();
    expect(overview.labWorkspaces).toBeGreaterThanOrEqual(1);
    expect(overview.users).toBeGreaterThanOrEqual(1);
    const workspaces = await repository.adminWorkspaces(1000);
    expect(workspaces.find((workspace) => workspace.id === lab.id)).toMatchObject({
      kind: "lab",
      members: 1,
      projects: 1,
    });
    expect((await repository.adminUsers(1000)).find((user) => user.id === pi.id)).toMatchObject({
      workspaces: 2,
      projects: 1,
    });
    expect(Array.isArray(await repository.adminFailedJobs(10))).toBe(true);
  });
}
