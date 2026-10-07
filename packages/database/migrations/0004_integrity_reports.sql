-- Additive and backward compatible: the previous deploy never touches this table.

-- Integrity reports computed by the integrity_report job from original pixels. Reports outlive
-- a deleted project's content, like its audit trail.
CREATE TABLE IF NOT EXISTS public.integrity_reports (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.projects(id),
  revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  report jsonb,
  error text,
  requested_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS integrity_reports_project_created_idx
  ON public.integrity_reports(project_id, created_at DESC);
ALTER TABLE public.integrity_reports ENABLE ROW LEVEL SECURITY;
