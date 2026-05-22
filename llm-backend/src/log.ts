import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function write(level: string, message: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(config.backendMirrorLogFile), { recursive: true });
    fs.appendFileSync(config.backendMirrorLogFile, `${line}\n`);
  } catch {
    // Logging must never break request handling.
  }
}

export const log = {
  info: (message: string, meta?: unknown) => write("INFO", message, meta),
  warn: (message: string, meta?: unknown) => write("WARN", message, meta),
  error: (message: string, meta?: unknown) => write("ERROR", message, meta)
};
