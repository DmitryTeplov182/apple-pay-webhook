import { ensurePaymentCurrency, ensureSeller, handleAdmin, parseSerbianAmount } from "./portal.js";
import { ensurePaymentExport, exportPendingPayments, syncZenmoneyTags } from "./zenmoney.js";

const TELEGRAM_TEXT_LIMIT = 4000;
const SYNC_BUTTON = "Sync categories";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok" }, 200);
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, ctx, url);
    }

    const telegramMatch = url.pathname.match(/^\/t\/([^/]+)$/);
    if (telegramMatch && request.method === "POST") {
      return handleTelegram(request, telegramMatch[1], env, ctx);
    }

    const zenmoneyMatch = url.pathname.match(/^\/z\/([^/]+)$/);
    if (zenmoneyMatch && request.method === "POST") {
      return syncCategories(zenmoneyMatch[1], env, ctx);
    }

    const webhookMatch = url.pathname.match(/^\/w\/([^/]+)$/);
    if (!webhookMatch || request.method !== "POST") {
      return json({ detail: "Not Found" }, 404);
    }

    if (!webhookIdConfigured(env.WEBHOOK_ID)) {
      console.error(
        "ERROR: WEBHOOK_ID must be exactly 64 lowercase hex characters.",
      );
      return json({ ok: false }, 500);
    }

    if (!idsMatch(webhookMatch[1], env.WEBHOOK_ID.trim())) {
      return json({ detail: "Not Found" }, 404);
    }

    const record = await capture(request, url);
    logRequest(record);

    let paymentId = null;
    try {
      paymentId = await store(env, record);
    } catch (error) {
      console.error(
        "failed to write D1 requests:",
        error instanceof Error ? error.message : "write error",
      );
      ctx.waitUntil(notifyTelegram(env, record));
      return json({ ok: false }, 500);
    }

    ctx.waitUntil(deliver(env, record, url.origin, paymentId));
    return json({ ok: true }, 200);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncAndNotify(env, false));
  },
};

function webhookIdConfigured(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value.trim());
}

function idsMatch(candidate, expected) {
  if (candidate.length !== expected.length) {
    return false;
  }
  const left = new TextEncoder().encode(candidate);
  const right = new TextEncoder().encode(expected);
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }
  return diff === 0;
}

async function capture(request, url) {
  const contentType = request.headers.get("content-type");
  const bodyRequest = request.clone();
  const bytes = new Uint8Array(await bodyRequest.arrayBuffer());
  const { rawBody, rawBodyEncoding } = decodeBody(bytes);

  return {
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    method: request.method,
    path: url.pathname,
    content_type: contentType,
    query: queryAsReceived(url),
    headers: headersAsReceived(request.headers),
    raw_body: rawBody,
    raw_body_encoding: rawBodyEncoding,
    json: parseJsonBody(rawBody, rawBodyEncoding),
    form: await parseForm(request, contentType),
  };
}

function decodeBody(bytes) {
  try {
    return {
      rawBody: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      rawBodyEncoding: "utf-8",
    };
  } catch {
    return {
      rawBody: bytesToBase64(bytes),
      rawBodyEncoding: "base64",
    };
  }
}

function parseJsonBody(rawBody, encoding) {
  if (encoding !== "utf-8" || rawBody === "") {
    return null;
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

async function parseForm(request, contentType) {
  const media = (contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (
    media !== "application/x-www-form-urlencoded" &&
    media !== "multipart/form-data"
  ) {
    return null;
  }

  try {
    const form = await request.formData();
    const items = [];
    for (const [name, value] of form.entries()) {
      if (value instanceof File) {
        const bytes = new Uint8Array(await value.arrayBuffer());
        const decoded = decodeBody(bytes);
        items.push({
          name,
          filename: value.name,
          content_type: value.type || null,
          value: decoded.rawBody,
          encoding: decoded.rawBodyEncoding,
        });
      } else {
        items.push({ name, value });
      }
    }
    return items;
  } catch (error) {
    console.error(
      "failed to parse form body; raw body is still stored:",
      error instanceof Error ? error.message : "form error",
    );
    return null;
  }
}

function headersAsReceived(headers) {
  const result = {};
  for (const [name, value] of headers.entries()) {
    const existing = result[name];
    if (existing === undefined) {
      result[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[name] = [existing, value];
    }
  }
  return result;
}

function queryAsReceived(url) {
  const result = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

function logRequest(record) {
  const contentType = record.content_type === null ? "null" : record.content_type;
  const parsedJson =
    record.json === null ? "null" : JSON.stringify(record.json, null, 2);
  const form = record.form === null ? "null" : JSON.stringify(record.form, null, 2);
  console.log(
    [
      "=== Incoming Wallet Request ===",
      `Time: ${record.timestamp}`,
      `Method: ${record.method}`,
      `Path: ${record.path}`,
      `Content-Type: ${contentType}`,
      "",
      "Headers:",
      JSON.stringify(record.headers, null, 2),
      "",
      "Query:",
      JSON.stringify(record.query, null, 2),
      "",
      `Raw body encoding: ${record.raw_body_encoding}`,
      "Raw body:",
      record.raw_body,
      "",
      "Parsed JSON:",
      parsedJson,
      "",
      "Form:",
      form,
      "================================",
    ].join("\n"),
  );
}

async function store(env, record) {
  const requestInsert = env.DB.prepare(
    `INSERT INTO requests (
      timestamp, method, path, content_type, query, headers,
      raw_body, raw_body_encoding, "json", form
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.timestamp,
      record.method,
      record.path,
      record.content_type,
      JSON.stringify(record.query),
      JSON.stringify(record.headers),
      record.raw_body,
      record.raw_body_encoding,
      record.json === null ? null : JSON.stringify(record.json),
      record.form === null ? null : JSON.stringify(record.form),
    );

  const payment = paymentFromRecord(record);
  if (!payment) {
    await requestInsert.run();
    return null;
  }

  const categoryId = await ensureSeller(env, payment.name, payment.merchant);
  await ensurePaymentCurrency(env);
  await ensurePaymentExport(env);
  const paymentInsert = env.DB.prepare(
    `INSERT INTO payments (
      created_at, amount, currency, "transaction", name, card, merchant, category_id,
      zenmoney_pending, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      record.timestamp,
      payment.amount,
      payment.currency,
      payment.transaction,
      payment.name,
      payment.card,
      payment.merchant,
      categoryId,
      JSON.stringify(payment),
    );
  const inserted = await env.DB.batch([requestInsert, paymentInsert]);
  return inserted[1]?.meta?.last_row_id || null;
}

async function deliver(env, record, origin, paymentId) {
  if (paymentId) {
    await exportPendingPayments(env);
  }
  await notifyTelegram(env, record);
  await notifyPayment(env, record, origin, paymentId);
}

function formatPaymentTime(iso, timeZone) {
  const zone = (timeZone || "").trim() || "UTC";
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${value("day")}-${value("month")}-${value("year")} ${value("hour")}:${value("minute")}`;
  } catch (error) {
    console.error(
      "invalid TIMEZONE, using UTC:",
      error instanceof Error ? error.message : "timezone error",
    );
    if (zone !== "UTC") {
      return formatPaymentTime(iso, "UTC");
    }
    return iso;
  }
}

function paymentFromRecord(record) {
  const body = record.json;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const fields = ["amount", "transaction", "name", "card", "merchant"];
  const text = (key) => (body[key] == null ? "" : String(body[key]).trim());
  if (!fields.every((key) => text(key) !== "")) {
    return null;
  }
  const parsedAmount = parseSerbianAmount(text("amount"));
  return {
    amount: parsedAmount.amount,
    currency: parsedAmount.currency,
    transaction: text("transaction"),
    name: text("name"),
    card: text("card"),
    merchant: text("merchant"),
  };
}

async function syncCategories(candidate, env, ctx) {
  if (!webhookIdConfigured(env.WEBHOOK_ID)) {
    console.error(
      "ERROR: WEBHOOK_ID must be exactly 64 lowercase hex characters.",
    );
    return json({ ok: false }, 500);
  }
  if (!idsMatch(candidate, env.WEBHOOK_ID.trim())) {
    return json({ detail: "Not Found" }, 404);
  }

  try {
    const count = await syncAndNotify(env, true);
    return json({ ok: true, tags: count }, 200);
  } catch {
    return json({ ok: false }, 500);
  }
}

async function handleTelegram(request, candidate, env, ctx) {
  if (!webhookIdConfigured(env.WEBHOOK_ID)) {
    console.error(
      "ERROR: WEBHOOK_ID must be exactly 64 lowercase hex characters.",
    );
    return json({ ok: false }, 500);
  }
  if (!idsMatch(candidate, env.WEBHOOK_ID.trim())) {
    return json({ detail: "Not Found" }, 404);
  }

  const secret = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!idsMatch(secret, env.WEBHOOK_ID.trim())) {
    return json({ detail: "Not Found" }, 404);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true }, 200);
  }

  const message = update && update.message;
  const chatId = message && message.chat ? String(message.chat.id) : "";
  const text = message && typeof message.text === "string" ? message.text.trim() : "";
  const expectedChat = debugBot(env).chatId;
  if (chatId !== expectedChat || text !== SYNC_BUTTON) {
    return json({ ok: true }, 200);
  }

  ctx.waitUntil(syncAndNotify(env, true));
  return json({ ok: true }, 200);
}

async function syncAndNotify(env, notify) {
  try {
    const result = await syncZenmoneyTags(env);
    const text = `получено ${result.received} новых ${result.added}`;
    console.log(text);
    if (notify) {
      await sendTelegram(env, text, "debug");
    }
    return result.received;
  } catch (error) {
    const message = error instanceof Error ? error.message : "ZenMoney sync failed";
    console.error(message);
    if (notify) {
      await sendTelegram(env, `ZenMoney sync failed: ${message}`, "debug");
      throw error;
    }
    return 0;
  }
}

function debugBot(env) {
  return {
    token: (env.DEBUG_BOT_TOKEN || "").trim(),
    chatId: (env.DEBUG_CHAT_ID || "").trim(),
  };
}

function notifyBot(env) {
  return {
    token: (env.NOTIFY_BOT_TOKEN || "").trim(),
    chatId: (env.NOTIFY_CHAT_ID || "").trim(),
  };
}

async function notifyTelegram(env, record) {
  await sendTelegram(env, JSON.stringify(record, null, 2), "debug");
}

async function notifyPayment(env, record, origin, paymentId) {
  const payment = paymentFromRecord(record);
  if (!payment) {
    return;
  }
  const seller = (payment.name || "").trim() || (payment.merchant || "").trim();
  let category = "";
  if (seller) {
    const rule = await env.DB.prepare(
      `SELECT t.title AS category
       FROM merchant_rules r
       LEFT JOIN zenmoney_tags t ON t.id = r.category_id
       WHERE r.merchant_key = ?`,
    )
      .bind(seller.toLowerCase())
      .first();
    if (rule && rule.category) {
      category = rule.category;
    }
  }
  const categoryText = category
    ? escapeHtml(category)
    : `<a href="${escapeHtml(origin)}/admin">без категории</a>`;
  const amountText = [payment.amount, payment.currency].filter(Boolean).join(" ");
  const posted = await zenmoneyPosted(env, paymentId);
  const parts = [`📅 ${escapeHtml(formatPaymentTime(record.timestamp, env.TIMEZONE))}`];
  if (showCard(env) && payment.card) {
    parts.push(`💳 ${escapeHtml(payment.card)}`);
  }
  parts.push(`🏪 ${escapeHtml(seller)}`);
  parts.push(`🏷 ${categoryText}`);
  if (amountText) {
    parts.push(`💰 ${escapeHtml(amountText)}`);
  }
  parts.push(`☯️ ${posted ? "✅" : "❌"}`);
  await sendTelegram(env, parts.join(" "), "notify");
}

async function zenmoneyPosted(env, paymentId) {
  if (!paymentId) {
    return false;
  }
  const row = await env.DB.prepare(
    "SELECT zenmoney_id, zenmoney_pending FROM payments WHERE id = ?",
  )
    .bind(paymentId)
    .first();
  return Boolean(row && row.zenmoney_id && row.zenmoney_pending === 0);
}

function showCard(env) {
  const value = (env.SHOW_CARD_NAME ?? "1").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendTelegram(env, text, botName) {
  const bot = botName === "notify" ? notifyBot(env) : debugBot(env);
  const token = bot.token;
  const chatId = bot.chatId;
  if (!token || !chatId) {
    console.error(`telegram ${botName} skipped: token or chat id is not set`);
    return;
  }

  const chunks = [];
  for (let index = 0; index < text.length; index += TELEGRAM_TEXT_LIMIT) {
    chunks.push(text.slice(index, index + TELEGRAM_TEXT_LIMIT));
  }
  if (chunks.length === 0) {
    chunks.push(text);
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const payload = { chat_id: chatId, text: chunks[index] };
    if (botName === "notify") {
      payload.parse_mode = "HTML";
      payload.disable_web_page_preview = true;
    }
    if (botName === "debug" && index === chunks.length - 1) {
      payload.reply_markup = {
        keyboard: [[{ text: SYNC_BUTTON }]],
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    let response;
    try {
      response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        },
      );
    } catch {
      console.error("telegram notify failed: request error");
      return;
    }
    if (!response.ok) {
      const detail = await response.text();
      console.error(`telegram notify failed: HTTP ${response.status} ${detail}`);
      return;
    }
  }
  console.log("telegram notify sent");
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
