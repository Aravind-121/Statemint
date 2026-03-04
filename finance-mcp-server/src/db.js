import pg from "pg";
import { loadEnv, getDatabaseUrl } from "../../lib/config.js";

loadEnv();

const { Pool } = pg;

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const res = await getPool().query(sql, params);
  return res.rows;
}

export async function close() {
  if (pool) await pool.end();
}

export { getPool as default };
