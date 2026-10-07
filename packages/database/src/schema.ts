import {
  type AnyPgColumn,
  bigint,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey();
const dates = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
};
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  ...dates,
});
export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("personal"),
  createdBy: uuid("created_by").references(() => users.id),
  ...dates,
});
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    ...dates,
  },
  (table) => [
    unique("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId),
  ],
);
export const projects = pgTable("projects", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  status: text("status").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  folderId: uuid("folder_id").references(() => folders.id),
  createdBy: uuid("created_by").references(() => users.id),
  ...dates,
});
export const projectDocuments = pgTable("project_documents", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id),
  revision: integer("revision").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  document: jsonb("document").notNull(),
  ...dates,
});
export const projectVersions = pgTable("project_versions", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  revision: integer("revision").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  document: jsonb("document").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const uploadSessions = pgTable("upload_sessions", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  status: text("status").notNull(),
  contentLength: integer("content_length").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const assets = pgTable(
  "assets",
  {
    id: id(),
    uploadId: uuid("upload_id")
      .notNull()
      .unique()
      .references(() => uploadSessions.id),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    status: text("status").notNull(),
    widthPx: integer("width_px"),
    heightPx: integer("height_px"),
    bitDepth: integer("bit_depth"),
    channelCount: integer("channel_count"),
    metadata: jsonb("metadata").notNull(),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("assets_storage_key_unique").on(table.storageKey)],
);
export const auditEvents = pgTable("audit_events", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  action: text("action").notNull(),
  details: jsonb("details").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const exportRecords = pgTable("export_records", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  revision: integer("revision").notNull(),
  format: text("format").notNull(),
  widthPx: integer("width_px").notNull(),
  heightPx: integer("height_px").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  metadata: jsonb("metadata").notNull(),
  artboardId: text("artboard_id"),
  dpi: integer("dpi"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const integrityReports = pgTable("integrity_reports", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  revision: integer("revision").notNull(),
  status: text("status").notNull(),
  report: jsonb("report"),
  error: text("error"),
  requestedBy: uuid("requested_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const workspaceInvites = pgTable("workspace_invites", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  tokenSha256: text("token_sha256").notNull().unique(),
  role: text("role").notNull(),
  email: text("email"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedBy: uuid("accepted_by").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
export const folders = pgTable("folders", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  parentId: uuid("parent_id").references((): AnyPgColumn => folders.id),
  name: text("name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  ...dates,
});
export const projectTemplates = pgTable("project_templates", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  document: jsonb("document").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  ...dates,
});
export const comments = pgTable("comments", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  parentId: uuid("parent_id").references((): AnyPgColumn => comments.id),
  authorUserId: uuid("author_user_id")
    .notNull()
    .references(() => users.id),
  artboardId: text("artboard_id"),
  objectId: text("object_id"),
  xPt: doublePrecision("x_pt"),
  yPt: doublePrecision("y_pt"),
  body: text("body").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  ...dates,
});
