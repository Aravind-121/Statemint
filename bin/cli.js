#!/usr/bin/env node

import path from "path";
import { fileURLToPath } from "url";
import { existsSync, copyFileSync, writeFileSync, readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const command = process.argv[2];

const HELP = `
estatement-mcp — MCP servers for e-statement intelligence

Usage:
  estatement-mcp <command>

Commands:
  chat         Interactive chat with Ollama + MCP tools (default: qwen2.5)
  gmail        Start the Gmail MCP server (stdio transport)
  processor    Start the Statement Processor MCP server (stdio transport)
  finance      Start the Finance MCP server (stdio transport)
  auth         Run Gmail OAuth2 authentication flow
  migrate      Create database tables
  setup        Interactive first-time setup
  config       Show current configuration paths
  help         Show this help message

Environment:
  ESTATEMENT_MCP_HOME    Data directory (default: ~/.estatement-mcp)
  DATABASE_URL           PostgreSQL connection string
  DOWNLOADS_DIR          PDF downloads directory
  GOOGLE_CREDENTIALS_PATH  Path to Google OAuth credentials.json
  GOOGLE_TOKEN_PATH        Path to saved OAuth token
  OLLAMA_MODEL           Model to use for chat (default: qwen2.5)
  OLLAMA_HOST            Ollama API URL (default: http://localhost:11434)

Examples:
  npx estatement-mcp setup          # First-time setup
  npx estatement-mcp auth           # Authenticate with Gmail
  npx estatement-mcp chat           # Chat with your financial data
  npx estatement-mcp gmail          # Start Gmail MCP server
  npx estatement-mcp processor      # Start Statement Processor MCP server
  npx estatement-mcp finance        # Start Finance MCP server
`;

async function main() {
  const { loadEnv, getDataDir, getCredentialsPath, getTokenPath, getDownloadsDir, getDatabaseUrl } =
    await import("../lib/config.js");

  switch (command) {
    case "chat": {
      loadEnv();
      const { startChat } = await import("../client/chat.js");
      await startChat();
      break;
    }

    case "gmail": {
      loadEnv();
      await import("../gmail-mcp-server/src/index.js");
      break;
    }

    case "processor": {
      loadEnv();
      await import("../statement-processor/src/index.js");
      break;
    }

    case "finance": {
      loadEnv();
      await import("../finance-mcp-server/src/index.js");
      break;
    }

    case "auth": {
      loadEnv();
      await import("../gmail-mcp-server/src/auth.js");
      break;
    }

    case "migrate": {
      loadEnv();
      const { migrate, close } = await import("../statement-processor/src/db.js");
      await migrate();
      await close();
      break;
    }

    case "setup": {
      await runSetup(getDataDir, getCredentialsPath, getDownloadsDir, getDatabaseUrl);
      break;
    }

    case "config": {
      const envPath = loadEnv();
      console.log("\nestatement-mcp configuration:\n");
      console.log(`  Data directory:   ${getDataDir()}`);
      console.log(`  Downloads:        ${getDownloadsDir()}`);
      console.log(`  Credentials:      ${getCredentialsPath()}`);
      console.log(`  Token:            ${getTokenPath()}`);
      console.log(`  Database URL:     ${getDatabaseUrl()}`);
      console.log(`  .env loaded from: ${envPath || "(none found)"}`);
      console.log();
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      console.log(HELP);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
    }
  }
}

async function runSetup(getDataDir, getCredentialsPath, getDownloadsDir, getDatabaseUrl) {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   estatement-mcp — First Time Setup         ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const dataDir = getDataDir();
  console.log(`Data directory: ${dataDir}\n`);

  const defaultDb = getDatabaseUrl();
  const dbUrl =
    (await ask(`PostgreSQL URL [${defaultDb}]: `)).trim() || defaultDb;

  const defaultDownloads = getDownloadsDir();
  const downloadsDir =
    (await ask(`PDF downloads directory [${defaultDownloads}]: `)).trim() || defaultDownloads;

  const credPath = getCredentialsPath();
  if (!existsSync(credPath)) {
    console.log(`\nGoogle OAuth credentials not found at: ${credPath}`);
    console.log("Download credentials.json from Google Cloud Console:");
    console.log("  https://console.cloud.google.com/apis/credentials\n");
    const srcPath = (await ask("Path to your credentials.json (or press Enter to skip): ")).trim();
    if (srcPath && existsSync(srcPath)) {
      copyFileSync(srcPath, credPath);
      console.log(`Copied to ${credPath}`);
    }
  } else {
    console.log(`\nGoogle credentials found at: ${credPath}`);
  }

  const envPath = path.join(dataDir, ".env");
  const envContent = `DATABASE_URL=${dbUrl}\nDOWNLOADS_DIR=${downloadsDir}\n`;
  writeFileSync(envPath, envContent);
  console.log(`\nConfiguration saved to: ${envPath}`);

  console.log("\n── MCP Client Configuration ──────────────────\n");
  console.log("Add this to your MCP client config (e.g. Cursor, Claude Desktop):\n");

  const mcpConfig = {
    mcpServers: {
      "gmail-estatement": {
        command: "npx",
        args: ["-y", "estatement-mcp", "gmail"],
      },
      "statement-processor": {
        command: "npx",
        args: ["-y", "estatement-mcp", "processor"],
      },
      "finance-estatement": {
        command: "npx",
        args: ["-y", "estatement-mcp", "finance"],
      },
    },
  };

  console.log(JSON.stringify(mcpConfig, null, 2));

  console.log("\n── Next Steps ────────────────────────────────\n");
  console.log("  1. Run: npx estatement-mcp auth");
  console.log("     (Authenticate with Gmail)\n");
  console.log("  2. Run: npx estatement-mcp migrate");
  console.log("     (Create database tables)\n");
  console.log("  3. Add the MCP config above to your client\n");

  rl.close();
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
