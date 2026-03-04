import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getGmailClient } from "./auth.js";
import { writeFileSync } from "fs";
import path from "path";
import { getDownloadsDir } from "../../lib/config.js";

const DOWNLOADS_DIR = getDownloadsDir();

const server = new McpServer({
  name: "gmail-estatement",
  version: "1.0.0",
  description:
    "MCP server for fetching financial statement emails and downloading PDF attachments from Gmail. Supports credit card statements, bank statements, loan statements, and other e-statements.",
});

server.tool(
  "searchEmails",
  "Search Gmail for financial statement emails. Use query like 'statement' or 'subject:e-statement after:2026/01/01 before:2026/02/01' to filter by date range.",
  {
    query: z
      .string()
      .describe(
        "Gmail search query. Examples: 'bank statement', 'subject:e-statement', 'from:alerts@hdfcbank.net subject:statement after:2026/01/01 before:2026/02/01'"
      ),
    maxResults: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of results to return (default: 10)"),
  },
  async ({ query, maxResults }) => {
    try {
      const gmail = await getGmailClient();
      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messages = res.data.messages || [];

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { results: [], message: "No emails found matching the query." },
                null,
                2
              ),
            },
          ],
        };
      }

      const results = await Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });

          const headers = detail.data.payload.headers;
          const getHeader = (name) =>
            headers.find((h) => h.name === name)?.value || "";

          return {
            id: msg.id,
            threadId: msg.threadId,
            subject: getHeader("Subject"),
            from: getHeader("From"),
            date: getHeader("Date"),
            snippet: detail.data.snippet,
            hasAttachments: !!(
              detail.data.payload.parts &&
              detail.data.payload.parts.some(
                (p) => p.filename && p.filename.length > 0
              )
            ),
          };
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ results, total: results.length }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: error.message },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "getEmailContent",
  "Get the full content of an email by its ID. Returns the body text and a list of attachments. Useful for extracting PDF password hints from the email body.",
  {
    messageId: z.string().describe("The Gmail message ID (from searchEmails results)"),
  },
  async ({ messageId }) => {
    try {
      const gmail = await getGmailClient();
      const res = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const payload = res.data.payload;
      const headers = payload.headers;
      const getHeader = (name) =>
        headers.find((h) => h.name === name)?.value || "";

      let bodyText = "";
      const attachments = [];

      function extractParts(parts) {
        if (!parts) return;
        for (const part of parts) {
          if (part.mimeType === "text/plain" && part.body?.data) {
            bodyText += Buffer.from(part.body.data, "base64url").toString(
              "utf-8"
            );
          } else if (part.mimeType === "text/html" && !bodyText && part.body?.data) {
            const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
            bodyText += html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          }

          if (part.filename && part.filename.length > 0) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              attachmentId: part.body?.attachmentId,
              size: part.body?.size || 0,
            });
          }

          if (part.parts) {
            extractParts(part.parts);
          }
        }
      }

      if (payload.parts) {
        extractParts(payload.parts);
      } else if (payload.body?.data) {
        bodyText = Buffer.from(payload.body.data, "base64url").toString("utf-8");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: messageId,
                subject: getHeader("Subject"),
                from: getHeader("From"),
                date: getHeader("Date"),
                body: bodyText.substring(0, 5000),
                attachments,
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
  "downloadAttachment",
  "Download a PDF attachment from an email. Saves the file to the downloads directory and returns the file path. Use the attachmentId from getEmailContent results.",
  {
    messageId: z.string().describe("The Gmail message ID"),
    attachmentId: z
      .string()
      .describe("The attachment ID (from getEmailContent results)"),
    filename: z
      .string()
      .describe("The filename to save as (from getEmailContent results)"),
  },
  async ({ messageId, attachmentId, filename }) => {
    try {
      const gmail = await getGmailClient();
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });

      const data = res.data.data;
      const buffer = Buffer.from(data, "base64url");

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(DOWNLOADS_DIR, safeName);

      writeFileSync(filePath, buffer);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                filePath,
                filename: safeName,
                size: buffer.length,
                message: `Attachment saved to ${filePath}`,
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
  "listStatementEmails",
  "List financial statement emails for a specific month. Searches for credit card statements, bank e-statements, loan statements, and other financial documents with PDF attachments.",
  {
    year: z.number().describe("Year (e.g., 2026)"),
    month: z
      .number()
      .min(1)
      .max(12)
      .describe("Month number (1-12)"),
    bank: z
      .string()
      .optional()
      .describe(
        "Optional bank/institution name to filter (e.g., 'HDFC', 'ICICI', 'SBI', 'Axis'). If omitted, searches all."
      ),
  },
  async ({ year, month, bank }) => {
    try {
      const gmail = await getGmailClient();

      const startDate = `${year}/${String(month).padStart(2, "0")}/01`;
      const endMonth = month === 12 ? 1 : month + 1;
      const endYear = month === 12 ? year + 1 : year;
      const endDate = `${endYear}/${String(endMonth).padStart(2, "0")}/01`;

      let query = `(subject:statement OR subject:e-statement OR subject:"account statement" OR subject:"bank statement" OR subject:"credit card") has:attachment after:${startDate} before:${endDate}`;
      if (bank) {
        query += ` (from:${bank} OR subject:${bank})`;
      }

      const res = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: 20,
      });

      const messages = res.data.messages || [];

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  results: [],
                  query,
                  message: `No statement emails found for ${year}-${String(month).padStart(2, "0")}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const results = await Promise.all(
        messages.map(async (msg) => {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "full",
            metadataHeaders: ["Subject", "From", "Date"],
          });

          const headers = detail.data.payload.headers;
          const getHeader = (name) =>
            headers.find((h) => h.name === name)?.value || "";

          const attachments = [];
          function findAttachments(parts) {
            if (!parts) return;
            for (const part of parts) {
              if (part.filename && part.filename.length > 0) {
                attachments.push({
                  filename: part.filename,
                  mimeType: part.mimeType,
                  attachmentId: part.body?.attachmentId,
                  size: part.body?.size || 0,
                });
              }
              if (part.parts) findAttachments(part.parts);
            }
          }
          if (detail.data.payload.parts) {
            findAttachments(detail.data.payload.parts);
          }

          let passwordHint = "";
          let bodyText = "";
          function extractBody(parts) {
            if (!parts) return;
            for (const part of parts) {
              if (part.mimeType === "text/plain" && part.body?.data) {
                bodyText += Buffer.from(part.body.data, "base64url").toString("utf-8");
              }
              if (part.parts) extractBody(part.parts);
            }
          }
          if (detail.data.payload.parts) {
            extractBody(detail.data.payload.parts);
          } else if (detail.data.payload.body?.data) {
            bodyText = Buffer.from(detail.data.payload.body.data, "base64url").toString("utf-8");
          }

          const pwPatterns = [
            /password[:\s]+.*?(\b[A-Z]{4}\d{4}\b)/i,
            /password[:\s]+(.*?)[\n\r]/i,
            /DOB\s*[\+\&]\s*PAN/i,
            /date of birth/i,
          ];
          for (const pattern of pwPatterns) {
            const match = bodyText.match(pattern);
            if (match) {
              passwordHint = match[0].trim();
              break;
            }
          }

          return {
            id: msg.id,
            subject: getHeader("Subject"),
            from: getHeader("From"),
            date: getHeader("Date"),
            attachments,
            passwordHint: passwordHint || "No password hint found in email body",
          };
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { results, total: results.length, query },
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
  console.error("[gmail-mcp] Server started on stdio transport");
}

main().catch((err) => {
  console.error("[gmail-mcp] Fatal error:", err);
  process.exit(1);
});
