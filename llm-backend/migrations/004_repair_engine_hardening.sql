-- Repair engine hardening: persist classification evidence and enforce authorized sample de-duplication.

ALTER TABLE parse_sessions
ADD COLUMN IF NOT EXISTS failure_stage TEXT,
ADD COLUMN IF NOT EXISTS target_type TEXT,
ADD COLUMN IF NOT EXISTS source_url TEXT,
ADD COLUMN IF NOT EXISTS classification_hint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;

ALTER TABLE repair_issues
ADD COLUMN IF NOT EXISTS classification_confidence REAL,
ADD COLUMN IF NOT EXISTS classification_evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_failure_samples_issue_content
ON failure_samples(issue_id, content_sha256)
WHERE has_user_consent = true
  AND COALESCE(content_sha256, '') <> ''
  AND COALESCE(sanitized_content, '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_failure_samples_session_content
ON failure_samples(parse_session_id, content_sha256)
WHERE has_user_consent = true
  AND COALESCE(parse_session_id, '') <> ''
  AND COALESCE(content_sha256, '') <> ''
  AND COALESCE(sanitized_content, '') <> '';

CREATE INDEX IF NOT EXISTS idx_script_releases_scope
ON script_releases(script_id, release_stage, status, kill_switch);
