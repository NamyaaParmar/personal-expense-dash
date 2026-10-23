// Supabase Edge Function: parse-sms
//
// Receives a raw bank SMS from the SMS Relay Android app:
//   POST /functions/v1/parse-sms
//   Authorization: Bearer <WEBHOOK_SECRET>
//   {"sender":"HDFCBK","sms":"Sent Rs.366.59\nFrom HDFC Bank ..."}
//
// It extracts the amount, direction, merchant and date, then inserts a row into
// `transactions` with the service-role key (bypassing RLS). Duplicate SMS bodies
// are ignored, so re-delivery is safe.

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/swiggy|zomato|dominos|pizza|restaurant|cafe|coffee|chai|food/i, "Food"],
  [/zepto|blinkit|bigbasket|dmart|grofers|instamart|grocer/i, "Groceries"],
  [/uber|ola|rapido|metro|irctc|indigo|airlines|petrol|fuel/i, "Transport"],
  [/amazon|flipkart|myntra|ajio|meesho|nykaa|decathlon/i, "Shopping"],
  [/electricity|water bill|gas bill|broadband|rent|landlord|maintenance/i, "Household"],
  [/pharmacy|apollo|medplus|hospital|clinic|doctor/i, "Health"],
  [/netflix|spotify|prime video|hotstar|youtube premium|icloud|subscription/i, "Subscriptions"],
  [/nifty|mutual fund|sip|groww|zerodha|upstox|coin|indmoney/i, "Investment"],
];

export function categoryFor(merchant: string): string | null {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(merchant)) return cat;
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function normalise(raw: string): string {
  return raw
    // Strip a forwarded WhatsApp prefix: "[1:03 am, 24/10/2026] Namyaa ✨: "
    .replace(/^\s*\[[^\]]*\]\s*[^:\n]{1,80}:\s*/, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function parseAmount(sms: string): { amount: number; type: "debit" | "credit" } | null {
  const num = String.raw`([\d,]+(?:\.\d{1,2})?)`;

  // HDFC UPI debit: "Sent Rs.366.59"
  let m = sms.match(new RegExp(String.raw`Sent\s+Rs\.?\s*${num}`, "i"));
  if (m) return { amount: toNumber(m[1]), type: "debit" };

  // Generic debit: "Rs.500 debited", "debited by Rs.500", "Rs.500 withdrawn"
  m = sms.match(new RegExp(String.raw`Rs\.?\s*${num}\s*(?:has been\s*)?(?:debited|withdrawn|spent)`, "i"))
    || sms.match(new RegExp(String.raw`(?:debited|withdrawn|spent)(?:\s+by)?\s+Rs\.?\s*${num}`, "i"));
  if (m) return { amount: toNumber(m[1]), type: "debit" };

  // Credit: "Rs.700.00 credited", "credited with Rs.700"
  m = sms.match(new RegExp(String.raw`Rs\.?\s*${num}\s*(?:has been\s*)?credited`, "i"))
    || sms.match(new RegExp(String.raw`credited(?:\s+with)?\s+Rs\.?\s*${num}`, "i"));
  if (m) return { amount: toNumber(m[1]), type: "credit" };

  return null;
}

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

export function parseMerchant(sms: string, type: "debit" | "credit"): string {
  if (type === "debit") {
    // "To Sainik Seva Service\nOn 23/10/26"
    const m = sms.match(/\bTo\s+([^\n]+?)\s*(?:\n|$)/i);
    if (m) return m[1].replace(/\s+/g, " ").trim();
  } else {
    // "from VPA *9349@upi (UPI 185642593820)"
    const m = sms.match(/\bfrom\s+(VPA\s+[^\s(]+|[^\s(]+)\s*(?:\(|$)/i);
    if (m) return m[1].replace(/\s+/g, " ").trim();
  }
  // Fallback: "Info: UPI/..." or the first meaningful line after the amount.
  const info = sms.match(/\bInfo[:\s]+([^\n]+)/i);
  if (info) return info[1].trim();
  return "Bank transaction";
}

export function parseDate(sms: string): string {
  const m = sms.match(/\bon\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/i)
    || sms.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return new Date().toISOString().slice(0, 10); // fall back to today
}

export function isBankSender(sender: string): boolean {
  const s = sender.toUpperCase();
  return s.includes("HDFC") || s.includes("IDFC") || s.includes("ICICI") ||
    s.includes("SBI") || s.includes("AXIS") || s.includes("KOTAK") ||
    s.includes("YESBANK") || s.includes("BOB") || s.includes("PNB");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const expected = Deno.env.get("WEBHOOK_SECRET");
  const auth = req.headers.get("Authorization") || "";
  if (!expected || auth !== `Bearer ${expected}`) {
    return json({ error: "unauthorized" }, 401);
  }

  let payload: { sender?: string; sms?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const sender = String(payload.sender || "").trim();
  const raw = String(payload.sms || "");
  if (!raw.trim()) return json({ error: "missing sms" }, 400);

  const sms = normalise(raw);

  // OTPs, promos and balance-only alerts are acknowledged but not stored.
  if (/OTP|one[- ]time password|do not share/i.test(sms)) {
    return json({ ok: true, ignored: "otp" });
  }
  if (!isBankSender(sender) && !/HDFC|IDFC|ICICI|SBI|AXIS|KOTAK/i.test(sms)) {
    return json({ ok: true, ignored: "sender" });
  }

  const parsed = parseAmount(sms);
  if (!parsed) return json({ ok: true, ignored: "unrecognised" });

  const merchant = parseMerchant(sms, parsed.type);
  const txnDate = parseDate(sms);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  // Idempotency: relay retries and forwarded copies should not duplicate rows.
  const dupe = await fetch(
    `${supabaseUrl}/rest/v1/transactions?select=id&sms_raw=eq.${encodeURIComponent(sms)}&limit=1`,
    { headers },
  );
  if (dupe.ok) {
    const rows = await dupe.json();
    if (Array.isArray(rows) && rows.length > 0) {
      return json({ ok: true, duplicate: true, id: rows[0].id });
    }
  }

  const row = {
    type: parsed.type,
    amount: parsed.amount,
    category: categoryFor(merchant),
    merchant_raw: merchant.toUpperCase(),
    merchant_display: merchant,
    note: null,
    txn_date: txnDate,
    sms_raw: sms,
    is_reimbursable: false,
  };

  const res = await fetch(`${supabaseUrl}/rest/v1/transactions`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    return json({ error: "insert failed", detail: await res.text() }, 502);
  }
  const inserted = await res.json();
  return json({ ok: true, transaction: inserted[0] ?? null });
});
