import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createServer } from "http";
import { createInterface } from "readline";
import { URL } from "url";
import open from "open";
import { getCredentialsPath, getTokenPath } from "../../lib/config.js";

const CREDENTIALS_PATH = getCredentialsPath();
const TOKEN_PATH = getTokenPath();

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const REDIRECT_URI = "http://localhost:3456";

function loadCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}.\n` +
      `Download it from Google Cloud Console and place it there, or run: npx estatement-mcp setup`
    );
  }
  const content = readFileSync(CREDENTIALS_PATH, "utf-8");
  const keys = JSON.parse(content);
  const { client_id, client_secret } = keys.installed || keys.web;
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

function loadSavedToken(oAuth2Client) {
  if (!existsSync(TOKEN_PATH)) return false;
  const token = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  oAuth2Client.setCredentials(token);
  return true;
}

function saveToken(token) {
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
  console.error(`[auth] Token saved to ${TOKEN_PATH}`);
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.error(`\n[auth] Visit this URL to authorize:\n`);
  console.error(authUrl);
  console.error();

  try {
    return await getTokenViaCallbackServer(oAuth2Client, authUrl);
  } catch (serverErr) {
    console.error(`[auth] Callback server failed: ${serverErr.message}`);
    console.error("[auth] Falling back to manual code entry...\n");
    return await getTokenViaManualEntry(oAuth2Client, authUrl);
  }
}

async function getTokenViaCallbackServer(oAuth2Client, authUrl) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, REDIRECT_URI);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Error: ${error}</h1>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Error: No authorization code received</h1>");
          return;
        }

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        saveToken(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>"
        );
        server.close();
        resolve(oAuth2Client);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Error</h1><pre>${err.message}</pre>`);
        server.close();
        reject(err);
      }
    });

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(3456, () => {
      console.error("[auth] Callback server listening on http://localhost:3456");
      open(authUrl).catch(() => {
        console.error("[auth] Could not open browser. Please visit the URL above.");
      });
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out after 2 minutes"));
    }, 120000);
  });
}

async function getTokenViaManualEntry(oAuth2Client, authUrl) {
  console.error("[auth] After authorizing in the browser, you'll be redirected to a page that may not load.");
  console.error("[auth] That's OK! Copy the FULL URL from your browser's address bar and paste it here.");
  console.error("[auth] It will look like: http://localhost:3456/?code=4/0Af...&scope=...\n");

  open(authUrl).catch(() => {});

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve, reject) => {
    rl.question("[auth] Paste the full redirect URL (or just the code): ", async (input) => {
      rl.close();
      try {
        let code = input.trim();

        if (code.startsWith("http")) {
          const url = new URL(code);
          code = url.searchParams.get("code");
        }

        if (!code) {
          reject(new Error("No authorization code provided."));
          return;
        }

        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        saveToken(tokens);
        resolve(oAuth2Client);
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function getAuthClient() {
  const oAuth2Client = loadCredentials();

  if (loadSavedToken(oAuth2Client)) {
    oAuth2Client.on("tokens", (tokens) => {
      if (tokens.refresh_token) {
        saveToken(tokens);
      } else {
        const existing = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
        saveToken({ ...existing, ...tokens });
      }
    });
    console.error("[auth] Using saved token");
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

export async function getGmailClient() {
  const auth = await getAuthClient();
  return google.gmail({ version: "v1", auth });
}

if (process.argv[1] && process.argv[1].endsWith("auth.js")) {
  getAuthClient()
    .then(() => {
      console.error("[auth] Authentication successful!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[auth] Authentication failed:", err.message);
      process.exit(1);
    });
}
