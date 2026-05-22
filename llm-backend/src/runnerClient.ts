import { config } from "./config.js";
import { getRuntimePlatformConfig } from "./runtimeConfig.js";
import { RunnerRequest, RunnerResponse } from "./types.js";

export async function runScript(request: RunnerRequest): Promise<RunnerResponse> {
  const runtime = await getRuntimePlatformConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(request.timeoutMs || runtime.runnerTimeoutMs, 1000) + 2000);
  try {
    const response = await fetch(`${runtime.runnerUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      return {
        ok: false,
        status: "failed",
        durationMs: 0,
        schemaValid: false,
        resultCount: 0,
        errorCode: `http_${response.status}`,
        errorMessage: json?.errorMessage || text || "runner request failed"
      };
    }
    return json as RunnerResponse;
  } catch (error) {
    return {
      ok: false,
      status: error instanceof Error && error.name === "AbortError" ? "timeout" : "failed",
      durationMs: 0,
      schemaValid: false,
      resultCount: 0,
      errorCode: error instanceof Error && error.name === "AbortError" ? "timeout" : "runner_error",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}
