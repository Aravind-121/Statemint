# estatement-mcp

MCP servers for e-statement intelligence — fetch statements from Gmail, parse PDFs, and analyze spending patterns. Supports credit card statements, bank account statements, loan statements, and more.

## What it does

Three [Model Context Protocol](https://modelcontextprotocol.io/) servers that work together:

1. **Gmail MCP** — Search statement emails, download PDF attachments, extract password hints
2. **Statement Processor MCP** — Decrypt and parse financial PDFs, categorize transactions, store in PostgreSQL
3. **Finance MCP** — Query spending data: monthly totals, category breakdowns, merchant rankings, month comparisons, recurring payment detection

## Quick Start

```bash
# 1. Run setup wizard
npx estatement-mcp setup

# 2. Authenticate with Gmail
npx estatement-mcp auth

# 3. Create database tables
npx estatement-mcp migrate

# 4. Chat with your financial data
npx estatement-mcp chat
```

## Prerequisites

- **Node.js** >= 18
- **PostgreSQL** — running instance with an `estatements` database
- **Google Cloud OAuth credentials** — `credentials.json` from [Google Cloud Console](https://console.cloud.google.com/apis/credentials) with Gmail API enabled
- **Ollama** — for the local LLM chat interface (`brew install ollama` / [ollama.com](https://ollama.com))
- **qpdf** — for decrypting password-protected PDFs (`brew install qpdf` / `apt install qpdf`)
- **pdftotext** (optional) — for ICICI bank statements (`brew install poppler` / `apt install poppler-utils`)

## MCP Client Configuration

Add this to your MCP client config (Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "gmail-estatement": {
      "command": "npx",
      "args": ["-y", "estatement-mcp", "gmail"]
    },
    "statement-processor": {
      "command": "npx",
      "args": ["-y", "estatement-mcp", "processor"]
    },
    "finance-estatement": {
      "command": "npx",
      "args": ["-y", "estatement-mcp", "finance"]
    }
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `npx estatement-mcp setup` | Interactive first-time setup |
| `npx estatement-mcp auth` | Gmail OAuth authentication |
| `npx estatement-mcp migrate` | Create database tables |
| `npx estatement-mcp chat` | Interactive chat with Ollama (qwen2.5) |
| `npx estatement-mcp gmail` | Start Gmail MCP server |
| `npx estatement-mcp processor` | Start Statement Processor MCP server |
| `npx estatement-mcp finance` | Start Finance MCP server |
| `npx estatement-mcp config` | Show current configuration |

## Supported Statement Types

| Type | Auto-detected | Description |
|------|:---:|-------------|
| `credit_card` | Yes | Credit card statements |
| `bank_account` | Yes | Savings / current account statements |
| `loan` | Yes | Loan / EMI statements |
| `insurance` | Yes | Insurance premium statements |
| `utility` | Yes | Electricity, gas, broadband bills |
| `other` | Fallback | Any other PDF with transactions |

## Chat with Ollama

The `chat` command starts an interactive session that connects all three MCP servers to a local Ollama model. It automatically:

- Spawns the Gmail, Statement Processor, and Finance MCP servers
- Discovers all available tools from each server
- Converts them to Ollama's tool-calling format
- Routes tool calls from the LLM to the correct MCP server
- Feeds results back for natural language responses

```bash
# Make sure Ollama is running
ollama serve

# Pull qwen2.5 (default model)
ollama pull qwen2.5

# Start chatting
npx estatement-mcp chat
```

In-chat commands:
- `/tools` — list all available tools
- `/clear` — clear conversation history
- `exit` — quit

Use a different model or Ollama host:
```bash
OLLAMA_MODEL=llama3.1 npx estatement-mcp chat
OLLAMA_HOST=http://remote-server:11434 npx estatement-mcp chat
```

## Data Directory

All data is stored in `~/.estatement-mcp/` by default:

```
~/.estatement-mcp/
├── .env              # Database URL and settings
├── credentials.json  # Google OAuth credentials
├── token.json        # Saved OAuth token
└── downloads/        # Downloaded PDF statements
```

Override with the `ESTATEMENT_MCP_HOME` environment variable.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ESTATEMENT_MCP_HOME` | `~/.estatement-mcp` | Data directory |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/estatements` | PostgreSQL connection |
| `DOWNLOADS_DIR` | `~/.estatement-mcp/downloads` | PDF download location |
| `GOOGLE_CREDENTIALS_PATH` | `~/.estatement-mcp/credentials.json` | OAuth credentials file |
| `GOOGLE_TOKEN_PATH` | `~/.estatement-mcp/token.json` | OAuth token file |
| `OLLAMA_MODEL` | `qwen2.5` | Ollama model for chat |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint |

## Available MCP Tools

### Gmail MCP (`gmail`)
- `searchEmails` — Search Gmail with custom queries
- `getEmailContent` — Get full email body and attachment list
- `downloadAttachment` — Save PDF attachments to disk
- `listStatementEmails` — Find statements for a specific month with password hints

### Statement Processor MCP (`processor`)
- `processStatement` — Parse a single PDF statement (auto-detects type)
- `processAllStatements` — Bulk-process all PDFs in downloads
- `listDownloadedPDFs` — List available PDF files

### Finance MCP (`finance`)
- `checkDataAvailability` — Check if data exists for a month (call this first)
- `getMonthlySpend` — Total spend for a month
- `getCategorySpend` — Spending by category
- `getTopMerchants` — Top merchants by spend
- `compareMonths` — Compare spending between two months
- `detectRecurringPayments` — Find subscriptions and recurring charges
- `getTransactions` — Query individual transactions with filters
- `getSpendingSummary` — High-level overview across all data

## Supported Banks

HDFC, ICICI, SBI, Axis, Kotak, RBL, IndusInd, IDFC, Yes Bank, Amex, Citi, HSBC, Standard Chartered, AU Small Finance Bank.

## License

ISC
