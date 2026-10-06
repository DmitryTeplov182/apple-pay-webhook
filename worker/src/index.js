import {
  categorizePayment,
  ensurePaymentCurrency,
  ensureSeller,
  expenseCategories,
  handleAdmin,
  parseSerbianAmount,
} from "./portal.js";
import {
  altaTransactionId,
  convertToRsd,
  ensureNbsRates,
  parseAltaSms,
  zonedTimeToIso,
} from "./alta.js";
import {
  ensureCategoryCommands,
  ensurePaymentExport,
  exportPendingPayments,
  syncZenmoneyTags,
} from "./zenmoney.js";

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

    const notifyMatch = url.pathname.match(/^\/n\/([^/]+)$/);
    if (notifyMatch && request.method === "POST") {
      return handleNotifyTelegram(request, notifyMatch[1], env, ctx);
    }

    const altaMatch = url.pathname.match(/^\/a\/([^/]+)$/);
    if (altaMatch && request.method === "POST") {
      return handleAltaTelegram(request, altaMatch[1], env, ctx);
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
    ctx.waitUntil(refreshNbsRates(env));
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
  const posted = paymentId ? await zenmoneyPosted(env, paymentId) : false;
  await Promise.all([
    notifyTelegram(env, record),
    notifyPayment(env, record, origin, paymentId),
    debugStep(
      env,
      paymentId ? `платёж ${paymentId}\nzenmoney ${posted ? "✅" : "❌"}` : "платёж не создан",
    ),
  ]);
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

async function handleNotifyTelegram(request, candidate, env, ctx) {
  if (!webhookIdConfigured(env.WEBHOOK_ID)) {
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

  const expectedChat = notifyBot(env).chatId;
  const message = update && update.message;
  const chatId = message && message.chat ? String(message.chat.id) : "";
  const text = message && typeof message.text === "string" ? message.text.trim() : "";
  if (chatId === expectedChat && text) {
    ctx.waitUntil(handleCategoryCommand(env, message, "notify"));
  }
  return json({ ok: true }, 200);
}

async function handleAltaTelegram(request, candidate, env, ctx) {
  if (!webhookIdConfigured(env.WEBHOOK_ID)) {
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

  const expectedChat = altaBot(env).chatId;
  const message = update && update.message;
  const chatId = message && message.chat ? String(message.chat.id) : "";
  const text = message && typeof message.text === "string" ? message.text.trim() : "";
  if (chatId !== expectedChat || !text) {
    return json({ ok: true }, 200);
  }
  if (/^\/\d+_\d+(?:@\S+)?(?:\s+.*)?$/.test(text)) {
    ctx.waitUntil(handleCategoryCommand(env, message, "alta"));
    return json({ ok: true }, 200);
  }
  const origin = new URL(request.url).origin;
  ctx.waitUntil(handleAltaSms(env, text, origin));
  return json({ ok: true }, 200);
}

async function handleAltaSms(env, text, origin) {
  const parsed = parseAltaSms(text);
  if (!parsed) {
    if (/placanje|odliv|banka/i.test(text)) {
      await Promise.all([
        sendTelegram(env, "не распознано", "alta"),
        debugStep(env, "alta: не распознано"),
      ]);
    }
    return;
  }
  try {
    await ensureNbsRates(env);
  } catch (error) {
    console.error(
      "NBS rates failed:",
      error instanceof Error ? error.message : "NBS rates failed",
    );
  }
  const money = await convertToRsd(env, parsed.currency, parsed.amount);
  if (!money) {
    await Promise.all([
      sendTelegram(env, `нет курса ${parsed.currency}`, "alta"),
      debugStep(env, `alta: нет курса ${parsed.currency}`),
    ]);
    return;
  }
  const transaction = await altaTransactionId(parsed.source);
  const existing = await env.DB.prepare(
    "SELECT id FROM payments WHERE \"transaction\" = ?",
  )
    .bind(transaction)
    .first();
  if (existing) {
    await Promise.all([
      sendTelegram(env, "уже есть", "alta"),
      debugStep(env, `alta: уже есть ${existing.id}`),
    ]);
    return;
  }
  if (!parsed.card) {
    parsed.card = await visaCard(env);
  }
  const createdAt = zonedTimeToIso(parsed.date, parsed.time, env.TIMEZONE);
  const paymentId = await storeAltaPayment(env, parsed, money, transaction, createdAt);
  if (!paymentId) {
    await Promise.all([
      sendTelegram(env, "не сохранилось", "alta"),
      debugStep(env, "alta: не сохранилось"),
    ]);
    return;
  }
  await exportPendingPayments(env);
  const posted = await zenmoneyPosted(env, paymentId);
  const rateNote = money.rate
    ? `${parsed.amount} ${parsed.currency} × ${money.rate} = ${money.amount} RSD (${money.rateDate})`
    : `${money.amount} RSD`;
  await Promise.all([
    announcePayment(env, "alta", origin, paymentId, {
      timeIso: createdAt,
      card: parsed.card,
      seller: parsed.merchant,
      amount: money.amount,
      currency: money.currency,
    }),
    debugStep(env, `alta платёж ${paymentId}\n${rateNote}\nzenmoney ${posted ? "✅" : "❌"}`),
  ]);
}

async function storeAltaPayment(env, parsed, money, transaction, createdAt) {
  const categoryId = await ensureSeller(env, parsed.merchant, parsed.merchant);
  await ensurePaymentCurrency(env);
  await ensurePaymentExport(env);
  const inserted = await env.DB.prepare(
    `INSERT INTO payments (
      created_at, amount, currency, "transaction", name, card, merchant, category_id,
      zenmoney_pending, raw
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      createdAt,
      money.amount,
      money.currency,
      transaction,
      parsed.merchant,
      parsed.card,
      parsed.merchant,
      categoryId,
      JSON.stringify({
        source: "alta",
        kind: parsed.kind,
        account: parsed.account || null,
        originalAmount: parsed.amount,
        originalCurrency: parsed.currency,
        rate: money.rate,
        parity: money.parity,
        rateDate: money.rateDate,
      }),
    )
    .run();
  return inserted.meta?.last_row_id || null;
}

async function visaCard(env) {
  const row = await env.DB.prepare(
    "SELECT card FROM payments WHERE card LIKE 'VISA **%' ORDER BY id DESC LIMIT 1",
  ).first();
  return (row && row.card) || "VISA";
}

async function refreshNbsRates(env) {
  try {
    await ensureNbsRates(env);
  } catch (error) {
    console.error(
      "NBS rates failed:",
      error instanceof Error ? error.message : "NBS rates failed",
    );
  }
}

async function handleCategoryCommand(env, message, botName) {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const command = text.match(/^\/(\d+)_(\d+)(?:@\S+)?(?:\s+.*)?$/);
  if (!command) {
    return;
  }
  const replyToUser = message.message_id;
  const categories = await expenseCategories(env);
  const category = categories.find((item) => Number(item.cmd) === Number(command[1]));
  if (!category) {
    await Promise.all([
        sendTelegram(env, "нет такой категории", botName, { replyTo: replyToUser }),
      debugStep(env, `команда ${text}\nнет такой категории`),
    ]);
    return;
  }
  const payment = await env.DB.prepare("SELECT id FROM payments WHERE id = ?")
    .bind(Number(command[2]))
    .first();
  if (!payment) {
    await Promise.all([
      sendTelegram(env, "нет такого платежа", botName, { replyTo: replyToUser }),
      debugStep(env, `команда ${text}\nнет такого платежа`),
    ]);
    return;
  }
  const saved = await categorizePayment(env, payment.id, category.id);
  if (!saved) {
    await Promise.all([
      sendTelegram(env, "не сохранилось", botName, { replyTo: replyToUser }),
      debugStep(env, `команда ${text}\nне сохранилось`),
    ]);
    return;
  }
  await exportPendingPayments(env);
  await Promise.all([
    debugStep(env, `команда ${text}`),
    deleteNotifyMessage(env, botName, replyToUser).then((removed) =>
      debugStep(env, removed ? "команда удалена" : "команда не удалена"),
    ),
    (async () => {
      for (const paymentId of saved.paymentIds) {
        const how = await settlePaymentNotice(env, paymentId, botName);
        const line = await paymentStatusFromDb(env, paymentId);
        await debugStep(env, [how, line].filter(Boolean).join("\n"), { html: true });
      }
    })(),
  ]);
}

async function settlePaymentNotice(env, paymentId, fallbackBot = "notify") {
  const text = await paymentStatusFromDb(env, paymentId);
  if (!text) {
    return `платёж ${paymentId}: не найден`;
  }
  const rows = await listNotifyMessages(env, paymentId);
  const edited = rows.length
    ? await editNotifyMessage(env, rows[0].bot, rows[0].message_id, text)
    : false;
  for (const row of rows.slice(edited ? 1 : 0)) {
    await deleteNotifyMessage(env, row.bot, row.message_id);
  }
  if (edited) {
    await env.DB.prepare(
      "DELETE FROM notify_messages WHERE payment_id = ? AND NOT (bot = ? AND message_id = ?)",
    )
      .bind(paymentId, rows[0].bot, rows[0].message_id)
      .run();
    return `платёж ${paymentId}: сообщение обновлено`;
  }
  if (rows.length) {
    await env.DB.prepare("DELETE FROM notify_messages WHERE payment_id = ?")
      .bind(paymentId)
      .run();
  }
  const botName = rows[0]?.bot || fallbackBot;
  const sent = await sendTelegram(env, text, botName);
  for (const messageId of sent || []) {
    await rememberNotifyMessage(env, botName, messageId, paymentId);
  }
  return sent && sent.length
    ? `платёж ${paymentId}: отправлено заново`
    : `платёж ${paymentId}: сообщение не отправлено`;
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

function altaBot(env) {
  return {
    token: (env.ALTA_SMS_BOT_TOKEN || "").trim(),
    chatId: (env.ALTA_SMS_BOT_ID || "").trim(),
  };
}

function botByName(env, botName) {
  if (botName === "debug") {
    return debugBot(env);
  }
  if (botName === "alta") {
    return altaBot(env);
  }
  return notifyBot(env);
}

async function debugStep(env, text, options) {
  try {
    await sendTelegram(env, text, "debug", options);
  } catch (error) {
    console.error(
      "debug step failed:",
      error instanceof Error ? error.message : "debug step failed",
    );
  }
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
  await announcePayment(env, "notify", origin, paymentId, {
    timeIso: record.timestamp,
    card: payment.card,
    seller,
    amount: payment.amount,
    currency: payment.currency,
  });
}

async function announcePayment(env, botName, origin, paymentId, view) {
  let category = "";
  if (view.seller) {
    const rule = await env.DB.prepare(
      `SELECT t.title AS category
       FROM merchant_rules r
       LEFT JOIN zenmoney_tags t ON t.id = r.category_id
       WHERE r.merchant_key = ?`,
    )
      .bind(view.seller.toLowerCase())
      .first();
    if (rule && rule.category) {
      category = rule.category;
    }
  }
  const posted = await zenmoneyPosted(env, paymentId);
  let text = paymentLine(env, {
    time: formatPaymentTime(view.timeIso, env.TIMEZONE),
    card: view.card,
    seller: view.seller,
    categoryHtml: category
      ? escapeHtml(category)
      : `<a href="${escapeHtml(origin)}/admin">без категории</a>`,
    amount: view.amount,
    currency: view.currency,
    posted,
  });
  if (!category) {
    await ensureCategoryCommands(env);
    const categories = await expenseCategories(env);
    const lines = paymentId
      ? categories.map(
        (item) => `/${item.cmd}_${paymentId} ${escapeHtml(String(item.title).replaceAll("\n", " "))}`,
      )
      : [];
    if (lines.length) {
      text = `${text}\n${lines.join("\n")}`;
    }
  }
  const messageIds = await sendTelegram(env, text, botName);
  if (paymentId) {
    for (const messageId of messageIds || []) {
      await rememberNotifyMessage(env, botName, messageId, paymentId);
    }
  }
}

async function paymentStatusFromDb(env, paymentId) {
  const row = await env.DB.prepare(
    `SELECT p.created_at, p.amount, p.currency, p.name, p.card, p.merchant,
            p.zenmoney_id, p.zenmoney_pending, t.title AS category
     FROM payments p
     LEFT JOIN zenmoney_tags t ON t.id = p.category_id
     WHERE p.id = ?`,
  )
    .bind(paymentId)
    .first();
  if (!row) {
    return "";
  }
  const seller = (row.name || "").trim() || (row.merchant || "").trim();
  return paymentLine(env, {
    time: formatPaymentTime(row.created_at, env.TIMEZONE),
    card: row.card,
    seller,
    categoryHtml: row.category ? escapeHtml(row.category) : "без категории",
    amount: row.amount,
    currency: row.currency,
    posted: Boolean(row.zenmoney_id && row.zenmoney_pending === 0),
  });
}

function paymentLine(env, payment) {
  const parts = [`📅 ${escapeHtml(payment.time)}`];
  if (payment.card && shouldShowCard(env, payment.card)) {
    parts.push(`💳 ${escapeHtml(payment.card)}`);
  }
  parts.push(`🏪 ${escapeHtml(payment.seller)}`);
  parts.push(`🏷 ${payment.categoryHtml}`);
  const amountText = [payment.amount, payment.currency].filter(Boolean).join(" ");
  if (amountText) {
    parts.push(`💰 ${escapeHtml(amountText)}`);
  }
  parts.push(`☯️ ${payment.posted ? "✅" : "❌"}`);
  return parts.join(" ");
}

async function ensureNotifyMessages(env) {
  const existing = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notify_messages'",
  ).first();
  if (!existing) {
    await env.DB.prepare(
      `CREATE TABLE notify_messages (
        bot TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        payment_id INTEGER NOT NULL,
        PRIMARY KEY (bot, message_id)
      )`,
    ).run();
    return;
  }
  const info = await env.DB.prepare("PRAGMA table_info(notify_messages)").all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (names.has("bot")) {
    return;
  }
  await env.DB.prepare(
    `CREATE TABLE notify_messages_v2 (
      bot TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      payment_id INTEGER NOT NULL,
      PRIMARY KEY (bot, message_id)
    )`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO notify_messages_v2 (bot, message_id, payment_id)
     SELECT 'notify', message_id, payment_id FROM notify_messages`,
  ).run();
  await env.DB.prepare("DROP TABLE notify_messages").run();
  await env.DB.prepare("ALTER TABLE notify_messages_v2 RENAME TO notify_messages").run();
}

async function rememberNotifyMessage(env, botName, messageId, paymentId) {
  await ensureNotifyMessages(env);
  await env.DB.prepare(
    `INSERT INTO notify_messages (bot, message_id, payment_id) VALUES (?, ?, ?)
     ON CONFLICT(bot, message_id) DO UPDATE SET payment_id = excluded.payment_id`,
  )
    .bind(botName, messageId, paymentId)
    .run();
}

async function listNotifyMessages(env, paymentId) {
  await ensureNotifyMessages(env);
  const rows = await env.DB.prepare(
    "SELECT bot, message_id FROM notify_messages WHERE payment_id = ? ORDER BY message_id",
  )
    .bind(paymentId)
    .all();
  return rows.results || [];
}

async function editNotifyMessage(env, botName, messageId, text) {
  const bot = botByName(env, botName);
  if (!bot.token) {
    return false;
  }
  const result = await telegramMethod(bot.token, "editMessageText", {
    chat_id: bot.chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  return Boolean(result && result.ok);
}

async function deleteNotifyMessage(env, botName, messageId) {
  const bot = botByName(env, botName);
  if (!bot.token || !messageId) {
    return false;
  }
  const result = await telegramMethod(bot.token, "deleteMessage", {
    chat_id: bot.chatId,
    message_id: messageId,
  });
  return Boolean(result && result.ok);
}

async function telegramMethod(token, method, body) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`telegram ${method} failed: request error`);
    return null;
  }
  if (!response.ok) {
    const detail = await response.text();
    console.error(`telegram ${method} failed: HTTP ${response.status} ${detail}`);
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
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

function shouldShowCard(env, card) {
  const name = String(card || "");
  if (name === "VISA" || name.startsWith("VISA **")) {
    return true;
  }
  return showCard(env);
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

async function sendTelegram(env, text, botName, options = {}) {
  const bot = botByName(env, botName);
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

  const messageIds = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const payload = { chat_id: chatId, text: chunks[index] };
    if (options.replyTo && index === 0) {
      payload.reply_to_message_id = options.replyTo;
    }
    if (botName === "notify" || botName === "alta" || options.html) {
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
      return messageIds;
    }
    if (!response.ok) {
      const detail = await response.text();
      console.error(`telegram notify failed: HTTP ${response.status} ${detail}`);
      return messageIds;
    }
    try {
      const body = await response.json();
      if (body && body.result && body.result.message_id) {
        messageIds.push(body.result.message_id);
      }
    } catch {
      return messageIds;
    }
  }
  console.log("telegram notify sent");
  return messageIds;
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
