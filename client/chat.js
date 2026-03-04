import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Ollama } from "ollama";
import { createInterface } from "readline";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const MODEL = process.env.OLLAMA_MODEL || "qwen2.5";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const MAX_TOOL_ROUNDS = 10;

const SYSTEM_PROMPT = `You are a helpful financial assistant for analyzing e-statements. You have access to tools that let you:

1. **Gmail tools** — Search emails, download statement PDFs (credit card, bank, loan, etc.), find password hints
2. **Statement Processor tools** — Parse downloaded PDF statements, extract transactions, store in database. Supports credit card statements, bank account statements, loan statements, and more.
3. **Finance tools** — Query spending data: monthly totals, categories, merchants, comparisons, recurring payments

**Important workflow:**
- When asked about spending for a month, ALWAYS call \`checkDataAvailability\` first
- If data is NOT available, guide through: listStatementEmails → downloadAttachment → processStatement → then query
- Use the password hint from the email body when processing encrypted PDFs
- Present financial data in a clear, readable format with amounts in ₹

Be concise and helpful. Format currency amounts nicely.`;

const SERVER_CONFIGS = [
  {
    name: "gmail",
    command: "node",
    args: [path.join(ROOT, "gmail-mcp-server/src/index.js")],
    optional: true,
  },
  {
    name: "processor",
    command: "node",
    args: [path.join(ROOT, "statement-processor/src/index.js")],
    optional: true,
  },
  {
    name: "finance",
    command: "node",
    args: [path.join(ROOT, "finance-mcp-server/src/index.js")],
    optional: false,
  },
];

// toolName → { client, serverName }
const toolRegistry = new Map();
// All tools in Ollama format
let ollamaTools = [];

async function connectServer(config) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    stderr: "pipe",
  });

  const client = new Client(
    { name: `estatement-mcp-client-${config.name}`, version: "1.0.0" },
  );

  await client.connect(transport);
  return client;
}

function mcpToolToOllama(tool) {
  const params = tool.inputSchema || { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: {
        type: params.type || "object",
        properties: params.properties || {},
        required: params.required || [],
      },
    },
  };
}

async function initServers(serverNames) {
  const clients = [];

  const configs = serverNames
    ? SERVER_CONFIGS.filter((c) => serverNames.includes(c.name))
    : SERVER_CONFIGS;

  for (const config of configs) {
    try {
      process.stderr.write(`Connecting to ${config.name} server...`);
      const client = await connectServer(config);
      clients.push({ client, name: config.name });

      const { tools } = await client.listTools();
      for (const tool of tools) {
        toolRegistry.set(tool.name, { client, serverName: config.name });
        ollamaTools.push(mcpToolToOllama(tool));
      }
      process.stderr.write(` ${tools.length} tools loaded\n`);
    } catch (err) {
      if (config.optional) {
        process.stderr.write(` skipped (${err.message})\n`);
      } else {
        throw new Error(`Failed to start ${config.name} server: ${err.message}`);
      }
    }
  }

  if (ollamaTools.length === 0) {
    throw new Error("No tools available. Check that at least one MCP server can start.");
  }

  return clients;
}

async function callMcpTool(toolName, args) {
  const entry = toolRegistry.get(toolName);
  if (!entry) {
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  try {
    const result = await entry.client.callTool({ name: toolName, arguments: args });
    const textContent = result.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return textContent || JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

async function chat(ollama, messages) {
  let response = await ollama.chat({
    model: MODEL,
    messages,
    tools: ollamaTools,
  });

  let rounds = 0;
  while (response.message.tool_calls?.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    messages.push(response.message);

    for (const toolCall of response.message.tool_calls) {
      const fn = toolCall.function;
      process.stderr.write(`  → calling ${fn.name}(${JSON.stringify(fn.arguments).substring(0, 80)})\n`);

      const result = await callMcpTool(fn.name, fn.arguments);

      messages.push({
        role: "tool",
        content: result,
      });
    }

    response = await ollama.chat({
      model: MODEL,
      messages,
      tools: ollamaTools,
    });
  }

  return response.message.content;
}

async function cleanup(clients) {
  for (const { client } of clients) {
    try {
      await client.close();
    } catch {}
  }
}

export async function startChat(options = {}) {
  const ollama = new Ollama({ host: OLLAMA_HOST });

  // Verify Ollama is running and model is available
  try {
    await ollama.show({ model: MODEL });
  } catch (err) {
    if (err.message?.includes("ECONNREFUSED") || err.cause?.code === "ECONNREFUSED") {
      console.error(`\nCannot connect to Ollama at ${OLLAMA_HOST}`);
      console.error("Make sure Ollama is running: ollama serve\n");
      process.exit(1);
    }
    console.error(`\nModel "${MODEL}" not found. Pull it first:`);
    console.error(`  ollama pull ${MODEL}\n`);
    process.exit(1);
  }

  process.stderr.write(`\nUsing model: ${MODEL}\n`);
  process.stderr.write("Starting MCP servers...\n\n");

  const clients = await initServers(options.servers);

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  console.log("\nestatement-mcp chat");
  console.log(`Model: ${MODEL} | Tools: ${ollamaTools.length}`);
  console.log('Type your question (or "exit" to quit)\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        console.log("\nGoodbye!");
        rl.close();
        await cleanup(clients);
        process.exit(0);
      }

      if (trimmed === "/tools") {
        console.log("\nAvailable tools:");
        for (const [name, { serverName }] of toolRegistry) {
          console.log(`  [${serverName}] ${name}`);
        }
        console.log();
        askQuestion();
        return;
      }

      if (trimmed === "/clear") {
        messages.length = 1; // Keep system prompt
        console.log("Conversation cleared.\n");
        askQuestion();
        return;
      }

      messages.push({ role: "user", content: trimmed });

      try {
        const reply = await chat(ollama, messages);
        messages.push({ role: "assistant", content: reply });
        console.log(`\nAssistant: ${reply}\n`);
      } catch (err) {
        console.error(`\nError: ${err.message}\n`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

// Run directly
if (process.argv[1]?.endsWith("chat.js") || process.argv[1]?.endsWith("client/chat.js")) {
  const { loadEnv } = await import("../lib/config.js");
  loadEnv();
  startChat().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  });
}
