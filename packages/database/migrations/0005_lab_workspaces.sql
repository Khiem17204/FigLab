-- Lab workspaces, invite links, folders, templates, and comments. Additive only: existing
-- personal workspaces become kind 'personal' and keep their single 'owner' membership; the
-- previous deploy never reads the new columns or tables.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';
ALTER TABLE public.workspaces ADD CONSTRAINT workspaces_kind_check CHECK (kind IN ('personal','lab'));
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id);
ALTER TABLE public.workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner','admin','editor','viewer'));
CREATE INDEX IF NOT EXISTS workspace_members_workspace ON public.workspace_members(workspace_id);

CREATE TABLE IF NOT EXISTS public.workspace_invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  token_sha256 text UNIQUE NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  email text,
  created_by uuid NOT NULL REFERENCES public.users(id),
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES public.users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_invites_workspace ON public.workspace_invites(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.folders (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  parent_id uuid REFERENCES public.folders(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  archived_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_workspace ON public.folders(workspace_id);

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.folders(id);
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id);
CREATE INDEX IF NOT EXISTS projects_workspace_folder ON public.projects(workspace_id, folder_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS projects_workspace_name ON public.projects(workspace_id, lower(name)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS assets_project_filename ON public.assets(project_id, lower(filename));

CREATE TABLE IF NOT EXISTS public.project_templates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  schema_version integer NOT NULL,
  document jsonb NOT NULL,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS project_templates_workspace ON public.project_templates(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.comments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  parent_id uuid REFERENCES public.comments(id),
  author_user_id uuid NOT NULL REFERENCES public.users(id),
  artboard_id text,
  object_id text,
  x_pt double precision,
  y_pt double precision,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_project ON public.comments(project_id, created_at);

ALTER TABLE public.workspace_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
