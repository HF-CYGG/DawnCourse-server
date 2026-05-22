import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { config } from "./config.js";
import { log } from "./log.js";
const { Pool } = pg;
export const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000
});
export async function query(text, params = []) {
    return pool.query(text, params);
}
export async function withTx(fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    }
    catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
    finally {
        client.release();
    }
}
export async function migrate() {
    const files = fs
        .readdirSync(config.migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort();
    for (const file of files) {
        const version = file.replace(/\.sql$/, "");
        const exists = await query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]).catch(() => null);
        if (exists?.rowCount)
            continue;
        const sql = fs.readFileSync(path.join(config.migrationsDir, file), "utf8");
        await withTx(async (client) => {
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
        });
        log.info("migration applied", { version });
    }
}
export async function closeDb() {
    await pool.end();
}
