import { query, withTx } from "./db.js";

type QueryLike = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;
type TransactionClientLike = { query: QueryLike };
type WithTransactionLike = <T>(callback: (client: TransactionClientLike) => Promise<T>) => Promise<T>;

/** 发布服务可替换的数据库依赖。 */
export interface ScriptReleaseAdminDependencies {
  query?: QueryLike;
  withTx?: WithTransactionLike;
}

/** 发布操作完成后返回给路由层的必要上下文。 */
export interface ScriptReleaseAdminResult {
  releaseId: string;
  scriptKey: string;
  issueId: string;
  parentReleaseId: string;
  releaseStage: string;
  rolloutPercent: number;
}

/** 将已验证候选发布到灰度或全量，只处理同一 scriptKey。 */
export async function publishScriptRelease(
  releaseId: string,
  stage: string,
  rolloutPercent: number,
  actor: string,
  deps: ScriptReleaseAdminDependencies = {}
): Promise<ScriptReleaseAdminResult> {
  const queryFn = (deps.query || query) as QueryLike;
  const withTxFn = (deps.withTx || withTx) as WithTransactionLike;
  const normalizedStage = stage === "active" ? "active" : stage === "canary" ? "canary" : "";
  if (!normalizedStage) throw new Error("invalid_release_stage");
  const normalizedPercent = normalizedStage === "active" ? 100 : Number(rolloutPercent);
  if (normalizedStage === "canary" && (!Number.isInteger(normalizedPercent) || normalizedPercent < 1 || normalizedPercent > 99)) {
    throw new Error("invalid_rollout_percent");
  }
  const releaseResult = await queryFn<any>(
    `SELECT release_id, script_key, parent_release_id, issue_id, validation_status
     FROM script_releases WHERE release_id = $1 LIMIT 1`,
    [releaseId]
  );
  const release = releaseResult.rows[0];
  if (!release) throw new Error("release_not_found");
  if (String(release.validation_status || "") !== "passed") throw new Error("release_not_validated");
  const scriptKey = String(release.script_key || "");
  if (!scriptKey) throw new Error("release_scope_missing");

  await withTxFn(async (client) => {
    if (normalizedStage === "active") {
      await client.query(
        `UPDATE script_releases
         SET release_stage = 'rolled_back', channel = 'rolled_back', rollout_percent = 0
         WHERE script_key = $1 AND release_stage IN ('active','canary') AND release_id <> $2`,
        [scriptKey, releaseId]
      );
    } else {
      await client.query(
        `UPDATE script_releases
         SET release_stage = 'rolled_back', channel = 'rolled_back', rollout_percent = 0
         WHERE script_key = $1 AND release_stage = 'canary' AND release_id <> $2`,
        [scriptKey, releaseId]
      );
    }
    await client.query(
      `UPDATE script_releases
       SET release_stage = $2,
           channel = CASE WHEN $2 = 'active' THEN 'stable' ELSE 'canary' END,
           rollout_percent = $3,
           status = 'enabled',
           kill_switch = false,
           approved_by = $4,
           approved_at = now(),
           published_at = now()
       WHERE release_id = $1`,
      [releaseId, normalizedStage, normalizedPercent, actor]
    );
    await client.query(
      "INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,'publish_release','script_release',$2,$3::jsonb)",
      [actor, releaseId, JSON.stringify({ stage: normalizedStage, rolloutPercent: normalizedPercent, scriptKey })]
    );
  });
  return {
    releaseId,
    scriptKey,
    issueId: String(release.issue_id || ""),
    parentReleaseId: String(release.parent_release_id || ""),
    releaseStage: normalizedStage,
    rolloutPercent: normalizedPercent
  };
}

/** 回滚指定 release，并且只恢复同一 scriptKey 的父版本。 */
export async function rollbackScriptRelease(
  releaseId: string,
  actor: string,
  deps: ScriptReleaseAdminDependencies = {}
): Promise<ScriptReleaseAdminResult> {
  const queryFn = (deps.query || query) as QueryLike;
  const withTxFn = (deps.withTx || withTx) as WithTransactionLike;
  const releaseResult = await queryFn<any>(
    `SELECT release_id, script_key, parent_release_id, issue_id
     FROM script_releases WHERE release_id = $1 LIMIT 1`,
    [releaseId]
  );
  const release = releaseResult.rows[0];
  if (!release) throw new Error("release_not_found");
  const scriptKey = String(release.script_key || "");
  const parentReleaseId = String(release.parent_release_id || "");
  if (!scriptKey) throw new Error("release_scope_missing");

  await withTxFn(async (client) => {
    let parent: any = null;
    if (parentReleaseId) {
      const parentResult = await client.query<any>(
        `SELECT release_id, script_key FROM script_releases /* parent_release */
         WHERE release_id = $1 AND script_key = $2 LIMIT 1`,
        [parentReleaseId, scriptKey]
      );
      parent = parentResult.rows[0] || null;
      if (!parent) throw new Error("rollback_parent_scope_mismatch");
    }
    await client.query(
      "UPDATE script_releases SET release_stage = 'rolled_back', channel = 'rolled_back', rollout_percent = 0 WHERE release_id = $1",
      [releaseId]
    );
    if (parent) {
      await client.query(
        `UPDATE script_releases
         SET release_stage = 'rolled_back', channel = 'rolled_back', rollout_percent = 0
         WHERE script_key = $1 AND release_stage IN ('active','canary') AND release_id <> $2`,
        [scriptKey, parentReleaseId]
      );
      await client.query(
        "UPDATE script_releases SET release_stage = 'active', channel = 'stable', rollout_percent = 100, status = 'enabled', kill_switch = false WHERE release_id = $1",
        [parentReleaseId]
      );
    }
    await client.query(
      "INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,'rollback_release','script_release',$2,$3::jsonb)",
      [actor, releaseId, JSON.stringify({ parentReleaseId, scriptKey })]
    );
  });
  return {
    releaseId,
    scriptKey,
    issueId: String(release.issue_id || ""),
    parentReleaseId,
    releaseStage: "rolled_back",
    rolloutPercent: 0
  };
}

/** 立即停用指定 release 并打开 kill switch。 */
export async function disableScriptRelease(
  releaseId: string,
  reason: string,
  actor: string,
  deps: ScriptReleaseAdminDependencies = {}
): Promise<ScriptReleaseAdminResult> {
  const queryFn = (deps.query || query) as QueryLike;
  const withTxFn = (deps.withTx || withTx) as WithTransactionLike;
  const releaseResult = await queryFn<any>(
    `SELECT release_id, script_key, parent_release_id, issue_id
     FROM script_releases WHERE release_id = $1 LIMIT 1`,
    [releaseId]
  );
  const release = releaseResult.rows[0];
  if (!release) throw new Error("release_not_found");
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error("disable_reason_required");
  await withTxFn(async (client) => {
    await client.query(
      "UPDATE script_releases SET release_stage = 'disabled', channel = 'disabled', rollout_percent = 0, status = 'disabled', kill_switch = true WHERE release_id = $1",
      [releaseId]
    );
    await client.query(
      "INSERT INTO audit_logs(actor, action, target_type, target_id, detail_json) VALUES ($1,'disable_release','script_release',$2,$3::jsonb)",
      [actor, releaseId, JSON.stringify({ reason: normalizedReason, scriptKey: release.script_key || "" })]
    );
  });
  return {
    releaseId,
    scriptKey: String(release.script_key || ""),
    issueId: String(release.issue_id || ""),
    parentReleaseId: String(release.parent_release_id || ""),
    releaseStage: "disabled",
    rolloutPercent: 0
  };
}
