import fs from "node:fs";
import path from "node:path";
import { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { log } from "./log.js";
import { getManifestPublicBaseUrl } from "./runtimeConfig.js";
import { ReleaseStage } from "./types.js";
import { hostFromUrl, id, parserForSystem, safeSegment, scriptId, sha256, signContent, stableJson } from "./utils.js";

interface ReleaseRow {
  release_id: string;
  script_id: string;
  target_type: string;
  category: string;
  name: string;
  version: number;
  release_stage: ReleaseStage;
  channel: string;
  status: string;
  rollout_percent: number;
  kill_switch: boolean;
  min_app_version_code: string;
  max_app_version_code: string | null;
  school_system_types_json: unknown;
  school_ids_json: unknown;
  changelog: string | null;
  content_sha256: string;
  signature: string;
  alg: string;
}

export async function seedBundledScripts(): Promise<void> {
  const candidates: Array<{ category: string; file: string; targetType: string }> = [];
  for (const dir of config.legacyScriptDirs) {
    const category = dir.endsWith("/js") || dir.endsWith("\\js") ? "js" : "parsers";
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".js"))) {
      candidates.push({ category, file: path.join(dir, name), targetType: category === "parsers" ? "parser" : inferJsTarget(name) });
    }
  }
  for (const candidate of candidates) {
    const name = path.basename(candidate.file);
    const sid = scriptId(candidate.category, name);
    const exists = await query("SELECT 1 FROM script_releases WHERE script_id = $1 AND release_stage = 'active' LIMIT 1", [sid]);
    if (exists.rowCount) continue;
    const content = fs.readFileSync(candidate.file, "utf8");
    const hash = sha256(content);
    const signature = signContent(content);
    const releaseId = id("rel");
    await query(
      `INSERT INTO script_artifacts(script_id,target_type,category,name,version,release_id,content,content_sha256,signature,provenance,created_by)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9::jsonb,'seed')`,
      [sid, candidate.targetType, candidate.category, name, releaseId, content, hash, signature, JSON.stringify({ source: "bundled" })]
    );
    await query(
      `INSERT INTO script_releases(release_id,script_id,target_type,category,name,version,release_stage,channel,status,rollout_percent,school_system_types_json,school_ids_json,changelog,published_at,approved_by,approved_at)
       VALUES ($1,$2,$3,$4,$5,1,'active','stable','enabled',100,$6::jsonb,'[]'::jsonb,'bundled baseline',now(),'system',now())`,
      [releaseId, sid, candidate.targetType, candidate.category, name, JSON.stringify(systemTypesForScript(name))]
    );
    log.info("seeded bundled script", { sid, name, releaseId });
  }
}

export async function getActiveScriptContent(category: string, name: string): Promise<{ content: string; releaseId: string; version: number } | null> {
  const row = await query<{ content: string; release_id: string; version: number }>(
    `SELECT a.content, r.release_id, r.version
     FROM script_releases r
     JOIN script_artifacts a ON a.script_id = r.script_id AND a.version = r.version
     WHERE r.category = $1 AND r.name = $2 AND r.release_stage IN ('active','canary')
       AND r.status = 'enabled' AND r.kill_switch = false
     ORDER BY CASE WHEN r.release_stage = 'active' THEN 2 ELSE 1 END DESC, r.version DESC
     LIMIT 1`,
    [category, name]
  );
  const found = row.rows[0];
  return found ? { content: found.content, releaseId: found.release_id, version: found.version } : null;
}

export async function createPendingRelease(input: {
  issueId: string;
  scriptId: string;
  targetType: string;
  category: string;
  name: string;
  content: string;
  parentReleaseId?: string;
  changelog: string;
  testReportId?: string;
  actor?: string;
}): Promise<string> {
  const latest = await query<{ version: number }>("SELECT COALESCE(MAX(version),0) AS version FROM script_artifacts WHERE script_id = $1", [
    input.scriptId
  ]);
  const nextVersion = Number(latest.rows[0]?.version || 0) + 1;
  const releaseId = id("rel");
  const hash = sha256(input.content);
  const signature = signContent(input.content);
  await query(
    `INSERT INTO script_artifacts(script_id,target_type,category,name,version,release_id,content,content_sha256,signature,parent_release_id,test_report_id,provenance,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
    [
      input.scriptId,
      input.targetType,
      input.category,
      input.name,
      nextVersion,
      releaseId,
      input.content,
      hash,
      signature,
      input.parentReleaseId || null,
      input.testReportId || null,
      JSON.stringify({ issueId: input.issueId, generatedBy: "repair-orchestrator" }),
      input.actor || "system"
    ]
  );
  await query(
    `INSERT INTO script_releases(release_id,script_id,target_type,category,name,version,release_stage,channel,status,rollout_percent,school_system_types_json,school_ids_json,changelog,parent_release_id,issue_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pending','pending','enabled',0,$7::jsonb,'[]'::jsonb,$8,$9,$10)`,
    [
      releaseId,
      input.scriptId,
      input.targetType,
      input.category,
      input.name,
      nextVersion,
      JSON.stringify(systemTypesForScript(input.name)),
      input.changelog,
      input.parentReleaseId || null,
      input.issueId
    ]
  );
  await addIssueEvent({ issueId: input.issueId, stage: "PENDING_REVIEW", message: `候选脚本已进入 pending：${input.name} v${nextVersion}`, meta: { releaseId } });
  await setIssueStage(input.issueId, "PENDING_REVIEW", "pending release created");
  return releaseId;
}

export async function registerRegistryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/scripts/:category/:name", async (request, reply) => {
    const params = request.params as { category: string; name: string };
    const category = safeSegment(params.category);
    const name = safeSegment(params.name);
    if (!category || !name) return reply.code(400).send("invalid script path");
    const meta = name.endsWith(".meta.json");
    if (meta) {
      const scriptName = name.replace(/\.meta\.json$/, ".js");
      const active = await getReleaseForServing(category, scriptName);
      if (!active) return reply.code(404).send("not found");
      return reply.send({
        sha256: active.content_sha256,
        signature: active.signature,
        alg: active.alg || "rsa-sha256",
        version: active.version,
        releaseId: active.release_id
      });
    }
    const active = await getReleaseForServing(category, name);
    if (!active) return reply.code(404).send("not found");
    reply.type("application/javascript; charset=utf-8").send(active.content);
  });

  app.get("/api/v1/scripts/manifest", async (request) => {
    const queryParams = request.query as Record<string, string | undefined>;
    const systemType = String(queryParams.schoolSystemType || "");
    const appVersionCode = Number(queryParams.appVersionCode || 0);
    const rows = await selectManifestReleases(systemType, queryParams.schoolId || "", appVersionCode, queryParams.installBucketIdHash || "");
    const base = await getManifestPublicBaseUrl(request.headers.host);
    const scripts = rows.map((row) => ({
      scriptId: row.script_id,
      targetType: row.target_type,
      category: row.category,
      name: row.name,
      version: Number(row.version || 0),
      releaseId: row.release_id,
      releaseStage: row.release_stage,
      channel: row.channel,
      url: `${base}/scripts/${row.category}/${row.name}`,
      metaUrl: `${base}/scripts/${row.category}/${row.name.replace(/\.js$/i, ".meta.json")}`,
      sha256: row.content_sha256,
      signature: row.signature,
      alg: row.alg || "rsa-sha256",
      priority: priorityFor(row, systemType),
      schoolSystemTypes: row.school_system_types_json || [],
      schoolIds: row.school_ids_json || [],
      rolloutPercent: Number(row.rollout_percent || 0),
      killSwitch: row.kill_switch,
      minAppVersionCode: Number(row.min_app_version_code || 0),
      maxAppVersionCode: row.max_app_version_code ? Number(row.max_app_version_code) : null,
      parserApiVersion: 1,
      runnerContractVersion: 1,
      schoolBindingId: null,
      selectionPolicy: "auto",
      dependencies: row.category === "parsers" && row.name !== "common_parser_utils.js" ? [{ category: "parsers", name: "common_parser_utils.js", version: 1 }] : [],
      changelog: row.changelog || ""
    }));
    const manifestPayload = {
      manifestVersion: Date.now(),
      generatedAt: Date.now(),
      minClientVersionCode: 0,
      scripts
    };
    return { ...manifestPayload, alg: "rsa-sha256", signature: signContent(stableJson(manifestPayload)) };
  });

  app.get("/api/v1/scripts/options", async (request) => {
    const queryParams = request.query as Record<string, string | undefined>;
    const rows = await query(
      `SELECT binding_id, school_id, school_name, school_system_type, script_id, release_id, selection_policy, priority, enabled
       FROM school_script_bindings
       WHERE enabled = true AND ($1 = '' OR school_id = $1 OR school_system_type = $2)
       ORDER BY priority DESC, updated_at DESC LIMIT 50`,
      [queryParams.schoolId || "", queryParams.schoolSystemType || ""]
    );
    return apiOk({ list: rows.rows });
  });

  app.post("/api/v1/scripts/selection", async (request) => {
    const body = (request.body || {}) as Record<string, string>;
    await query(
      `INSERT INTO app_script_selections(install_bucket_id_hash, school_id, school_system_type, selection_policy, preferred_release_id, preferred_script_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (install_bucket_id_hash, school_id, school_system_type)
       DO UPDATE SET selection_policy = EXCLUDED.selection_policy, preferred_release_id = EXCLUDED.preferred_release_id,
         preferred_script_id = EXCLUDED.preferred_script_id, updated_at = now()`,
      [body.installBucketIdHash || "unknown", body.schoolId || "", body.schoolSystemType || "", body.selectionPolicy || "auto", body.preferredReleaseId || null, body.preferredScriptId || null]
    );
    return apiOk({ saved: true });
  });
}

async function getReleaseForServing(category: string, name: string): Promise<(ReleaseRow & { content: string }) | null> {
  const result = await query<ReleaseRow & { content: string }>(
    `SELECT r.*, a.content, a.content_sha256, a.signature, a.alg
     FROM script_releases r
     JOIN script_artifacts a ON a.script_id = r.script_id AND a.version = r.version
     WHERE r.category = $1 AND r.name = $2 AND r.release_stage IN ('active','canary')
       AND r.status = 'enabled' AND r.kill_switch = false
     ORDER BY CASE WHEN r.release_stage = 'active' THEN 2 ELSE 1 END DESC, r.version DESC
     LIMIT 1`,
    [category, name]
  );
  return result.rows[0] || null;
}

async function selectManifestReleases(systemType: string, schoolId: string, appVersionCode: number, bucket: string): Promise<ReleaseRow[]> {
  const rows = await query<ReleaseRow>(
    `SELECT r.*, a.content_sha256, a.signature, a.alg
     FROM script_releases r
     JOIN script_artifacts a ON a.script_id = r.script_id AND a.version = r.version
     WHERE r.release_stage IN ('active','canary') AND r.status = 'enabled' AND r.kill_switch = false
       AND r.min_app_version_code <= $1
       AND (r.max_app_version_code IS NULL OR r.max_app_version_code >= $1)
     ORDER BY r.category, r.name, CASE WHEN r.release_stage = 'active' THEN 2 ELSE 1 END DESC, r.version DESC`,
    [appVersionCode]
  );
  const seen = new Set<string>();
  return rows.rows.filter((row) => {
    const key = `${row.category}/${row.name}`;
    if (seen.has(key)) return false;
    if (!releaseTargetsMatch(row, systemType, schoolId)) return false;
    if (!rolloutHit(row, bucket || "anonymous")) return false;
    seen.add(key);
    return true;
  });
}

function releaseTargetsMatch(row: ReleaseRow, systemType: string, schoolId: string): boolean {
  const systems = Array.isArray(row.school_system_types_json) ? row.school_system_types_json.map(String) : [];
  const schools = Array.isArray(row.school_ids_json) ? row.school_ids_json.map(String) : [];
  return (!systems.length || systems.includes(systemType) || systemType === "") && (!schools.length || schools.includes(schoolId) || schoolId === "");
}

function rolloutHit(row: ReleaseRow, bucket: string): boolean {
  const percent = Number(row.rollout_percent || 0);
  if (row.release_stage === "active" || percent >= 100) return true;
  if (percent <= 0) return false;
  const value = Number.parseInt(sha256(`${bucket}:${row.script_id}:${row.release_id}`).slice(0, 8), 16) % 100;
  return value < percent;
}

function priorityFor(row: ReleaseRow, systemType: string): number {
  const parser = parserForSystem(systemType);
  if (row.name === parser) return 100;
  if (row.category === "parsers") return 50;
  return 10;
}

function inferJsTarget(name: string): string {
  if (name.includes("nav") || name.includes("menu")) return "navigation";
  if (name.includes("extractor") || name.includes("page_state") || name.includes("term")) return "term_extractor";
  return "navigation";
}

function systemTypesForScript(name: string): string[] {
  if (name.includes("qiangzhi") || name.includes("qz_")) return ["QIANGZHI"];
  if (name.includes("kingosoft")) return ["KINGOSOFT"];
  if (name.includes("qidi")) return ["QIDI"];
  if (name.includes("zhengfang") || name.includes("zf_")) return ["ZF"];
  return [];
}

function apiOk(data: unknown): { code: number; msg: string; data: unknown } {
  return { code: 200, msg: "ok", data };
}
