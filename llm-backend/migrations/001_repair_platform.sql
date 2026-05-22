CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parse_sessions (
  id BIGSERIAL PRIMARY KEY,
  parse_session_id TEXT UNIQUE NOT NULL,
  app_version_code BIGINT,
  app_version_name TEXT,
  install_bucket_id_hash TEXT,
  school_id TEXT,
  school_name TEXT,
  school_system_type TEXT,
  import_source TEXT,
  source_url_host TEXT,
  page_fingerprint_hash TEXT,
  repair_domain TEXT,
  final_success BOOLEAN NOT NULL DEFAULT false,
  final_failure_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parser_attempts (
  id BIGSERIAL PRIMARY KEY,
  parse_session_id TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'parsers',
  parser_version INT NOT NULL DEFAULT 0,
  release_id TEXT,
  script_source TEXT,
  script_sha256 TEXT,
  duration_ms INT,
  success BOOLEAN NOT NULL DEFAULT false,
  result_count INT,
  failure_type TEXT,
  safe_error_code TEXT,
  schema_valid BOOLEAN,
  confidence REAL,
  raw_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS failure_samples (
  id BIGSERIAL PRIMARY KEY,
  sample_id TEXT UNIQUE NOT NULL,
  parse_session_id TEXT,
  issue_id TEXT,
  has_user_consent BOOLEAN NOT NULL DEFAULT false,
  sanitizer_version INT,
  content_sha256 TEXT,
  sanitized_content TEXT,
  page_fingerprint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  school_id TEXT,
  school_name TEXT,
  school_system_type TEXT,
  source_url_host TEXT,
  repair_domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS repair_issues (
  id BIGSERIAL PRIMARY KEY,
  issue_id TEXT UNIQUE NOT NULL,
  issue_key TEXT UNIQUE NOT NULL,
  school_id TEXT,
  school_name TEXT,
  school_system_type TEXT,
  source_url_host TEXT,
  page_fingerprint_hash TEXT,
  repair_domain TEXT NOT NULL,
  target_type TEXT NOT NULL,
  affected_script_id TEXT,
  affected_script_name TEXT,
  affected_category TEXT,
  affected_version INT NOT NULL DEFAULT 0,
  failure_type TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  current_stage TEXT NOT NULL DEFAULT 'REPORTED',
  priority TEXT NOT NULL DEFAULT 'P2',
  sample_count INT NOT NULL DEFAULT 0,
  user_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  last_result TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repair_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL,
  issue_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  bypass_min_queue BOOLEAN NOT NULL DEFAULT false,
  actor TEXT NOT NULL DEFAULT 'system',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_summary TEXT,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repair_issue_events (
  id BIGSERIAL PRIMARY KEY,
  issue_id TEXT NOT NULL,
  job_id TEXT,
  stage TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  source TEXT NOT NULL DEFAULT 'repair-orchestrator',
  duration_ms INT,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS script_artifacts (
  id BIGSERIAL PRIMARY KEY,
  script_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL,
  release_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  alg TEXT NOT NULL DEFAULT 'rsa-sha256',
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  parent_release_id TEXT,
  test_report_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(script_id, version)
);

CREATE TABLE IF NOT EXISTS script_releases (
  id BIGSERIAL PRIMARY KEY,
  release_id TEXT UNIQUE NOT NULL,
  script_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL,
  release_stage TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enabled',
  rollout_percent INT NOT NULL DEFAULT 0,
  kill_switch BOOLEAN NOT NULL DEFAULT false,
  min_app_version_code BIGINT NOT NULL DEFAULT 0,
  max_app_version_code BIGINT,
  school_system_types_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  school_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  changelog TEXT,
  parent_release_id TEXT,
  issue_id TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS school_script_bindings (
  id BIGSERIAL PRIMARY KEY,
  binding_id TEXT UNIQUE NOT NULL,
  school_id TEXT,
  school_name TEXT,
  school_system_type TEXT,
  script_id TEXT NOT NULL,
  release_id TEXT,
  selection_policy TEXT NOT NULL DEFAULT 'auto',
  priority INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runner_reports (
  id BIGSERIAL PRIMARY KEY,
  report_id TEXT UNIQUE NOT NULL,
  issue_id TEXT,
  job_id TEXT,
  script_id TEXT,
  release_id TEXT,
  sample_id TEXT,
  target_type TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  schema_valid BOOLEAN NOT NULL DEFAULT false,
  result_count INT NOT NULL DEFAULT 0,
  duration_ms INT,
  error_code TEXT,
  error_message TEXT,
  report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_script_selections (
  id BIGSERIAL PRIMARY KEY,
  install_bucket_id_hash TEXT NOT NULL,
  school_id TEXT,
  school_system_type TEXT,
  selection_policy TEXT NOT NULL,
  preferred_release_id TEXT,
  preferred_script_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(install_bucket_id_hash, school_id, school_system_type)
);

CREATE INDEX IF NOT EXISTS idx_repair_issues_stage ON repair_issues(current_stage);
CREATE INDEX IF NOT EXISTS idx_repair_events_issue ON repair_issue_events(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failure_samples_issue ON failure_samples(issue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_script_releases_manifest ON script_releases(release_stage, status, category, name);
