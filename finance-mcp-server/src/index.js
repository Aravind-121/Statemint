import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { query } from "./db.js";

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const server = new McpServer({
  name: "finance-estatement",
  version: "1.0.0",
  description:
    "MCP server for querying financial statement data. Provides tools for monthly spend analysis, category breakdowns, merchant rankings, month comparisons, and recurring payment detection across credit cards, bank accounts, and other statements.",
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function monthToDateRange(month) {
  // month = "2026-01" or "2026-1" or "January 2026"
  let year, mon;
  const isoMatch = month.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMatch) {
    year = parseInt(isoMatch[1]);
    mon = parseInt(isoMatch[2]);
  } else {
    // Try "January 2026" style
    const months = {
      january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
      july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
      jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    };
    const nameMatch = month.match(/^(\w+)\s+(\d{4})$/i);
    if (nameMatch) {
      mon = months[nameMatch[1].toLowerCase()];
      year = parseInt(nameMatch[2]);
    }
  }

  if (!year || !mon) throw new Error(`Invalid month format: "${month}". Use YYYY-MM (e.g., 2026-01)`);

  const start = `${year}-${String(mon).padStart(2, "0")}-01`;
  const endMon = mon === 12 ? 1 : mon + 1;
  const endYear = mon === 12 ? year + 1 : year;
  const end = `${endYear}-${String(endMon).padStart(2, "0")}-01`;

  return { start, end };
}

function jsonResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(msg) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }],
    isError: true,
  };
}

// ─── Tool: checkDataAvailability ─────────────────────────────────────────────

server.tool(
  "checkDataAvailability",
  "ALWAYS call this FIRST before any spending query. Checks if statement data (credit card, bank, etc.) has been processed for a given month. If data_available is false, the LLM should use the Gmail MCP to fetch emails, download the PDF, then use the statement-processor MCP to parse it before querying again.",
  {
    month: z
      .string()
      .describe('Month in YYYY-MM format (e.g., "2026-03") or "March 2026"'),
  },
  async ({ month }) => {
    try {
      const { start, end } = monthToDateRange(month);

      const rows = await query(
        `SELECT
           COUNT(*) AS transaction_count,
           COUNT(DISTINCT statement_id) AS statement_count
         FROM transactions
         WHERE txn_date >= $1 AND txn_date < $2`,
        [start, end]
      );

      const txnCount = parseInt(rows[0].transaction_count);
      const stmtCount = parseInt(rows[0].statement_count);

      if (txnCount === 0) {
        return jsonResult({
          month,
          data_available: false,
          message: `No data found for ${month}. You need to: 1) Use Gmail MCP 'listStatementEmails' to find the statement email for this month, 2) Use 'downloadAttachment' to save the PDF, 3) Use Statement Processor MCP 'processStatement' to parse and store it, then 4) Query again.`,
          next_steps: [
            "Call listStatementEmails with the appropriate year and month",
            "Call getEmailContent to check for password hints",
            "Call downloadAttachment to save the PDF",
            "Call processStatement to parse the PDF and store transactions",
            "Then retry this query",
          ],
        });
      }

      return jsonResult({
        month,
        data_available: true,
        transaction_count: txnCount,
        statement_count: stmtCount,
        message: `Data available: ${txnCount} transactions from ${stmtCount} statement(s).`,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: getMonthlySpend ───────────────────────────────────────────────────

server.tool(
  "getMonthlySpend",
  "Get total spending for a specific month across all statements. Returns total debits, credits, net spend, and transaction count.",
  {
    month: z
      .string()
      .describe('Month in YYYY-MM format (e.g., "2026-01") or "January 2026"'),
  },
  async ({ month }) => {
    try {
      const { start, end } = monthToDateRange(month);

      const rows = await query(
        `SELECT
           COUNT(*) AS transaction_count,
           COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS total_debits,
           COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) AS total_credits,
           COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END), 0) AS net_spend
         FROM transactions
         WHERE txn_date >= $1 AND txn_date < $2`,
        [start, end]
      );

      return jsonResult({
        month,
        ...rows[0],
        transaction_count: parseInt(rows[0].transaction_count),
        total_debits: parseFloat(rows[0].total_debits),
        total_credits: parseFloat(rows[0].total_credits),
        net_spend: parseFloat(rows[0].net_spend),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: getCategorySpend ──────────────────────────────────────────────────

server.tool(
  "getCategorySpend",
  "Get spending breakdown by category for a specific month. Optionally filter to a single category.",
  {
    month: z.string().describe('Month in YYYY-MM format (e.g., "2026-01")'),
    category: z
      .string()
      .optional()
      .describe(
        'Optional category to filter (e.g., "Food & Dining", "Shopping"). If omitted, returns all categories.'
      ),
  },
  async ({ month, category }) => {
    try {
      const { start, end } = monthToDateRange(month);

      let sql = `
        SELECT
          category,
          COUNT(*) AS transaction_count,
          SUM(amount) AS total_amount,
          ROUND(AVG(amount), 2) AS avg_amount,
          MIN(amount) AS min_amount,
          MAX(amount) AS max_amount
        FROM transactions
        WHERE txn_date >= $1 AND txn_date < $2
          AND type = 'debit'
      `;
      const params = [start, end];

      if (category) {
        sql += ` AND LOWER(category) = LOWER($3)`;
        params.push(category);
      }

      sql += ` GROUP BY category ORDER BY total_amount DESC`;

      const rows = await query(sql, params);

      // If a category was specified, also return the individual transactions
      let transactions = [];
      if (category && rows.length > 0) {
        transactions = await query(
          `SELECT txn_date, description, merchant_clean, amount
           FROM transactions
           WHERE txn_date >= $1 AND txn_date < $2
             AND type = 'debit'
             AND LOWER(category) = LOWER($3)
           ORDER BY amount DESC`,
          [start, end, category]
        );
      }

      return jsonResult({
        month,
        category: category || "all",
        categories: rows.map((r) => ({
          ...r,
          transaction_count: parseInt(r.transaction_count),
          total_amount: parseFloat(r.total_amount),
          avg_amount: parseFloat(r.avg_amount),
          min_amount: parseFloat(r.min_amount),
          max_amount: parseFloat(r.max_amount),
        })),
        ...(transactions.length > 0 && { transactions }),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: getTopMerchants ───────────────────────────────────────────────────

server.tool(
  "getTopMerchants",
  "Get top merchants by spending for a specific month. Returns merchant names ranked by total amount.",
  {
    month: z.string().describe('Month in YYYY-MM format (e.g., "2026-01")'),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Number of top merchants to return (default: 10)"),
  },
  async ({ month, limit }) => {
    try {
      const { start, end } = monthToDateRange(month);

      const rows = await query(
        `SELECT
           merchant_clean AS merchant,
           COUNT(*) AS transaction_count,
           SUM(amount) AS total_amount,
           ROUND(AVG(amount), 2) AS avg_amount
         FROM transactions
         WHERE txn_date >= $1 AND txn_date < $2
           AND type = 'debit'
         GROUP BY merchant_clean
         ORDER BY total_amount DESC
         LIMIT $3`,
        [start, end, limit]
      );

      return jsonResult({
        month,
        top_merchants: rows.map((r) => ({
          ...r,
          transaction_count: parseInt(r.transaction_count),
          total_amount: parseFloat(r.total_amount),
          avg_amount: parseFloat(r.avg_amount),
        })),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: compareMonths ─────────────────────────────────────────────────────

server.tool(
  "compareMonths",
  "Compare spending between two months. Shows total spend difference, category-wise changes, and new/dropped merchants.",
  {
    month1: z.string().describe('First month in YYYY-MM format (e.g., "2026-01")'),
    month2: z.string().describe('Second month in YYYY-MM format (e.g., "2026-02")'),
  },
  async ({ month1, month2 }) => {
    try {
      const range1 = monthToDateRange(month1);
      const range2 = monthToDateRange(month2);

      // Overall comparison
      const totals = await query(
        `SELECT
           'month1' AS period,
           COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END), 0) AS total_debits,
           COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END), 0) AS total_credits,
           COUNT(*) AS txn_count
         FROM transactions WHERE txn_date >= $1 AND txn_date < $2
         UNION ALL
         SELECT
           'month2',
           COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END), 0),
           COUNT(*)
         FROM transactions WHERE txn_date >= $3 AND txn_date < $4`,
        [range1.start, range1.end, range2.start, range2.end]
      );

      const m1 = totals.find((r) => r.period === "month1") || { total_debits: 0, total_credits: 0, txn_count: 0 };
      const m2 = totals.find((r) => r.period === "month2") || { total_debits: 0, total_credits: 0, txn_count: 0 };

      // Category comparison
      const catComp = await query(
        `SELECT
           category,
           COALESCE(SUM(CASE WHEN txn_date >= $1 AND txn_date < $2 THEN amount ELSE 0 END), 0) AS month1_amount,
           COALESCE(SUM(CASE WHEN txn_date >= $3 AND txn_date < $4 THEN amount ELSE 0 END), 0) AS month2_amount
         FROM transactions
         WHERE type = 'debit'
           AND ((txn_date >= $1 AND txn_date < $2) OR (txn_date >= $3 AND txn_date < $4))
         GROUP BY category
         ORDER BY month2_amount DESC`,
        [range1.start, range1.end, range2.start, range2.end]
      );

      return jsonResult({
        month1: {
          month: month1,
          total_debits: parseFloat(m1.total_debits),
          total_credits: parseFloat(m1.total_credits),
          txn_count: parseInt(m1.txn_count),
        },
        month2: {
          month: month2,
          total_debits: parseFloat(m2.total_debits),
          total_credits: parseFloat(m2.total_credits),
          txn_count: parseInt(m2.txn_count),
        },
        difference: {
          total_debits: parseFloat(m2.total_debits) - parseFloat(m1.total_debits),
          total_credits: parseFloat(m2.total_credits) - parseFloat(m1.total_credits),
          percentage_change:
            parseFloat(m1.total_debits) > 0
              ? (
                  ((parseFloat(m2.total_debits) - parseFloat(m1.total_debits)) /
                    parseFloat(m1.total_debits)) *
                  100
                ).toFixed(1) + "%"
              : "N/A",
        },
        category_comparison: catComp.map((r) => ({
          category: r.category,
          month1_amount: parseFloat(r.month1_amount),
          month2_amount: parseFloat(r.month2_amount),
          change: parseFloat(r.month2_amount) - parseFloat(r.month1_amount),
        })),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: detectRecurringPayments ───────────────────────────────────────────

server.tool(
  "detectRecurringPayments",
  "Detect recurring payments (subscriptions, EMIs, etc.) across months. Finds merchants that appear consistently with similar amounts.",
  {
    months: z
      .number()
      .optional()
      .default(3)
      .describe("Number of recent months to analyze (default: 3)"),
  },
  async ({ months }) => {
    try {
      // Find merchants appearing in multiple months with consistent amounts
      const rows = await query(
        `WITH monthly_merchants AS (
           SELECT
             merchant_clean,
             category,
             DATE_TRUNC('month', txn_date) AS month,
             SUM(amount) AS monthly_total,
             COUNT(*) AS monthly_count
           FROM transactions
           WHERE type = 'debit'
             AND txn_date >= (CURRENT_DATE - ($1 || ' months')::INTERVAL)
           GROUP BY merchant_clean, category, DATE_TRUNC('month', txn_date)
         )
         SELECT
           merchant_clean AS merchant,
           category,
           COUNT(DISTINCT month) AS months_present,
           ROUND(AVG(monthly_total), 2) AS avg_monthly_amount,
           ROUND(STDDEV(monthly_total), 2) AS amount_variation,
           MIN(monthly_total) AS min_monthly,
           MAX(monthly_total) AS max_monthly,
           ARRAY_AGG(DISTINCT TO_CHAR(month, 'YYYY-MM') ORDER BY TO_CHAR(month, 'YYYY-MM')) AS months
         FROM monthly_merchants
         GROUP BY merchant_clean, category
         HAVING COUNT(DISTINCT month) >= LEAST(2, $1)
         ORDER BY COUNT(DISTINCT month) DESC, AVG(monthly_total) DESC`,
        [months]
      );

      // Classify: "recurring" if amount variation is low, "variable" otherwise
      const recurring = rows.map((r) => {
        const variation = parseFloat(r.amount_variation) || 0;
        const avg = parseFloat(r.avg_monthly_amount);
        const variationPct = avg > 0 ? (variation / avg) * 100 : 0;

        return {
          merchant: r.merchant,
          category: r.category,
          months_present: parseInt(r.months_present),
          avg_monthly_amount: parseFloat(r.avg_monthly_amount),
          amount_variation: variationPct.toFixed(1) + "%",
          is_fixed: variationPct < 10,
          type: variationPct < 10 ? "subscription/EMI" : "regular spend",
          months: r.months,
          min_monthly: parseFloat(r.min_monthly),
          max_monthly: parseFloat(r.max_monthly),
        };
      });

      return jsonResult({
        analysis_period: `Last ${months} months`,
        recurring_payments: recurring.filter((r) => r.is_fixed),
        regular_merchants: recurring.filter((r) => !r.is_fixed),
        total_recurring_monthly: recurring
          .filter((r) => r.is_fixed)
          .reduce((sum, r) => sum + r.avg_monthly_amount, 0)
          .toFixed(2),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: getTransactions ───────────────────────────────────────────────────

server.tool(
  "getTransactions",
  "Get a list of individual transactions with optional filters. Useful for detailed investigation.",
  {
    month: z.string().optional().describe('Filter by month (YYYY-MM format)'),
    category: z.string().optional().describe('Filter by category'),
    merchant: z.string().optional().describe('Filter by merchant name (partial match)'),
    minAmount: z.number().optional().describe('Minimum transaction amount'),
    maxAmount: z.number().optional().describe('Maximum transaction amount'),
    limit: z.number().optional().default(50).describe('Max results (default: 50)'),
  },
  async ({ month, category, merchant, minAmount, maxAmount, limit }) => {
    try {
      let sql = `SELECT txn_date, description, merchant_clean, category, amount, type FROM transactions WHERE 1=1`;
      const params = [];
      let paramIdx = 1;

      if (month) {
        const { start, end } = monthToDateRange(month);
        sql += ` AND txn_date >= $${paramIdx} AND txn_date < $${paramIdx + 1}`;
        params.push(start, end);
        paramIdx += 2;
      }

      if (category) {
        sql += ` AND LOWER(category) = LOWER($${paramIdx})`;
        params.push(category);
        paramIdx++;
      }

      if (merchant) {
        sql += ` AND LOWER(merchant_clean) LIKE LOWER($${paramIdx})`;
        params.push(`%${merchant}%`);
        paramIdx++;
      }

      if (minAmount !== undefined) {
        sql += ` AND amount >= $${paramIdx}`;
        params.push(minAmount);
        paramIdx++;
      }

      if (maxAmount !== undefined) {
        sql += ` AND amount <= $${paramIdx}`;
        params.push(maxAmount);
        paramIdx++;
      }

      sql += ` ORDER BY txn_date DESC, amount DESC LIMIT $${paramIdx}`;
      params.push(limit);

      const rows = await query(sql, params);

      return jsonResult({
        filters: { month, category, merchant, minAmount, maxAmount },
        count: rows.length,
        transactions: rows,
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Tool: getSpendingSummary ────────────────────────────────────────────────

server.tool(
  "getSpendingSummary",
  "Get a high-level spending summary across all available data. Shows total spend, average monthly spend, top categories, and top merchants.",
  {},
  async () => {
    try {
      const overview = await query(`
        SELECT
          COUNT(*) AS total_transactions,
          COUNT(DISTINCT DATE_TRUNC('month', txn_date)) AS months_of_data,
          COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END), 0) AS total_debits,
          COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END), 0) AS total_credits,
          MIN(txn_date) AS earliest_date,
          MAX(txn_date) AS latest_date
        FROM transactions
      `);

      const topCategories = await query(`
        SELECT category, SUM(amount) AS total, COUNT(*) AS count
        FROM transactions WHERE type='debit'
        GROUP BY category ORDER BY total DESC LIMIT 5
      `);

      const topMerchants = await query(`
        SELECT merchant_clean AS merchant, SUM(amount) AS total, COUNT(*) AS count
        FROM transactions WHERE type='debit'
        GROUP BY merchant_clean ORDER BY total DESC LIMIT 5
      `);

      const o = overview[0];
      const monthsCount = parseInt(o.months_of_data) || 1;

      return jsonResult({
        overview: {
          total_transactions: parseInt(o.total_transactions),
          months_of_data: monthsCount,
          date_range: { from: o.earliest_date, to: o.latest_date },
          total_debits: parseFloat(o.total_debits),
          total_credits: parseFloat(o.total_credits),
          avg_monthly_spend: (parseFloat(o.total_debits) / monthsCount).toFixed(2),
        },
        top_categories: topCategories.map((r) => ({
          category: r.category,
          total: parseFloat(r.total),
          count: parseInt(r.count),
        })),
        top_merchants: topMerchants.map((r) => ({
          merchant: r.merchant,
          total: parseFloat(r.total),
          count: parseInt(r.count),
        })),
      });
    } catch (err) {
      return errorResult(err.message);
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[finance-mcp] Server started on stdio transport");
}

main().catch((err) => {
  console.error("[finance-mcp] Fatal error:", err);
  process.exit(1);
});
