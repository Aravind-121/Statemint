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

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS statements (
  id            SERIAL PRIMARY KEY,
  statement_type VARCHAR(50) DEFAULT 'credit_card',
  bank          VARCHAR(100),
  card_last4    VARCHAR(4),
  account_number VARCHAR(50),
  statement_month DATE,
  file_path     TEXT,
  total_due     NUMERIC(12,2),
  min_due       NUMERIC(12,2),
  due_date      DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              SERIAL PRIMARY KEY,
  statement_id    INT REFERENCES statements(id) ON DELETE CASCADE,
  txn_date        DATE,
  description     TEXT,
  merchant_raw    TEXT,
  merchant_clean  VARCHAR(255),
  category        VARCHAR(100),
  amount          NUMERIC(12,2),
  type            VARCHAR(20) DEFAULT 'debit',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_txn_statement   ON transactions(statement_id);
CREATE INDEX IF NOT EXISTS idx_txn_date        ON transactions(txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_category    ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_txn_merchant    ON transactions(merchant_clean);
CREATE INDEX IF NOT EXISTS idx_stmt_month      ON statements(statement_month);
CREATE INDEX IF NOT EXISTS idx_stmt_type       ON statements(statement_type);
`;

export async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log("[db] Migration complete — tables ready.");
  } finally {
    client.release();
  }
}

export async function insertStatement({
  statementType,
  bank,
  cardLast4,
  accountNumber,
  statementMonth,
  filePath,
  totalDue,
  minDue,
  dueDate,
}) {
  const res = await getPool().query(
    `INSERT INTO statements (statement_type, bank, card_last4, account_number, statement_month, file_path, total_due, min_due, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [statementType || "credit_card", bank, cardLast4 || null, accountNumber || null, statementMonth, filePath, totalDue, minDue, dueDate]
  );
  return res.rows[0].id;
}

export async function insertTransactions(statementId, transactions) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const txn of transactions) {
      await client.query(
        `INSERT INTO transactions (statement_id, txn_date, description, merchant_raw, merchant_clean, category, amount, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          statementId,
          txn.date,
          txn.description,
          txn.merchantRaw,
          txn.merchantClean,
          txn.category,
          txn.amount,
          txn.type || "debit",
        ]
      );
    }
    await client.query("COMMIT");
    console.log(
      `[db] Inserted ${transactions.length} transactions for statement #${statementId}`
    );
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function query(sql, params = []) {
  const res = await getPool().query(sql, params);
  return res.rows;
}

export async function close() {
  if (pool) await pool.end();
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("db.js") &&
  process.argv.includes("migrate")
) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[db] Migration failed:", err.message);
      process.exit(1);
    });
}

export { getPool as default };
