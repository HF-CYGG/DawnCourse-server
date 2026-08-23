import { normalizeSystemType } from "./utils.js";
/** 从旧版目标数组推导标准作用域，供迁移期与新版发布共用。 */
export function deriveReleaseScope(input) {
    const systems = normalizeStringArray(input.schoolSystemTypes).map(normalizeSystemType).filter((item) => item !== "UNKNOWN");
    const schools = normalizeStringArray(input.schoolIds);
    const base = {
        targetType: input.targetType.trim() || "parser",
        category: input.category.trim(),
        name: input.name.trim()
    };
    if (input.category === "runtime") {
        return { ...base, scopeKind: "global", scopeId: "", schoolSystemType: "UNKNOWN" };
    }
    if (schools.length > 0) {
        return {
            ...base,
            scopeKind: "school",
            scopeId: schools[0],
            schoolSystemType: systems[0] || "UNKNOWN"
        };
    }
    if (systems.length > 0) {
        return {
            ...base,
            scopeKind: "system",
            scopeId: systems[0],
            schoolSystemType: systems[0]
        };
    }
    return { ...base, scopeKind: "global", scopeId: "", schoolSystemType: "UNKNOWN" };
}
/** 生成跨服务端、客户端与管理端稳定使用的脚本键。 */
export function buildScriptKey(scope) {
    return [scope.targetType, scope.category, scope.name, scope.scopeKind, scope.scopeId].join("/");
}
/** 判断两个 release 是否属于同一条发布轨道。 */
export function sameScriptTrack(left, right) {
    return buildScriptKey(left) === buildScriptKey(right);
}
/** 判断请求上下文能否使用指定作用域，空学校绝不匹配学校脚本。 */
export function releaseScopeMatchesRequest(scope, systemType, schoolId) {
    const normalizedSystem = normalizeSystemType(systemType);
    if (scope.scopeKind === "school") {
        if (!schoolId.trim() || schoolId.trim() !== scope.scopeId)
            return false;
        return scope.schoolSystemType === "UNKNOWN" || normalizedSystem === scope.schoolSystemType;
    }
    if (scope.scopeKind === "system") {
        return normalizedSystem !== "UNKNOWN" && normalizedSystem === scope.scopeId;
    }
    return true;
}
/** 构建不可变 bundle 的公开负载，签名由路由层对稳定 JSON 整体生成。 */
export function buildImmutableBundlePayload(input) {
    return {
        releaseId: input.release.releaseId,
        scriptKey: input.release.scriptKey,
        targetType: input.release.targetType,
        category: input.release.category,
        name: input.release.name,
        version: input.release.version,
        scopeKind: input.release.scopeKind,
        scopeId: input.release.scopeId,
        schoolSystemType: input.release.schoolSystemType,
        parserApiVersion: input.release.parserApiVersion,
        runnerContractVersion: input.release.runnerContractVersion,
        script: { ...input.artifact },
        dependencies: input.dependencies.map((item) => ({ ...item }))
    };
}
/** 兼容 PostgreSQL JSONB、JSON 字符串和普通数组。 */
function normalizeStringArray(value) {
    if (Array.isArray(value))
        return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value !== "string" || !value.trim())
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [];
    }
    catch {
        return [];
    }
}
