import {
  bigint,
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
