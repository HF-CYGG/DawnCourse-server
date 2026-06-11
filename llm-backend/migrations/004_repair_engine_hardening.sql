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

-- 旧版本可能已经写入了相同 issue/session 下的重复授权样本。
-- 先保留每组最早的一条可回放样本，其余重复记录降级为诊断记录，再创建唯一索引。
-- Keep the earliest replayable authorized sample in each duplicate group.
-- This prevents historical duplicate rows from blocking unique index creation.
WITH duplicate_samples AS (
  SELECT id
  FROM (
    SELECT
      id,
      CASE
        WHEN COALESCE(issue_id, '') <> '' THEN row_number() OVER (
          PARTITION BY issue_id, content_sha256
          ORDER BY created_at ASC, id ASC
        )
        ELSE 1
      END AS issue_rank,
      CASE
        WHEN COALESCE(parse_session_id, '') <> '' THEN row_number() OVER (
          PARTITION BY parse_session_id, content_sha256
          ORDER BY created_at ASC, id ASC
        )
        ELSE 1
      END AS session_rank
    FROM failure_samples
    WHERE has_user_consent = true
      AND COALESCE(content_sha256, '') <> ''
      AND COALESCE(sanitized_content, '') <> ''
      AND (
        COALESCE(issue_id, '') <> ''
        OR COALESCE(parse_session_id, '') <> ''
      )
  ) ranked
  WHERE issue_rank > 1 OR session_rank > 1
),
normalized AS (
  UPDATE failure_samples fs
  SET
    has_user_consent = false,
    sanitized_content = NULL,
    page_fingerprint_json = fs.page_fingerprint_json || jsonb_build_object(
      'deduplicatedByMigration', '004_repair_engine_hardening',
      'deduplicatedAt', now()
    )
  WHERE fs.id IN (SELECT id FROM duplicate_samples)
  RETURNING fs.id, fs.issue_id
),
recounted AS (
  UPDATE repair_issues ri
  SET
    sample_count = (
      SELECT COUNT(*)::int
      FROM failure_samples fs
      WHERE fs.issue_id = ri.issue_id
        AND fs.has_user_consent = true
        AND COALESCE(fs.sanitized_content, '') <> ''
    ),
    user_count = GREATEST(
      1,
      (
        SELECT COUNT(DISTINCT COALESCE(NULLIF(ps.install_bucket_id_hash, ''), fs.parse_session_id))::int
        FROM failure_samples fs
        LEFT JOIN parse_sessions ps ON ps.parse_session_id = fs.parse_session_id
        WHERE fs.issue_id = ri.issue_id
      )
    ),
    updated_at = now()
  WHERE ri.issue_id IN (
    SELECT DISTINCT issue_id
    FROM normalized
    WHERE COALESCE(issue_id, '') <> ''
  )
  RETURNING ri.issue_id
)
INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json)
SELECT
  'migration',
  'failure_sample_deduplicated',
  'repair_issue',
  COALESCE(issue_id, 'unknown'),
  jsonb_build_object('migration', '004_repair_engine_hardening', 'deduplicatedSamples', COUNT(*))
FROM normalized
GROUP BY COALESCE(issue_id, 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS uq_failure_samples_issue_content
ON failure_samples(issue_id, content_sha256)
WHERE has_user_consent = true
  AND COALESCE(issue_id, '') <> ''
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
