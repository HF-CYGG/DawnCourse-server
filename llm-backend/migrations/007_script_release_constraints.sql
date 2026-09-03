-- 修复 V2 作用域发布的唯一键，并补齐验证报告与系统维度聚合键。

ALTER TABLE script_artifacts
  DROP CONSTRAINT IF EXISTS script_artifacts_script_id_version_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_script_artifacts_track_version
  ON script_artifacts(script_key, version);

CREATE UNIQUE INDEX IF NOT EXISTS uq_script_artifacts_release_id
  ON script_artifacts(release_id);

ALTER TABLE script_releases
  ADD COLUMN IF NOT EXISTS validation_report_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE script_activation_metrics
  DROP CONSTRAINT IF EXISTS script_activation_metrics_pkey;

ALTER TABLE script_activation_metrics
  ADD CONSTRAINT script_activation_metrics_pkey
  PRIMARY KEY(metric_date, release_id, school_id, school_system_type, event_type, error_code);
