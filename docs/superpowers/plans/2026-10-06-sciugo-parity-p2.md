# Sciugo parity — P2 plan (labs, collaboration, quantification, scale)

Scope comes from the audit (§7, §3 screener, §4 large images) and decisions D1–D6.

1. **Densitometry and sample info** (done): raw-sample lane densities, loading-control
   normalization, screener warnings, CSV; `sampleInfo` on image panels feeds reports and legends.
2. **Lab workspaces** (migration `0005_lab_workspaces.sql`):
   - `workspaces.kind` (`personal` | `lab`), `created_by`; member roles `owner`, `admin`,
     `editor`, `viewer` (checked).
   - `workspace_invites`: SHA-256 of a random token, role, optional email, expiry, single use,
     revocable. The admin copies the link (D2: no SMTP).
   - `Principal.workspaceId` stays the personal workspace; `/v1/projects` keeps resolving to it.
     Lab routes name the workspace: `/v1/workspaces/:workspaceId/...`.
   - `MembershipAuthorizer`: non-members get 404; members below the needed role get 403.
     Read (viewer): documents, assets, history, exports, integrity, comments. Write (editor):
     saves, uploads, rename, move, templates. Manage (admin): members, invites, delete projects,
     delete templates. Owners alone change or remove owners; the last owner cannot leave.
   - Templates: documents with image panels, their attached annotations, and sources stripped;
     new projects can start from one.
3. **Folders, search, comments, admin**: folder tree per workspace (rename, move, archive),
   `projects.folder_id` and `projects.created_by`; search by project name across the caller's
   workspaces and by asset filename; anchored comment threads (artboard, object, point) with
   resolve; `/v1/admin/*` read-only overview, users, workspaces with storage, failed jobs.
4. **Preview pyramid**: a job writes derived, downsampled previews for large originals, marked
   derived and never used by export.

Every new table has RLS enabled with no policies. Migrations are applied to Supabase only after
the user approves.
