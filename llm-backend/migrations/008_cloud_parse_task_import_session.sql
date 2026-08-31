-- Persist the canonical cross-device import diagnostic session id for cloud parse tasks.
-- Legacy tasks remain readable with an empty value; new writes never emit parseSessionId.
ALTER TABLE cloud_parse_tasks
  ADD COLUMN IF NOT EXISTS import_session_id TEXT NOT NULL DEFAULT '';
