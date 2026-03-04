import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdirSync, existsSync } from "fs";
import path from "path";
import { loadEnv, getDownloadsDir } from "../../lib/config.js";

loadEnv();

import { parsePDF } from "./pdf-parser.js";
import { normalizeMerchant, categorize } from "./categorizer.js";
import { migrate, insertStatement, insertTransactions, close } from "./db.js";

const DOWNLOADS_DIR = getDownloadsDir();

/**
 * Process a single PDF statement file.
 * Parses PDF -> normalizes merchants -> categorizes -> stores in DB.
 */
export async function processStatementFile(filePath, password, statementType) {
  const { transactions, summary, rawText } = await parsePDF(filePath, password);

  if (transactions.length === 0) {
    return {
      statementId: null,
      transactions: [],
      summary,
      rawTextPreview: rawText.substring(0, 1000),
    };
  }

  const enrichedTxns = transactions.map((txn) => ({
    ...txn,
    merchantClean: normalizeMerchant(txn.merchantRaw),
    category: categorize(txn.description),
  }));

  const statementId = await insertStatement({
    statementType: statementType || summary.statementType,
    bank: summary.bank,
    cardLast4: summary.cardLast4,
    accountNumber: summary.accountNumber,
    statementMonth: summary.statementMonth,
    filePath,
    totalDue: summary.totalDue,
    minDue: summary.minDue,
    dueDate: summary.dueDate,
  });

  await insertTransactions(statementId, enrichedTxns);

  const totalDebit = enrichedTxns
    .filter((t) => t.type === "debit")
    .reduce((sum, t) => sum + t.amount, 0);
  const totalCredit = enrichedTxns
    .filter((t) => t.type === "credit")
    .reduce((sum, t) => sum + t.amount, 0);

  const byCategory = {};
  for (const txn of enrichedTxns) {
    if (txn.type === "debit") {
      byCategory[txn.category] = (byCategory[txn.category] || 0) + txn.amount;
    }
  }

  return {
    statementId,
    statementType: statementType || summary.statementType,
    bank: summary.bank,
    cardLast4: summary.cardLast4,
    accountNumber: summary.accountNumber,
    statementMonth: summary.statementMonth,
    transactionCount: enrichedTxns.length,
    totalDebits: totalDebit,
    totalCredits: totalCredit,
    netSpend: totalDebit - totalCredit,
    categoryBreakdown: byCategory,
    totalDue: summary.totalDue,
    minDue: summary.minDue,
    dueDate: summary.dueDate,
  };
}

const server = new McpServer({
  name: "statement-processor",
  version: "1.0.0",
  description:
    "MCP server for processing financial statement PDFs. Parses credit card statements, bank statements, loan statements, and other e-statements. Extracts transactions, categorizes spending, and stores in PostgreSQL.",
});

server.tool(
  "processStatement",
  "Process a financial statement PDF (credit card, bank account, loan, etc.). Parses the PDF, extracts transactions, normalizes merchant names, categorizes spending, and stores everything in PostgreSQL. Call this after downloading a statement PDF via Gmail MCP.",
  {
    filePath: z
      .string()
      .describe("Absolute path to the PDF file (from downloadAttachment result)"),
    password: z
      .string()
      .optional()
      .describe("Password to decrypt the PDF (from email body password hint)"),
    statementType: z
      .string()
      .optional()
      .describe("Type of statement: credit_card, bank_account, loan, insurance, utility, other. Auto-detected if omitted."),
  },
  async ({ filePath, password, statementType }) => {
    try {
      await migrate();

      if (!existsSync(filePath)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `File not found: ${filePath}` },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const result = await processStatementFile(filePath, password, statementType);

      if (!result.statementId) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  message:
                    "No transactions could be extracted from the PDF. The format may not be supported.",
                  rawTextPreview: result.rawTextPreview,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                message: `Statement processed successfully. ${result.transactionCount} transactions stored.`,
                ...result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "processAllStatements",
  "Process ALL PDF files in the downloads directory. Useful for bulk-processing multiple downloaded statements at once.",
  {
    password: z
      .string()
      .optional()
      .describe("Password for encrypted PDFs (applied to all files)"),
  },
  async ({ password }) => {
    try {
      await migrate();

      if (!existsSync(DOWNLOADS_DIR)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `Downloads directory not found: ${DOWNLOADS_DIR}` },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const files = readdirSync(DOWNLOADS_DIR).filter((f) =>
        f.toLowerCase().endsWith(".pdf")
      );

      if (files.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  message: "No PDF files found in downloads directory.",
                  processed: 0,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const results = [];
      for (const file of files) {
        const filePath = path.join(DOWNLOADS_DIR, file);
        try {
          const result = await processStatementFile(filePath, password);
          results.push({ file, success: true, ...result });
        } catch (err) {
          results.push({ file, success: false, error: err.message });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                processed: results.length,
                successful: results.filter((r) => r.success).length,
                failed: results.filter((r) => !r.success).length,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "listDownloadedPDFs",
  "List all PDF files currently in the downloads directory. Shows which files are available for processing.",
  {},
  async () => {
    try {
      if (!existsSync(DOWNLOADS_DIR)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { files: [], directory: DOWNLOADS_DIR, message: "Downloads directory not found" },
                null,
                2
              ),
            },
          ],
        };
      }

      const files = readdirSync(DOWNLOADS_DIR)
        .filter((f) => f.toLowerCase().endsWith(".pdf"))
        .map((f) => ({
          filename: f,
          path: path.join(DOWNLOADS_DIR, f),
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                directory: DOWNLOADS_DIR,
                count: files.length,
                files,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[statement-processor-mcp] Server started on stdio transport");
}

main().catch((err) => {
  console.error("[statement-processor-mcp] Fatal error:", err);
  process.exit(1);
});
