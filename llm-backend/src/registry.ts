import fs from "node:fs";
import path from "node:path";
import { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { query } from "./db.js";
import { addIssueEvent, setIssueStage } from "./events.js";
import { log } from "./log.js";
import { getManifestPublicBaseUrl } from "./runtimeConfig.js";
import { buildImmutableBundlePayload, buildScriptKey, deriveReleaseScope, releaseScopeMatchesRequest } from "./scriptRelease.js";
import { ReleaseStage } from "./types.js";
import { hostFromUrl, id, normalizeSystemType, parserForSystem, safeSegment, scriptId, sha256, signContent, stableJson } from "./utils.js";

type RegistryQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount?: number | null }>;

/** Registry 路由测试可替换的外部依赖。 */
export interface RegistryRouteDependencies {
  query?: RegistryQuery;
  signContent?: (content: string) => string;
}

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
  script_key?: string | null;
  scope_kind?: "global" | "system" | "school" | null;
  scope_id?: string | null;
  school_system_type?: string | null;
  validation_status?: string | null;
  parser_api_version?: number | null;
  runner_contract_version?: number | null;
  school_binding_id?: string | null;
  selection_policy?: string | null;
}

interface AppScriptSelection {
  selection_policy: string;
  preferred_release_id: string | null;
  preferred_script_id: string | null;
}

interface SchoolScriptBinding {
  binding_id: string;
  release_id: string | null;
  script_id: string;
  selection_policy: string;
  priority: number;
}

export async function seedBundledScripts(): Promise<void> {
  const candidates: Array<{ category: string; file: string; targetType: string }> = [];
  for (const dir of config.legacyScriptDirs) {
    const category = categoryFromDir(dir);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith(".js"))) {
      candidates.push({ category, file: path.join(dir, name), targetType: targetTypeFor(category, name) });
    }
  }
  for (const candidate of candidates) {
    const name = path.basename(candidate.file);
    const sid = scriptId(candidate.category, name);
    const scope = deriveReleaseScope({
      targetType: candidate.targetType,
      category: candidate.category,
      name,
      schoolSystemTypes: systemTypesForScript(name),
      schoolIds: []
    });
    const key = buildScriptKey(scope);
    const exists = await query("SELECT 1 FROM script_releases WHERE script_key = $1 AND release_stage = 'active' LIMIT 1", [key]);
    if (exists.rowCount) continue;
    const content = fs.readFileSync(candidate.file, "utf8");
    const hash = sha256(content);
    const signature = signContent(content);
    const releaseId = id("rel");
    await query(
      `INSERT INTO script_artifacts(script_id,script_key,target_type,category,name,version,release_id,content,content_sha256,signature,provenance,created_by)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10::jsonb,'seed')`,
      [sid, key, candidate.targetType, candidate.category, name, releaseId, content, hash, signature, JSON.stringify({ source: "bundled" })]
    );
    await query(
      `INSERT INTO script_releases(release_id,script_id,script_key,target_type,category,name,version,release_stage,channel,status,rollout_percent,
         school_system_types_json,school_ids_json,scope_kind,scope_id,school_system_type,validation_status,changelog,published_at,approved_by,approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'active','stable','enabled',100,$7::jsonb,'[]'::jsonb,$8,$9,$10,'passed','bundled baseline',now(),'system',now())`,
      [releaseId, sid, key, candidate.targetType, candidate.category, name, JSON.stringify(systemTypesForScript(name)), scope.scopeKind, scope.scopeId, scope.schoolSystemType]
    );
    await snapshotDefaultParserDependency(releaseId, candidate.category, name);
    log.info("seeded bundled script", { sid, name, releaseId });
  }
}

export async function getActiveScriptContent(category: string, name: string): Promise<{ content: string; releaseId: string; version: number } | null> {
  const row = await query<{ content: string; release_id: string; version: number }>(
    `SELECT a.content, r.release_id, r.version
     FROM script_releases r
     JOIN script_artifacts a ON a.release_id = r.release_id
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
  schoolId?: string;
  schoolSystemType?: string;
}): Promise<string> {
  const legacyScope = buildScriptReleaseScope({
    name: input.name,
    schoolId: input.schoolId || "",
    schoolSystemType: input.schoolSystemType || ""
  });
  const scope = deriveReleaseScope({
    targetType: input.targetType,
    category: input.category,
    name: input.name,
    schoolSystemTypes: legacyScope.schoolSystemTypes,
    schoolIds: legacyScope.schoolIds
  });
  const key = buildScriptKey(scope);
  const latest = await query<{ version: number }>("SELECT COALESCE(MAX(version),0) AS version FROM script_artifacts WHERE script_key = $1", [key]);
  const nextVersion = Number(latest.rows[0]?.version || 0) + 1;
  const releaseId = id("rel");
  const hash = sha256(input.content);
  const signature = signContent(input.content);
  await query(
    `INSERT INTO script_artifacts(script_id,script_key,target_type,category,name,version,release_id,content,content_sha256,signature,parent_release_id,test_report_id,provenance,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
    [
      input.scriptId,
      key,
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
    `INSERT INTO script_releases(release_id,script_id,script_key,target_type,category,name,version,release_stage,channel,status,rollout_percent,
       school_system_types_json,school_ids_json,scope_kind,scope_id,school_system_type,validation_status,changelog,parent_release_id,issue_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','pending','enabled',0,$8::jsonb,$9::jsonb,$10,$11,$12,'passed',$13,$14,$15)`,
    [
      releaseId,
      input.scriptId,
      key,
      input.targetType,
      input.category,
      input.name,
      nextVersion,
      JSON.stringify(legacyScope.schoolSystemTypes),
      JSON.stringify(legacyScope.schoolIds),
      scope.scopeKind,
      scope.scopeId,
      scope.schoolSystemType,
      input.changelog,
      input.parentReleaseId || null,
      input.issueId
    ]
  );
  await snapshotDefaultParserDependency(releaseId, input.category, input.name);
  await addIssueEvent({ issueId: input.issueId, stage: "PENDING_REVIEW", message: `candidate pending: ${input.name} v${nextVersion}`, meta: { releaseId } });
  await setIssueStage(input.issueId, "PENDING_REVIEW", "pending release created");
  return releaseId;
}

/** 为解析器 release 固定当前通用工具依赖，避免后续依赖热更改变历史 bundle。 */
async function snapshotDefaultParserDependency(releaseId: string, category: string, name: string): Promise<void> {
  if (category !== "parsers" || name === "common_parser_utils.js") return;
  await query(
    `INSERT INTO script_release_dependencies(release_id, dependency_release_id, load_order)
     SELECT $1, release_id, 0
     FROM script_releases
     WHERE category = 'parsers' AND name = 'common_parser_utils.js'
       AND release_stage IN ('active','canary') AND status = 'enabled' AND kill_switch = false
     ORDER BY CASE WHEN release_stage = 'active' THEN 2 ELSE 1 END DESC, version DESC
     LIMIT 1
     ON CONFLICT DO NOTHING`,
    [releaseId]
  );
}

export function buildScriptReleaseScopeForTest(input: {
  name: string;
  schoolId: string;
  schoolSystemType: string;
}): { schoolSystemTypes: string[]; schoolIds: string[] } {
  return buildScriptReleaseScope(input);
}

function buildScriptReleaseScope(input: {
  name: string;
  schoolId: string;
  schoolSystemType: string;
}): { schoolSystemTypes: string[]; schoolIds: string[] } {
  const normalizedSystemType = normalizeSystemType(input.schoolSystemType);
  const schoolSystemTypes = normalizedSystemType !== "UNKNOWN"
    ? [normalizedSystemType]
    : systemTypesForScript(input.name);
  const schoolId = input.schoolId.trim();
  return {
    schoolSystemTypes,
    schoolIds: schoolId ? [schoolId] : []
  };
}

export async function registerRegistryRoutes(app: FastifyInstance, deps: RegistryRouteDependencies = {}): Promise<void> {
  const queryFn = (deps.query || query) as RegistryQuery;
  const signContentFn = deps.signContent || signContent;
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

  app.get("/api/v1/scripts/releases/:releaseId/bundle", async (request, reply) => {
    const releaseId = safeSegment((request.params as { releaseId: string }).releaseId);
    if (!releaseId) return reply.code(400).send({ code: 400, msg: "invalid releaseId" });
    const bundle = await loadImmutableBundle(queryFn, releaseId);
    if (!bundle) return reply.code(404).send({ code: 404, msg: "release not found" });
    const bundleSignature = signContentFn(stableJson(bundle));
    return reply.send({ ...bundle, bundleAlg: "rsa-sha256", bundleSignature });
  });

  app.get("/api/v1/scripts/releases/:releaseId/content", async (request, reply) => {
    const releaseId = safeSegment((request.params as { releaseId: string }).releaseId);
    if (!releaseId) return reply.code(400).send("invalid releaseId");
    const bundle = await loadImmutableBundle(queryFn, releaseId);
    if (!bundle) return reply.code(404).send("not found");
    return reply.type("application/javascript; charset=utf-8").send(bundle.script.content);
  });

  app.get("/api/v1/scripts/releases/:releaseId/meta", async (request, reply) => {
    const releaseId = safeSegment((request.params as { releaseId: string }).releaseId);
    if (!releaseId) return reply.code(400).send({ code: 400, msg: "invalid releaseId" });
    const bundle = await loadImmutableBundle(queryFn, releaseId);
    if (!bundle) return reply.code(404).send({ code: 404, msg: "release not found" });
    return reply.send({
      releaseId: bundle.releaseId,
      scriptKey: bundle.scriptKey,
      sha256: bundle.script.sha256,
      signature: bundle.script.signature,
      alg: bundle.script.alg,
      version: bundle.version
    });
  });

  app.post("/api/v1/scripts/activation-events", async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const releaseId = safeSegment(String(body.releaseId || ""));
    const eventType = String(body.eventType || "");
    const allowedEvents = new Set(["verified", "trial_passed", "activated", "failed", "quarantined", "rolled_back"]);
    if (!releaseId || !allowedEvents.has(eventType)) {
      return reply.code(400).send({ code: 400, msg: "invalid activation event" });
    }
    const releaseResult = await queryFn<any>(
      `SELECT release_id, target_type, category, name, school_system_types_json, school_ids_json
       FROM script_releases /* activation_release */ WHERE release_id = $1 LIMIT 1`,
      [releaseId]
    );
    const release = releaseResult.rows[0];
    if (!release) return reply.code(404).send({ code: 404, msg: "release not found" });
    const schoolId = String(body.schoolId || "").trim().slice(0, 160);
    const schoolSystemType = normalizeSystemType(String(body.schoolSystemType || ""));
    const scope = deriveReleaseScope({
      targetType: String(release.target_type || ""),
      category: String(release.category || ""),
      name: String(release.name || ""),
      schoolSystemTypes: release.school_system_types_json,
      schoolIds: release.school_ids_json
    });
    if (!releaseScopeMatchesRequest(scope, schoolSystemType, schoolId)) {
      return reply.code(400).send({ code: 400, msg: "activation scope mismatch" });
    }
    const errorCode = String(body.errorCode || "").trim().slice(0, 80);
    await queryFn(
      `INSERT INTO script_activation_metrics(release_id, school_id, school_system_type, event_type, error_code, event_count, last_event_at)
       VALUES ($1,$2,$3,$4,$5,1,now())
       ON CONFLICT (metric_date, release_id, school_id, event_type, error_code)
       DO UPDATE SET event_count = script_activation_metrics.event_count + 1, last_event_at = now()`,
      [releaseId, schoolId, schoolSystemType, eventType, errorCode]
    );
    return reply.code(202).send({ code: 202, msg: "accepted" });
  });

  app.get("/api/v1/scripts/manifest", async (request) => {
    const queryParams = request.query as Record<string, string | undefined>;
    const systemType = String(queryParams.schoolSystemType || "");
    const appVersionCode = Number(queryParams.appVersionCode || 0);
    const rows = await selectManifestReleases(
      systemType,
      queryParams.schoolId || "",
      appVersionCode,
      queryParams.installBucketIdHash || "",
      queryParams.selectionPolicy || ""
    );
    const base = await getManifestPublicBaseUrl(request.headers.host);
    const scripts = rows.map((row) => ({
      scriptId: row.script_id,
      targetType: row.target_type,
      category: row.category,
      name: row.name,
      version: Number(row.version || 0),
      releaseId: row.release_id,
      scriptKey: releaseScriptKey(row),
      releaseStage: row.release_stage,
      channel: row.channel,
      url: `${base}/api/v1/scripts/releases/${row.release_id}/content`,
      metaUrl: `${base}/api/v1/scripts/releases/${row.release_id}/meta`,
      bundleUrl: `${base}/api/v1/scripts/releases/${row.release_id}/bundle`,
      scopeKind: deriveReleaseScope({
        targetType: row.target_type,
        category: row.category,
        name: row.name,
        schoolSystemTypes: row.school_system_types_json,
        schoolIds: row.school_ids_json
      }).scopeKind,
      scopeId: deriveReleaseScope({
        targetType: row.target_type,
        category: row.category,
        name: row.name,
        schoolSystemTypes: row.school_system_types_json,
        schoolIds: row.school_ids_json
      }).scopeId,
      schoolSystemType: deriveReleaseScope({
        targetType: row.target_type,
        category: row.category,
        name: row.name,
        schoolSystemTypes: row.school_system_types_json,
        schoolIds: row.school_ids_json
      }).schoolSystemType,
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
      schoolBindingId: row.school_binding_id || null,
      selectionPolicy: row.selection_policy || "auto",
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

/** 按 releaseId 装配不可变脚本与依赖快照。 */
async function loadImmutableBundle(queryFn: RegistryQuery, releaseId: string): Promise<any | null> {
  const releaseResult = await queryFn<any>(
    `SELECT r.release_id, r.script_key, r.target_type, r.category, r.name, r.version,
            r.scope_kind, r.scope_id, r.school_system_type, r.parser_api_version, r.runner_contract_version,
            a.content, a.content_sha256, a.signature, a.alg
     FROM script_releases r /* bundle_release */
     JOIN script_artifacts a ON a.release_id = r.release_id
     WHERE r.release_id = $1 AND r.release_stage IN ('active','canary')
       AND r.status = 'enabled' AND r.kill_switch = false
     LIMIT 1`,
    [releaseId]
  );
  const row = releaseResult.rows[0];
  if (!row) return null;
  const derivedScope = deriveReleaseScope({
    targetType: String(row.target_type || ""),
    category: String(row.category || ""),
    name: String(row.name || ""),
    schoolSystemTypes: row.school_system_type && row.school_system_type !== "UNKNOWN" ? [row.school_system_type] : [],
    schoolIds: row.scope_kind === "school" ? [row.scope_id] : []
  });
  const dependencyResult = await queryFn<any>(
    `SELECT d.dependency_release_id, dr.category, dr.name, dr.version,
            da.content, da.content_sha256, da.signature, da.alg
     FROM script_release_dependencies d
     JOIN script_releases dr ON dr.release_id = d.dependency_release_id
     JOIN script_artifacts da ON da.release_id = d.dependency_release_id
     WHERE d.release_id = $1
     ORDER BY d.load_order ASC, d.id ASC`,
    [releaseId]
  );
  return buildImmutableBundlePayload({
    release: {
      releaseId: String(row.release_id),
      scriptKey: String(row.script_key || buildScriptKey(derivedScope)),
      targetType: String(row.target_type),
      category: String(row.category),
      name: String(row.name),
      version: Number(row.version || 0),
      scopeKind: row.scope_kind || derivedScope.scopeKind,
      scopeId: String(row.scope_id ?? derivedScope.scopeId),
      schoolSystemType: String(row.school_system_type || derivedScope.schoolSystemType),
      parserApiVersion: Number(row.parser_api_version || 1),
      runnerContractVersion: Number(row.runner_contract_version || 1)
    },
    artifact: {
      content: String(row.content || ""),
      sha256: String(row.content_sha256 || ""),
      signature: String(row.signature || ""),
      alg: String(row.alg || "rsa-sha256")
    },
    dependencies: dependencyResult.rows.map((dependency: any) => ({
      releaseId: String(dependency.dependency_release_id),
      category: String(dependency.category),
      name: String(dependency.name),
      version: Number(dependency.version || 0),
      content: String(dependency.content || ""),
      sha256: String(dependency.content_sha256 || ""),
      signature: String(dependency.signature || ""),
      alg: String(dependency.alg || "rsa-sha256")
    }))
  });
}

async function getReleaseForServing(category: string, name: string): Promise<(ReleaseRow & { content: string }) | null> {
  const result = await query<ReleaseRow & { content: string }>(
    `SELECT r.*, a.content, a.content_sha256, a.signature, a.alg
     FROM script_releases r
     JOIN script_artifacts a ON a.release_id = r.release_id
     WHERE r.category = $1 AND r.name = $2 AND r.release_stage IN ('active','canary')
       AND r.status = 'enabled' AND r.kill_switch = false
     ORDER BY CASE WHEN r.release_stage = 'active' THEN 2 ELSE 1 END DESC, r.version DESC
     LIMIT 1`,
    [category, name]
  );
  return result.rows[0] || null;
}

async function selectManifestReleases(
  systemType: string,
  schoolId: string,
  appVersionCode: number,
  bucket: string,
  requestedPolicy = ""
): Promise<ReleaseRow[]> {
  const rows = await query<ReleaseRow>(
    `SELECT r.*, a.content_sha256, a.signature, a.alg
     FROM script_releases r
     JOIN script_artifacts a ON a.release_id = r.release_id
     WHERE r.release_stage IN ('active','canary') AND r.status = 'enabled' AND r.kill_switch = false
       AND r.min_app_version_code <= $1
       AND (r.max_app_version_code IS NULL OR r.max_app_version_code >= $1)
     ORDER BY r.category, r.name, CASE WHEN r.release_stage = 'canary' THEN 2 ELSE 1 END DESC, r.version DESC`,
    [appVersionCode]
  );
  const selection = await loadAppSelection(bucket, schoolId, systemType, requestedPolicy);
  const bindings = await loadSchoolBindings(schoolId, systemType);
  return selectManifestRowsForTest(rows.rows, {
    systemType,
    schoolId,
    appVersionCode,
    bucket,
    selection,
    bindings
  });
}

export function selectManifestRowsForTest(
  rows: ReleaseRow[],
  context: {
    systemType: string;
    schoolId: string;
    appVersionCode: number;
    bucket: string;
    selection: AppScriptSelection | null;
    bindings: SchoolScriptBinding[];
  }
): ReleaseRow[] {
  const policy = context.selection?.selection_policy || "auto";
  if (policy === "assets_only") return [];
  const eligibleRows = rows.filter(
    (row) => isReleaseEligible(row, context.appVersionCode) && releaseTargetsMatch(row, context.systemType, context.schoolId)
  );
  if (policy === "fixed_release" && context.selection?.preferred_release_id) {
    const fixed = eligibleRows.find((row) => row.release_id === context.selection?.preferred_release_id);
    return fixed ? [markSelection(fixed, "fixed_release")] : [];
  }
  const grouped = new Map<string, ReleaseRow[]>();
  for (const row of eligibleRows) {
    const key = releaseScriptKey(row);
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }
  const selected: ReleaseRow[] = [];
  for (const group of grouped.values()) {
    const picked =
      selectUserSchoolSpecificRelease(group, context.selection) ||
      selectSchoolBindingRelease(group, context.bindings) ||
      selectCanaryRelease(group, context.bucket || "anonymous") ||
      selectActiveRelease(group);
    if (!picked) continue;
    selected.push(picked);
    if (picked.release_stage === "canary") {
      const stable = selectActiveRelease(group);
      if (stable && stable.release_id !== picked.release_id) selected.push(stable);
    }
  }
  return selected.sort((a, b) => {
    const scopeOrder = scopePriority(b) - scopePriority(a);
    return scopeOrder !== 0 ? scopeOrder : priorityFor(b, context.systemType) - priorityFor(a, context.systemType);
  });
}

/** 使用数据库中的脚本键，旧记录则即时推导，保证升级期间选择行为一致。 */
function releaseScriptKey(row: ReleaseRow): string {
  if (row.script_key) return row.script_key;
  return buildScriptKey(deriveReleaseScope({
    targetType: row.target_type,
    category: row.category,
    name: row.name,
    schoolSystemTypes: row.school_system_types_json,
    schoolIds: row.school_ids_json
  }));
}

/** 学校覆盖优先于系统通用，系统通用优先于全局运行时。 */
function scopePriority(row: ReleaseRow): number {
  const scope = deriveReleaseScope({
    targetType: row.target_type,
    category: row.category,
    name: row.name,
    schoolSystemTypes: row.school_system_types_json,
    schoolIds: row.school_ids_json
  });
  if (scope.scopeKind === "school") return 300;
  if (scope.scopeKind === "system") return 200;
  return 100;
}

async function loadAppSelection(
  bucket: string,
  schoolId: string,
  systemType: string,
  requestedPolicy: string
): Promise<AppScriptSelection | null> {
  const result = await query<AppScriptSelection>(
    `SELECT selection_policy, preferred_release_id, preferred_script_id
     FROM app_script_selections
     WHERE install_bucket_id_hash = $1
       AND (school_id = $2 OR school_id = '')
       AND (school_system_type = $3 OR school_system_type = '')
     ORDER BY CASE WHEN school_id = $2 THEN 1 ELSE 0 END DESC,
       CASE WHEN school_system_type = $3 THEN 1 ELSE 0 END DESC,
       updated_at DESC
     LIMIT 1`,
    [bucket || "anonymous", schoolId || "", systemType || ""]
  );
  const stored = result.rows[0] || null;
  if (requestedPolicy && requestedPolicy !== "auto") {
    return {
      selection_policy: requestedPolicy,
      preferred_release_id: stored?.preferred_release_id || null,
      preferred_script_id: stored?.preferred_script_id || null
    };
  }
  return stored;
}

async function loadSchoolBindings(schoolId: string, systemType: string): Promise<SchoolScriptBinding[]> {
  const result = await query<SchoolScriptBinding>(
    `SELECT binding_id, release_id, script_id, selection_policy, priority
     FROM school_script_bindings
     WHERE enabled = true
       AND (school_id = $1 OR school_id = '')
       AND (school_system_type = $2 OR school_system_type = '')
     ORDER BY priority DESC, updated_at DESC`,
    [schoolId || "", systemType || ""]
  );
  return result.rows;
}

function isReleaseEligible(row: ReleaseRow, appVersionCode: number): boolean {
  if (!["active", "canary"].includes(row.release_stage)) return false;
  if (row.status !== "enabled" || row.kill_switch) return false;
  const minVersion = Number(row.min_app_version_code || 0);
  const maxVersion = row.max_app_version_code ? Number(row.max_app_version_code) : null;
  if (appVersionCode < minVersion) return false;
  if (maxVersion !== null && appVersionCode > maxVersion) return false;
  return true;
}

function selectUserFixedRelease(group: ReleaseRow[], selection: AppScriptSelection | null): ReleaseRow | null {
  if (selection?.selection_policy !== "fixed_release" || !selection.preferred_release_id) return null;
  const row = group.find((item) => item.release_id === selection.preferred_release_id);
  return row ? markSelection(row, "fixed_release") : null;
}

function selectUserSchoolSpecificRelease(group: ReleaseRow[], selection: AppScriptSelection | null): ReleaseRow | null {
  if (selection?.selection_policy !== "school_specific") return null;
  const row = group.find((item) => {
    if (selection.preferred_release_id && item.release_id === selection.preferred_release_id) return true;
    if (selection.preferred_script_id && item.script_id === selection.preferred_script_id) return true;
    return false;
  });
  return row ? markSelection(row, "school_specific") : null;
}

function selectSchoolBindingRelease(group: ReleaseRow[], bindings: SchoolScriptBinding[]): ReleaseRow | null {
  for (const binding of bindings.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))) {
    const row = group.find((item) => {
      if (binding.release_id) return item.release_id === binding.release_id;
      return item.script_id === binding.script_id;
    });
    if (row) return markSelection(row, "school_binding", binding.binding_id);
  }
  return null;
}

function selectCanaryRelease(group: ReleaseRow[], bucket: string): ReleaseRow | null {
  const row = group
    .filter((item) => item.release_stage === "canary" && rolloutHit(item, bucket))
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  return row ? markSelection(row, "auto") : null;
}

function selectActiveRelease(group: ReleaseRow[]): ReleaseRow | null {
  const row = group.filter((item) => item.release_stage === "active").sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0];
  return row ? markSelection(row, "auto") : null;
}

function markSelection(row: ReleaseRow, selectionPolicy: string, schoolBindingId: string | null = null): ReleaseRow {
  return { ...row, selection_policy: selectionPolicy, school_binding_id: schoolBindingId };
}

function releaseTargetsMatch(row: ReleaseRow, systemType: string, schoolId: string): boolean {
  const scope = deriveReleaseScope({
    targetType: row.target_type,
    category: row.category,
    name: row.name,
    schoolSystemTypes: row.school_system_types_json,
    schoolIds: row.school_ids_json
  });
  return releaseScopeMatchesRequest(scope, systemType, schoolId);
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

/**
 * 由目录名推断脚本分类。
 *
 * 此前实现是「以 /js 结尾则 js，否则一律 parsers」，新增 runtime 目录后会把
 * 共享执行契约误判为解析器，导致它被当成课表解析脚本参与 manifest 优先级排序。
 */
export function categoryFromDir(dir: string): string {
  const base = path.basename(dir.replace(/[\\/]+$/, "")).toLowerCase();
  if (base === "js" || base === "parsers" || base === "runtime") return base;
  return "parsers";
}

/** 由分类与文件名推断 targetType */
export function targetTypeFor(category: string, name: string): string {
  if (category === "parsers") return "parser";
  if (category === "runtime") return "runtime";
  return inferJsTarget(name);
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
