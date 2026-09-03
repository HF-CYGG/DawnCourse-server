-- 脚本发布 V2：显式作用域、不可变依赖与客户端聚合激活指标。

ALTER TABLE script_artifacts ADD COLUMN IF NOT EXISTS script_key TEXT;

ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS script_key TEXT;
ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS scope_kind TEXT;
ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT '';
ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS school_system_type TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed';
ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS parser_api_version INT NOT NULL DEFAULT 1;
ALTER TABLE script_releases ADD COLUMN IF NOT EXISTS runner_contract_version INT NOT NULL DEFAULT 1;

UPDATE script_releases
SET scope_kind = CASE
      WHEN category = 'runtime' THEN 'global'
      WHEN jsonb_array_length(school_ids_json) > 0 THEN 'school'
      WHEN jsonb_array_length(school_system_types_json) > 0 THEN 'system'
      ELSE 'global'
    END,
    scope_id = CASE
      WHEN category = 'runtime' THEN ''
      WHEN jsonb_array_length(school_ids_json) > 0 THEN school_ids_json->>0
      WHEN jsonb_array_length(school_system_types_json) > 0 THEN school_system_types_json->>0
      ELSE ''
    END,
    school_system_type = CASE
      WHEN jsonb_array_length(school_system_types_json) > 0 THEN school_system_types_json->>0
      ELSE 'UNKNOWN'
    END
WHERE scope_kind IS NULL;

UPDATE script_releases
SET script_key = target_type || '/' || category || '/' || name || '/' || scope_kind || '/' || scope_id
WHERE script_key IS NULL OR script_key = '';

UPDATE script_artifacts a
SET script_key = r.script_key
FROM script_releases r
WHERE r.release_id = a.release_id AND (a.script_key IS NULL OR a.script_key = '');

ALTER TABLE script_releases ALTER COLUMN scope_kind SET NOT NULL;
ALTER TABLE script_releases ALTER COLUMN script_key SET NOT NULL;
ALTER TABLE script_artifacts ALTER COLUMN script_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_script_releases_track_stage
  ON script_releases(script_key, release_stage, version DESC);
CREATE INDEX IF NOT EXISTS idx_script_artifacts_release
  ON script_artifacts(release_id);

CREATE TABLE IF NOT EXISTS script_release_dependencies (
  id BIGSERIAL PRIMARY KEY,
  release_id TEXT NOT NULL,
  dependency_release_id TEXT NOT NULL,
  load_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(release_id, dependency_release_id)
);

CREATE INDEX IF NOT EXISTS idx_script_release_dependencies_release
  ON script_release_dependencies(release_id, load_order);

INSERT INTO script_release_dependencies(release_id, dependency_release_id, load_order)
SELECT parser.release_id, dependency.release_id, 0
FROM script_releases parser
CROSS JOIN LATERAL (
  SELECT release_id
  FROM script_releases
  WHERE category = 'parsers'
    AND name = 'common_parser_utils.js'
    AND release_stage IN ('active', 'canary')
    AND status = 'enabled'
    AND kill_switch = false
  ORDER BY CASE WHEN release_stage = 'active' THEN 2 ELSE 1 END DESC, version DESC
  LIMIT 1
) dependency
WHERE parser.category = 'parsers'
  AND parser.name <> 'common_parser_utils.js'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS script_activation_metrics (
  metric_date DATE NOT NULL DEFAULT CURRENT_DATE,
  release_id TEXT NOT NULL,
  school_id TEXT NOT NULL DEFAULT '',
  school_system_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  event_type TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  event_count BIGINT NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(metric_date, release_id, school_id, event_type, error_code)
);

CREATE INDEX IF NOT EXISTS idx_script_activation_metrics_release
  ON script_activation_metrics(release_id, metric_date DESC);

CREATE TABLE IF NOT EXISTS script_manual_validations (
  validation_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  school_id TEXT NOT NULL DEFAULT '',
  page_stage TEXT NOT NULL,
  result_note TEXT NOT NULL,
  passed BOOLEAN NOT NULL DEFAULT false,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
