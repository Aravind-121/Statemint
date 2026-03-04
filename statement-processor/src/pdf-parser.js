import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import path from "path";
import pdf from "pdf-parse/lib/pdf-parse.js";

/**
 * Parse a financial statement PDF and extract transactions.
 *
 * Supports credit card statements, bank account statements, and other
 * e-statements from Indian banks (HDFC, ICICI, SBI, Axis, etc.)
 *
 * @param {string} filePath - Path to the PDF file
 * @param {string} [password] - Password to decrypt the PDF (if protected)
 * @returns {Promise<{transactions: Array, summary: Object, rawText: string}>}
 */
export async function parsePDF(filePath, password) {
  let buffer;
  let decryptedPath = null;

  if (password) {
    decryptedPath = path.join(tmpdir(), `decrypted_${Date.now()}.pdf`);
    try {
      execSync(
        `qpdf --password="${password}" --decrypt "${filePath}" "${decryptedPath}"`,
        { stdio: "pipe" }
      );
    } catch (err) {
      if (err.status === 3) {
        // Warnings only — file was still created successfully
      } else {
        try { unlinkSync(decryptedPath); } catch {}
        decryptedPath = null;
        const stderr = err.stderr?.toString() || err.message;
        if (stderr.includes("invalid password")) {
          throw new Error("Invalid password. Please check and try again.");
        }
        throw new Error(`Failed to decrypt PDF: ${stderr}`);
      }
    }
    try {
      buffer = readFileSync(decryptedPath);
    } catch {
      decryptedPath = null;
      throw new Error("Decryption failed — output file not created. Is the password correct?");
    }
  } else {
    buffer = readFileSync(filePath);
  }

  let data;
  try {
    data = await pdf(buffer);
  } catch (err) {
    if (err.message?.includes("password") || err.message?.includes("encrypt")) {
      throw new Error(
        `PDF is password-protected. Please provide the password. Original error: ${err.message}`
      );
    }
    throw err;
  }

  const rawText = data.text;
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

  const transactions = [];
  const summary = {
    totalPages: data.numpages,
    statementType: detectStatementType(rawText),
    bank: detectBank(rawText),
    cardLast4: extractCardLast4(rawText),
    accountNumber: extractAccountNumber(rawText),
    statementMonth: extractStatementMonth(rawText),
    totalDue: extractAmount(rawText, /total\s*(amount\s*)?due[:\s]*[\u20B9Rs.]*\s*([\d,]+\.?\d*)/i),
    minDue: extractAmount(rawText, /minimum\s*(amount\s*)?due[:\s]*[\u20B9Rs.]*\s*([\d,]+\.?\d*)/i),
    dueDate: extractDate(rawText, /(?:payment\s*)?due\s*date[:\s]*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i),
  };

  // Pattern 1: DD/MM/YYYY  Description  Amount (common for HDFC, ICICI)
  const pattern1 = /^(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\s+(.+?)\s+([\d,]+\.\d{2})\s*(Cr|Dr|CR|DR)?$/;

  // Pattern 2: DD Mon YYYY  Description  Amount
  const pattern2 =
    /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{2,4})\s+(.+?)\s+([\d,]+\.\d{2})\s*(Cr|Dr|CR|DR)?$/i;

  // Pattern 3: DD-Mon-YY  Description  Amount (SBI style)
  const pattern3 =
    /^(\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2,4})\s+(.+?)\s+([\d,]+\.\d{2})\s*(Cr|Dr|CR|DR)?$/i;

  for (const line of lines) {
    let match = line.match(pattern1) || line.match(pattern2) || line.match(pattern3);
    if (match) {
      const [, dateStr, description, amountStr, crDr] = match;
      const amount = parseFloat(amountStr.replace(/,/g, ""));
      const isCredit =
        crDr?.toLowerCase() === "cr" ||
        description.toLowerCase().includes("payment") ||
        description.toLowerCase().includes("refund") ||
        description.toLowerCase().includes("reversal");

      transactions.push({
        date: normalizeDate(dateStr),
        description: description.trim(),
        merchantRaw: description.trim(),
        amount,
        type: isCredit ? "credit" : "debit",
      });
    }
  }

  // If no transactions found with line-by-line, try bank-specific parsers
  if (transactions.length === 0) {
    const bank = summary.bank;

    if (bank === "ICICI") {
      const pdfPath = decryptedPath || filePath;
      extractICICITransactions(pdfPath, transactions);
    }
  }

  // If still no transactions, do a broader regex scan
  if (transactions.length === 0) {
    const broadPattern =
      /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\s+(.{5,60}?)\s+([\d,]+\.\d{2})/g;
    let m;
    while ((m = broadPattern.exec(rawText)) !== null) {
      const [, dateStr, description, amountStr] = m;
      const amount = parseFloat(amountStr.replace(/,/g, ""));
      const isCredit =
        description.toLowerCase().includes("payment") ||
        description.toLowerCase().includes("refund") ||
        description.toLowerCase().includes("reversal");

      transactions.push({
        date: normalizeDate(dateStr),
        description: description.trim(),
        merchantRaw: description.trim(),
        amount,
        type: isCredit ? "credit" : "debit",
      });
    }
  }

  // Clean up decrypted temp file
  if (decryptedPath) {
    try { unlinkSync(decryptedPath); } catch {}
  }

  return { transactions, summary, rawText };
}

// ─── ICICI-Specific Parser ───────────────────────────────────────────────────

/**
 * Extract transactions from ICICI Bank credit card statements.
 *
 * Uses `pdftotext -layout` to preserve column spacing, which cleanly separates
 * the Reward Points column from the Amount column (pdf-parse concatenates them).
 *
 * Layout columns: Date | SerNo | Transaction Details | RP | Intl.# | Amount (in ₹)
 *
 * @param {string} pdfPath - Path to the (already-decrypted) PDF file
 * @param {Array} transactions - Array to push parsed transactions into
 */
function extractICICITransactions(pdfPath, transactions) {
  let layoutText;
  try {
    layoutText = execSync(
      `pdftotext -layout "${pdfPath}" -`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (err) {
    console.error("pdftotext failed:", err.message);
    return;
  }

  const txnRegex =
    /(\d{2}\/\d{2}\/\d{4})\s+(\d{10,14})\s+(.+?)\s{2,}(\d+)\s+(?:\*?[\d,.]+\s+[A-Z]{3}\s+)?([\d,]+\.\d{2})(\s+CR)?/g;

  let match;
  while ((match = txnRegex.exec(layoutText)) !== null) {
    const [, dateStr, , descRaw, , amountStr, crFlag] = match;

    let description = descRaw.trim()
      .replace(/\s+/g, " ")
      .replace(/[`\u20B9]+/g, "")
      .trim();

    if (
      description.includes("DateSerNo") ||
      description.includes("Page ") ||
      description.length < 3
    ) {
      continue;
    }

    const amount = parseFloat(amountStr.replace(/,/g, ""));
    if (isNaN(amount) || amount === 0) continue;

    const isCredit = !!crFlag ||
      description.toLowerCase().includes("payment received") ||
      description.toLowerCase().includes("payment - thank") ||
      description.toLowerCase().includes("refund") ||
      description.toLowerCase().includes("reversal") ||
      description.toLowerCase().includes("cashback");

    transactions.push({
      date: normalizeDate(dateStr),
      description,
      merchantRaw: description,
      amount,
      type: isCredit ? "credit" : "debit",
    });
  }
}

// ─── Statement Type Detection ────────────────────────────────────────────────

function detectStatementType(text) {
  if (/credit\s*card|card\s*statement|card\s*no|card\s*number|reward\s*point/i.test(text)) {
    return "credit_card";
  }
  if (/savings\s*account|current\s*account|account\s*statement|passbook|cheque/i.test(text)) {
    return "bank_account";
  }
  if (/loan\s*statement|emi\s*schedule|loan\s*account|disbursement|outstanding\s*principal/i.test(text)) {
    return "loan";
  }
  if (/insurance|policy\s*no|premium|sum\s*assured|nominee/i.test(text)) {
    return "insurance";
  }
  if (/electricity|water\s*bill|gas\s*bill|broadband|telecom|utility/i.test(text)) {
    return "utility";
  }
  return "other";
}

function extractAccountNumber(text) {
  const match =
    text.match(/account\s*(?:no|number|#)?\.?\s*:?\s*(\d{8,18})/i) ||
    text.match(/a\/c\s*(?:no)?\.?\s*:?\s*(\d{8,18})/i);
  return match ? match[1] : null;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function detectBank(text) {
  const banks = [
    { name: "HDFC", pattern: /hdfc/i },
    { name: "ICICI", pattern: /icici/i },
    { name: "SBI", pattern: /state bank|sbi card/i },
    { name: "Axis", pattern: /axis bank/i },
    { name: "Kotak", pattern: /kotak/i },
    { name: "RBL", pattern: /rbl/i },
    { name: "IndusInd", pattern: /indusind/i },
    { name: "IDFC", pattern: /idfc/i },
    { name: "Yes Bank", pattern: /yes bank/i },
    { name: "Amex", pattern: /american express|amex/i },
    { name: "Citi", pattern: /citibank|citi\b/i },
    { name: "HSBC", pattern: /hsbc/i },
    { name: "Standard Chartered", pattern: /standard chartered|sc\b/i },
    { name: "AU Small Finance", pattern: /au small finance|au bank/i },
  ];

  for (const bank of banks) {
    if (bank.pattern.test(text)) return bank.name;
  }
  return "Unknown";
}

function extractCardLast4(text) {
  const match =
    text.match(/(?:\*{4}|\bx{4}|\bX{4})\s*(\d{4})/i) ||
    text.match(/card\s*(?:no|number|#)?\.?\s*:?\s*\d{4}\s*\d{4}\s*\d{4}\s*(\d{4})/i) ||
    text.match(/ending\s*(?:with|in)?\s*(\d{4})/i);

  return match ? match[1] : null;
}

function extractStatementMonth(text) {
  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    january: "01", february: "02", march: "03", april: "04",
    june: "06", july: "07", august: "08", september: "09",
    october: "10", november: "11", december: "12",
  };

  const match = text.match(
    /(?:statement\s*(?:for|period|date)?[:\s]*)?(\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b)[,\s-]*(\d{4})/i
  );

  if (match) {
    const monthNum = months[match[1].toLowerCase()];
    return `${match[2]}-${monthNum}-01`;
  }
  return null;
}

function extractAmount(text, pattern) {
  const match = text.match(pattern);
  if (match) {
    return parseFloat(match[2].replace(/,/g, ""));
  }
  return null;
}

function extractDate(text, pattern) {
  const match = text.match(pattern);
  if (match) {
    return normalizeDate(match[1]);
  }
  return null;
}

function normalizeDate(dateStr) {
  let match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (match) {
    let [, day, month, year] = match;
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  match = dateStr.match(
    /^(\d{1,2})[\s-]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[\s-]*(\d{2,4})$/i
  );
  if (match) {
    let [, day, mon, year] = match;
    if (year.length === 2) year = `20${year}`;
    const monthNum = months[mon.toLowerCase()];
    return `${year}-${monthNum}-${day.padStart(2, "0")}`;
  }

  return dateStr;
}
