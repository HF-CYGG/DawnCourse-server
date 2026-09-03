-- Persist cloud fallback parse task status and unmatched-school profiles.

CREATE TABLE IF NOT EXISTS cloud_parse_tasks (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  result_text TEXT,
  error_text TEXT,
  issue_id TEXT,
  school_id TEXT,
  school_name TEXT,
  school_system_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_profiles (
  id BIGSERIAL PRIMARY KEY,
  school_id TEXT UNIQUE NOT NULL,
  school_name TEXT NOT NULL DEFAULT '',
  normalized_name TEXT NOT NULL DEFAULT '',
  school_system_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  source_hosts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'reported',
  created_from_issue_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_parse_tasks_issue ON cloud_parse_tasks(issue_id);
CREATE INDEX IF NOT EXISTS idx_cloud_parse_tasks_status ON cloud_parse_tasks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_school_profiles_system ON school_profiles(school_system_type, normalized_name);
