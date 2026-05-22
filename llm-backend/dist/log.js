import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
function write(level, message, meta) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
    console.log(line);
    try {
        fs.mkdirSync(path.dirname(config.backendMirrorLogFile), { recursive: true });
        fs.appendFileSync(config.backendMirrorLogFile, `${line}\n`);
    }
    catch {
        // Logging must never break request handling.
    }
}
export const log = {
    info: (message, meta) => write("INFO", message, meta),
    warn: (message, meta) => write("WARN", message, meta),
    error: (message, meta) => write("ERROR", message, meta)
};
