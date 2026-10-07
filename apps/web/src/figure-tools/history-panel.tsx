import type { AuditEventDto, ExportRecord, VersionSummary } from "@figlab/api-contract";
import type { FigureDocument } from "@figlab/figure-schema";
import { Button, useDialogs } from "@figlab/ui";
import { useCallback, useEffect, useState } from "react";

import type { FigLabClient } from "../api/client";

const ACTION_LABELS: Record<string, string> = {
  PROJECT_CREATED: "Project created",
  PROJECT_RENAMED: "Project renamed",
  DOCUMENT_UPDATED: "Figure saved",
  CROP_CREATED: "Crop created",
  CROP_CHANGED: "Crop changed",
  DISPLAY_CHANGED: "Display adjusted",
  OBJECT_TRANSFORMED: "Moved or resized",
  OBJECT_REMOVED: "Object removed",
  OBJECT_CREATED: "Object added",
  OBJECT_CHANGED: "Object edited",
  ARTBOARD_CREATED: "Figure added",
  ARTBOARD_CHANGED: "Figure changed",
  ARTBOARD_REMOVED: "Figure removed",
  GROUPS_CHANGED: "Groups changed",
  ASSET_UPLOADED: "Original verified",
  EXPORT_CREATED: "Exported",
  PROJECT_DELETION_REQUESTED: "Deletion requested",
  PROJECT_DELETED: "Project deleted",
};

/** A short, human-readable account of one audit event. */
export function describeAuditEvent(event: Pick<AuditEventDto, "action" | "details">): string {
  const label = ACTION_LABELS[event.action] ?? event.action;
  const details = event.details as Record<string, unknown>;
  if (event.action === "DISPLAY_CHANGED") {
    const before = details.before as Record<string, unknown> | undefined;
    const after = details.after as Record<string, unknown> | undefined;
    const changes = Object.keys(after ?? {})
      .filter((key) => before?.[key] !== after?.[key])
      .map((key) => `${key} ${String(before?.[key])} → ${String(after?.[key])}`);
    return `${label}: ${changes.join(", ")}`;
  }
  if (event.action === "EXPORT_CREATED")
    return `${label}: ${String(details.format ?? "png").toUpperCase()}${details.dpi ? ` at ${String(details.dpi)} dpi` : ""}, revision ${String(details.revision)}`;
  if (event.action === "PROJECT_RENAMED") return `${label}: ${String(details.name)}`;
  if (event.action === "OBJECT_CREATED") return `${label}: ${String(details.type)}`;
  if (event.action === "DOCUMENT_UPDATED")
    return `${label} (${String(details.objectCountAfter)} objects, ${String(details.artboardCountAfter)} figures)`;
  return label;
}

const time = (value: string) => new Date(value).toLocaleString();

/** The project's audit trail, saved versions, and export records. */
export function HistoryPanel({
  client,
  projectId,
  revision,
  refreshKey,
  onRestore,
}: {
  client: FigLabClient;
  projectId: string;
  revision: number;
  /** Changing this (for example after an export) reloads the history. */
  refreshKey?: unknown;
  onRestore: (document: FigureDocument, revision: number) => void;
}) {
  const dialogs = useDialogs();
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [olderThan, setOlderThan] = useState<number>();
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [status, setStatus] = useState("");

  const refresh = useCallback(async () => {
    // Load each list on its own so one failing request does not hide the others.
    const [page, versionList, exportList] = await Promise.allSettled([
      client.listAuditEvents(projectId, { limit: 50 }),
      client.listVersions(projectId, { limit: 50 }),
      client.listExports(projectId),
    ]);
    if (page.status === "fulfilled") {
      setEvents(page.value.events);
      setOlderThan(page.value.nextBeforeSequence);
    }
    if (versionList.status === "fulfilled") setVersions(versionList.value);
    if (exportList.status === "fulfilled") setExports(exportList.value);
    const failed = [page, versionList, exportList].find((result) => result.status === "rejected");
    setStatus(
      failed?.status === "rejected"
        ? `Some history is unavailable: ${failed.reason instanceof Error ? failed.reason.message : "request failed"}`
        : "",
    );
  }, [client, projectId]);

  // Reload whenever a new revision is saved or the caller signals new history (an export).
  useEffect(() => {
    void revision;
    void refreshKey;
    void refresh();
  }, [refresh, revision, refreshKey]);

  return (
    <section aria-label="History" className="figure-tools-panel">
      <h3>History</h3>
      <Button onClick={() => void refresh()}>Refresh history</Button>
      {status && <p role="status">{status}</p>}
      <h4>Audit trail</h4>
      <ol className="history-list" aria-label="Audit trail">
        {events.map((event) => (
          <li key={event.id}>
            <strong>{describeAuditEvent(event)}</strong>
            <br />
            {time(event.createdAt)}
            {event.actor ? ` · ${event.actor.email}` : ""}
          </li>
        ))}
      </ol>
      {olderThan !== undefined && (
        <Button
          onClick={async () => {
            const page = await client.listAuditEvents(projectId, {
              limit: 50,
              beforeSequence: olderThan,
            });
            setEvents((current) => [...current, ...page.events]);
            setOlderThan(page.nextBeforeSequence);
          }}
        >
          Load older events
        </Button>
      )}
      <h4>Saved versions</h4>
      <ol className="history-list" aria-label="Saved versions">
        {versions.map((version) => (
          <li key={version.revision}>
            Revision {version.revision} · {time(version.createdAt)}
            {version.revision !== revision && (
              <Button
                onClick={async () => {
                  const confirmed = await dialogs.confirm({
                    title: `Restore revision ${version.revision}?`,
                    description: "It is saved as a new revision; nothing is deleted.",
                    confirmLabel: "Restore",
                  });
                  if (!confirmed) return;
                  const loaded = await client.getVersion(projectId, version.revision);
                  onRestore(loaded.document, version.revision);
                }}
              >
                Restore revision {version.revision}
              </Button>
            )}
          </li>
        ))}
      </ol>
      <h4>Exports</h4>
      <ol className="history-list" aria-label="Exports">
        {exports.map((record) => (
          <li key={record.id}>
            {record.format.toUpperCase()} · revision {record.revision} · {record.widthPx}×
            {record.heightPx}
            {record.dpi ? ` · ${record.dpi} dpi` : ""} · SHA-256{" "}
            {record.checksumSha256.slice(0, 12)}…
            <br />
            {time(record.createdAt)}
          </li>
        ))}
      </ol>
    </section>
  );
}
