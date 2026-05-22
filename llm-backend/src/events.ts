import { query } from "./db.js";
import { RepairStage } from "./types.js";

export async function addIssueEvent(input: {
  issueId: string;
  jobId?: string;
  stage: RepairStage | string;
  level?: "debug" | "info" | "warning" | "error";
  message: string;
  actor?: string;
  source?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO repair_issue_events(issue_id, job_id, stage, level, message, actor, source, duration_ms, meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      input.issueId,
      input.jobId || null,
      input.stage,
      input.level || "info",
      input.message,
      input.actor || "system",
      input.source || "repair-orchestrator",
      input.durationMs || null,
      JSON.stringify(input.meta || {})
    ]
  );
}

export async function setIssueStage(issueId: string, stage: RepairStage | string, result?: string, error?: string): Promise<void> {
  await query(
    `UPDATE repair_issues
     SET current_stage = $2, last_result = COALESCE($3, last_result), last_error = COALESCE($4, last_error),
         updated_at = now(), last_seen_at = now()
     WHERE issue_id = $1`,
    [issueId, stage, result || null, error || null]
  );
}
