import path from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = path.join(__dirname, "..");

const DATA_DIR = process.env.ESTATEMENT_MCP_HOME || path.join(os.homedir(), ".estatement-mcp");

export function getDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  return DATA_DIR;
}

export function getDownloadsDir() {
  const dir = process.env.DOWNLOADS_DIR || path.join(getDataDir(), "downloads");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getCredentialsPath() {
  return process.env.GOOGLE_CREDENTIALS_PATH || path.join(getDataDir(), "credentials.json");
}

export function getTokenPath() {
  return process.env.GOOGLE_TOKEN_PATH || path.join(getDataDir(), "token.json");
}

export function loadEnv() {
  const envPaths = [
    path.join(process.cwd(), ".env"),
    path.join(getDataDir(), ".env"),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return envPath;
    }
  }
  return null;
}

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/estatements";
}
