-- 文件说明：为 parse_sessions 增加 issue 关联字段，确保同一用户同一提交会话的多次失败上报能自动归并到同一个 Repair Issue。

ALTER TABLE parse_sessions
ADD COLUMN IF NOT EXISTS issue_id TEXT;

CREATE INDEX IF NOT EXISTS idx_parse_sessions_issue_id ON parse_sessions(issue_id);
