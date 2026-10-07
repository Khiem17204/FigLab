import type { CommentDto, Project } from "@figlab/api-contract";
import { Button } from "@figlab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import type { FigLabClient } from "../api/client";
import type { EditorSessionState } from "../editor/session-store";
import { objectLabel } from "./arrange-panel";

const COMMENT_POLL_MS = 30_000;

/** Comment threads anchored to a figure or an object, with replies and resolve. */
export function CommentsPanel({
  client,
  projectId,
  session,
  currentUserId,
  canResolve,
  canModerate,
}: {
  client: FigLabClient;
  projectId: string;
  session: StoreApi<EditorSessionState>;
  currentUserId: string | undefined;
  /** Editors and above resolve any thread; authors always can. */
  canResolve: boolean;
  /** Workspace admins delete any comment; authors always can. */
  canModerate: boolean;
}) {
  const state = useStore(session);
  const queryClient = useQueryClient();
  const comments = useQuery({
    queryKey: ["comments", projectId],
    queryFn: () => client.listComments(projectId),
    refetchInterval: COMMENT_POLL_MS,
  });
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [replyTo, setReplyTo] = useState<string>();
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["comments", projectId] });
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The comment could not be saved.");
    }
  };

  const selected =
    state.selectedIds.length === 1
      ? state.document.objects.find((object) => object.id === state.selectedIds[0])
      : undefined;
  const artboard = state.document.artboards.find((entry) => entry.id === state.activeArtboardId);
  const anchorLabel = (comment: CommentDto) => {
    if (!comment.anchor) return "Project";
    const object = comment.anchor.objectId
      ? state.document.objects.find((entry) => entry.id === comment.anchor?.objectId)
      : undefined;
    const board = state.document.artboards.find((entry) => entry.id === comment.anchor?.artboardId);
    if (comment.anchor.objectId && !object) return `${board?.name ?? "Figure"} · removed object`;
    return object
      ? `${board?.name ?? "Figure"} · ${objectLabel(object)}`
      : (board?.name ?? "Figure");
  };
  const all = comments.data ?? [];
  const threads = all.filter(
    (comment) => !comment.parentId && (showResolved || !comment.resolvedAt),
  );
  const repliesTo = (id: string) => all.filter((comment) => comment.parentId === id);
  const openCount = all.filter((comment) => !comment.parentId && !comment.resolvedAt).length;

  return (
    <section aria-label="Comments" className="figure-tools-panel">
      <h3>{`Comments (${openCount} open)`}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = body.trim();
          if (!text) return;
          const anchor =
            attach && selected
              ? { artboardId: selected.artboardId, objectId: selected.id }
              : artboard
                ? { artboardId: artboard.id }
                : undefined;
          void run(async () => {
            await client.createComment(projectId, { body: text, ...(anchor ? { anchor } : {}) });
            setBody("");
          });
        }}
      >
        <label>
          Comment
          <textarea
            maxLength={4000}
            onChange={(event) => setBody(event.target.value)}
            rows={2}
            value={body}
          />
        </label>
        {selected && (
          <label className="inline">
            <input
              checked={attach}
              onChange={(event) => setAttach(event.target.checked)}
              type="checkbox"
            />
            {`Attach to ${objectLabel(selected)}`}
          </label>
        )}
        <Button type="submit">Add comment</Button>
      </form>
      <label className="inline">
        <input
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
          type="checkbox"
        />
        Show resolved
      </label>
      {error && <p role="alert">{error}</p>}
      <ul aria-label="Comment threads" className="history-list">
        {threads.map((thread) => {
          const mine = thread.author.id === currentUserId;
          return (
            <li className={`comment-thread${thread.resolvedAt ? " resolved" : ""}`} key={thread.id}>
              <CommentBody comment={thread} location={anchorLabel(thread)} />
              {thread.anchor && (
                <Button
                  onClick={() => {
                    const anchor = thread.anchor;
                    if (!anchor) return;
                    session.getState().setActiveArtboard(anchor.artboardId);
                    if (
                      anchor.objectId &&
                      state.document.objects.some((object) => object.id === anchor.objectId)
                    )
                      session.getState().select([anchor.objectId]);
                  }}
                >
                  Show
                </Button>
              )}
              {(mine || canResolve) && (
                <Button
                  onClick={() =>
                    void run(() =>
                      client.updateComment(projectId, thread.id, { resolved: !thread.resolvedAt }),
                    )
                  }
                >
                  {thread.resolvedAt ? "Reopen" : "Resolve"}
                </Button>
              )}
              {(mine || canModerate) && (
                <Button
                  aria-label="Delete comment"
                  onClick={() => {
                    if (window.confirm("Delete this comment and its replies?"))
                      void run(() => client.deleteComment(projectId, thread.id));
                  }}
                >
                  Delete
                </Button>
              )}
              <Button onClick={() => setReplyTo(replyTo === thread.id ? undefined : thread.id)}>
                Reply
              </Button>
              {repliesTo(thread.id).map((entry) => (
                <div className="comment-reply" key={entry.id}>
                  <CommentBody comment={entry} />
                  {(entry.author.id === currentUserId || canModerate) && (
                    <Button
                      aria-label="Delete reply"
                      onClick={() => void run(() => client.deleteComment(projectId, entry.id))}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              ))}
              {replyTo === thread.id && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const text = reply.trim();
                    if (!text) return;
                    void run(async () => {
                      await client.createComment(projectId, { body: text, parentId: thread.id });
                      setReply("");
                      setReplyTo(undefined);
                    });
                  }}
                >
                  <label>
                    Reply
                    <input
                      maxLength={4000}
                      onChange={(event) => setReply(event.target.value)}
                      value={reply}
                    />
                  </label>
                  <Button type="submit">Send reply</Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CommentBody({ comment, location }: { comment: CommentDto; location?: string }) {
  return (
    <p>
      <strong>{comment.author.email}</strong>{" "}
      <small>
        {new Date(comment.createdAt).toLocaleString()}
        {location ? ` · ${location}` : ""}
        {comment.resolvedAt ? ` · resolved by ${comment.resolvedBy?.email ?? "someone"}` : ""}
      </small>
      <br />
      {comment.body}
    </p>
  );
}

/** Saves the current figure, without images, as a template of the project's workspace. */
export function TemplatePanel({
  client,
  project,
  saveExact,
}: {
  client: FigLabClient;
  project: Project;
  saveExact: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  return (
    <section aria-label="Template" className="figure-tools-panel">
      <h3>Template</h3>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const templateName = name.trim();
          if (!templateName) return;
          setStatus("Saving the layout…");
          try {
            if (!(await saveExact())) {
              setStatus("Save the project first; your local work is kept.");
              return;
            }
            await client.createTemplate(project.workspaceId, templateName, project.id);
            await queryClient.invalidateQueries({ queryKey: ["templates", project.workspaceId] });
            setName("");
            setStatus(`Template “${templateName}” saved without images.`);
          } catch (failure) {
            setStatus(failure instanceof Error ? failure.message : "The template was not saved.");
          }
        }}
      >
        <label>
          Template name
          <input maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
        </label>
        <Button type="submit">Save as template</Button>
      </form>
      {status && <p role="status">{status}</p>}
    </section>
  );
}
