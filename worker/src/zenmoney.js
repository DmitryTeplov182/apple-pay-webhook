export async function syncZenmoneyAccounts(env) {
  const token = (env.ZENMONEY_TOKEN || "").trim();
  if (!token) {
    throw new Error("ZENMONEY_TOKEN is not set");
  }

  const diff = await fetchAccounts(token);
  const instruments = new Map(
    (Array.isArray(diff.instrument) ? diff.instrument : []).map((item) => [
      item.id,
      String(item.shortTitle || item.symbol || ""),
    ]),
  );
  const accounts = (Array.isArray(diff.account) ? diff.account : []).filter(
    (account) => account && account.id,
  );
  if (accounts.length === 0) {
    throw new Error("ZenMoney returned no accounts");
  }
  await saveAccounts(env, accounts, instruments);
  return { received: accounts.length };
}

async function fetchAccounts(token) {
  const forced = await postDiff(token, {
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp: 2000000000,
    forceFetch: ["account", "instrument"],
  });
  if (Array.isArray(forced.account) && forced.account.length > 0) {
    return forced;
  }
  return postDiff(token, {
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp: 0,
    forceFetch: ["account", "instrument"],
  });
}

async function saveAccounts(env, accounts, instruments) {
  const statements = accounts.map((account) =>
    env.DB.prepare(
      `INSERT INTO zenmoney_accounts (
        id, title, type, currency, instrument_id, archive, changed, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        type = excluded.type,
        currency = excluded.currency,
        instrument_id = excluded.instrument_id,
        archive = excluded.archive,
        changed = excluded.changed,
        raw = excluded.raw`,
    ).bind(
      String(account.id),
      String(account.title ?? ""),
      String(account.type ?? ""),
      instruments.get(account.instrument) || "",
      account.instrument == null ? null : Number(account.instrument),
      account.archive ? 1 : 0,
      Number(account.changed) || 0,
      JSON.stringify(account),
    ),
  );
  const ids = accounts.map((account) => String(account.id));
  statements.push(
    env.DB.prepare(
      `DELETE FROM zenmoney_accounts WHERE id NOT IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids),
  );
  const chunkSize = 40;
  for (let index = 0; index < statements.length; index += chunkSize) {
    await env.DB.batch(statements.slice(index, index + chunkSize));
  }
}

export async function syncZenmoneyTags(env) {
  const token = (env.ZENMONEY_TOKEN || "").trim();
  if (!token) {
    throw new Error("ZENMONEY_TOKEN is not set");
  }

  const diff = await fetchTags(token);
  const tags = Array.isArray(diff.tag)
    ? diff.tag.filter((tag) => tag && tag.id && isExpense(tag))
    : [];
  if (tags.length === 0) {
    throw new Error("ZenMoney returned no expense tags");
  }

  const added = await saveTags(env, tags);
  await ensureCategoryCommands(env);
  return { received: tags.length, added };
}

let tagCommandColumnReady = false;

export async function ensureCategoryCommands(env) {
  if (!tagCommandColumnReady) {
    const info = await env.DB.prepare("PRAGMA table_info(zenmoney_tags)").all();
    const names = new Set((info.results || []).map((column) => column.name));
    if (!names.has("cmd")) {
      await env.DB.prepare("ALTER TABLE zenmoney_tags ADD COLUMN cmd INTEGER").run();
    }
    tagCommandColumnReady = true;
  }

  const missing = await env.DB.prepare(
    `SELECT id
     FROM zenmoney_tags
     WHERE show_outcome = 1 AND cmd IS NULL
     ORDER BY title`,
  ).all();
  const rows = missing.results || [];
  if (rows.length === 0) {
    return;
  }

  const maxRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(cmd), 0) AS max_cmd FROM zenmoney_tags",
  ).first();
  let next = Number(maxRow && maxRow.max_cmd) || 0;
  const statements = rows.map((row) => {
    next += 1;
    return env.DB.prepare(
      "UPDATE zenmoney_tags SET cmd = ? WHERE id = ? AND cmd IS NULL",
    ).bind(next, row.id);
  });
  const chunkSize = 40;
  for (let index = 0; index < statements.length; index += chunkSize) {
    await env.DB.batch(statements.slice(index, index + chunkSize));
  }
}

function isExpense(tag) {
  return tag.showOutcome === true || tag.showOutcome === 1;
}

async function fetchTags(token) {
  const forced = await postDiff(token, {
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp: 2000000000,
    forceFetch: ["tag"],
  });
  if (Array.isArray(forced.tag) && forced.tag.length > 0) {
    return forced;
  }

  return postDiff(token, {
    currentClientTimestamp: Math.floor(Date.now() / 1000),
    serverTimestamp: 0,
    forceFetch: ["tag"],
  });
}

async function postDiff(token, body) {
  let response;
  try {
    response = await fetch("https://api.zenmoney.ru/v8/diff/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("ZenMoney request failed");
  }

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`ZenMoney HTTP ${response.status}: ${payload.slice(0, 500)}`);
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("ZenMoney returned invalid JSON");
  }
}

let paymentExportReady = false;

export async function ensurePaymentExport(env) {
  if (paymentExportReady) {
    return;
  }
  const info = await env.DB.prepare("PRAGMA table_info(payments)").all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.has("zenmoney_id")) {
    await env.DB.prepare("ALTER TABLE payments ADD COLUMN zenmoney_id TEXT").run();
  }
  if (!names.has("zenmoney_pending")) {
    await env.DB.prepare(
      "ALTER TABLE payments ADD COLUMN zenmoney_pending INTEGER NOT NULL DEFAULT 0",
    ).run();
  }
  paymentExportReady = true;
}

export async function exportPendingPayments(env) {
  try {
    await ensurePaymentExport(env);
    await linkVisaCards(env);
    const ready = await env.DB.prepare(
      `SELECT
         p.id, p.created_at, p.amount, p.currency, p.name, p.merchant, p.card,
         p.category_id, p.zenmoney_id,
         a.id AS account_id, a.instrument_id, a.raw AS account_raw
       FROM payments p
       JOIN card_accounts c ON c.card = trim(p.card)
       JOIN zenmoney_accounts a ON a.id = c.account_id
       WHERE p.zenmoney_pending = 1
         AND a.instrument_id IS NOT NULL
         AND upper(trim(p.currency)) = upper(trim(a.currency))
         AND (p.category_id IS NOT NULL OR p.zenmoney_id IS NOT NULL)`,
    ).all();
    for (const row of ready.results || []) {
      try {
        await pushPayment(env, row);
      } catch (error) {
        console.error(
          "ZenMoney export failed:",
          error instanceof Error ? error.message : "export error",
        );
      }
    }
  } catch (error) {
    console.error(
      "ZenMoney export failed:",
      error instanceof Error ? error.message : "export error",
    );
  }
}

async function linkVisaCards(env) {
  const mapped = await env.DB.prepare("SELECT card, account_id FROM card_accounts").all();
  const rows = mapped.results || [];
  if (rows.length !== 1) {
    return;
  }
  const accountId = rows[0].account_id;
  const cards = await env.DB.prepare(
    `SELECT DISTINCT trim(card) AS card
     FROM payments
     WHERE trim(card) LIKE 'VISA **%' AND zenmoney_pending = 1`,
  ).all();
  for (const row of cards.results || []) {
    if (!row.card || rows.some((item) => item.card === row.card)) {
      continue;
    }
    await env.DB.prepare(
      "INSERT INTO card_accounts (card, account_id) VALUES (?, ?) ON CONFLICT(card) DO NOTHING",
    )
      .bind(row.card, accountId)
      .run();
  }
}

async function pushPayment(env, row) {
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return;
  }
  const userId = accountUserId(row.account_raw);
  if (!userId) {
    throw new Error("ZenMoney account has no user");
  }
  const seller = (row.name || "").trim() || (row.merchant || "").trim();
  const zenmoneyId = await claimZenmoneyId(env, row);
  const now = Math.floor(Date.now() / 1000);
  const created = Math.floor(new Date(row.created_at).getTime() / 1000) || now;
  const payee = seller || null;
  await postDiff((env.ZENMONEY_TOKEN || "").trim(), {
    currentClientTimestamp: now,
    serverTimestamp: now,
    transaction: [
      {
        id: zenmoneyId,
        changed: now,
        created,
        user: userId,
        deleted: false,
        hold: null,
        incomeInstrument: row.instrument_id,
        incomeAccount: row.account_id,
        income: 0,
        outcomeInstrument: row.instrument_id,
        outcomeAccount: row.account_id,
        outcome: amount,
        tag: row.category_id ? [row.category_id] : [],
        merchant: null,
        payee,
        originalPayee: payee,
        comment: null,
        date: zenmoneyDate(row.created_at, env.TIMEZONE),
        reminderMarker: null,
        opIncome: null,
        opIncomeInstrument: null,
        opOutcome: null,
        opOutcomeInstrument: null,
        latitude: null,
        longitude: null,
        incomeBankID: null,
        outcomeBankID: null,
        qrCode: null,
        source: null,
        viewed: false,
      },
    ],
  });
  await env.DB.prepare("UPDATE payments SET zenmoney_pending = 0 WHERE id = ?")
    .bind(row.id)
    .run();
}

async function claimZenmoneyId(env, row) {
  if (row.zenmoney_id) {
    return row.zenmoney_id;
  }
  const zenmoneyId = crypto.randomUUID();
  const result = await env.DB.prepare(
    "UPDATE payments SET zenmoney_id = ? WHERE id = ? AND zenmoney_id IS NULL",
  )
    .bind(zenmoneyId, row.id)
    .run();
  if ((result.meta?.changes || 0) > 0) {
    return zenmoneyId;
  }
  const current = await env.DB.prepare("SELECT zenmoney_id FROM payments WHERE id = ?")
    .bind(row.id)
    .first();
  return current.zenmoney_id;
}

function accountUserId(raw) {
  try {
    const user = JSON.parse(raw).user;
    const id = Number(user);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function zenmoneyDate(iso, timeZone) {
  const zone = (timeZone || "").trim() || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(iso));
    const value = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  } catch {
    return String(iso).slice(0, 10);
  }
}

function tagRow(tag) {
  return {
    id: String(tag.id),
    title: String(tag.title ?? ""),
    parent_id: tag.parent ? String(tag.parent) : null,
    show_income: tag.showIncome ? 1 : 0,
    show_outcome: tag.showOutcome ? 1 : 0,
    changed: Number(tag.changed) || 0,
    raw: JSON.stringify(tag),
  };
}

function tagChanged(previous, next) {
  if (!previous) {
    return true;
  }
  return previous.title !== next.title
    || (previous.parent_id || null) !== next.parent_id
    || Number(previous.show_income) !== next.show_income
    || Number(previous.show_outcome) !== next.show_outcome
    || Number(previous.changed) !== next.changed;
}

async function saveTags(env, tags) {
  const existing = await env.DB.prepare(
    "SELECT id, title, parent_id, show_income, show_outcome, changed FROM zenmoney_tags",
  ).all();
  const known = new Map((existing.results || []).map((row) => [row.id, row]));
  const incoming = tags.map(tagRow);
  const incomingIds = new Set(incoming.map((tag) => tag.id));
  const changed = incoming.filter((tag) => tagChanged(known.get(tag.id), tag));
  const removed = [...known.keys()].filter((id) => !incomingIds.has(id));
  const statements = changed.map((tag) =>
    env.DB.prepare(
      `INSERT INTO zenmoney_tags (
        id, title, parent_id, show_income, show_outcome, changed, raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        parent_id = excluded.parent_id,
        show_income = excluded.show_income,
        show_outcome = excluded.show_outcome,
        changed = excluded.changed,
        raw = excluded.raw`,
    ).bind(
      tag.id,
      tag.title,
      tag.parent_id,
      tag.show_income,
      tag.show_outcome,
      tag.changed,
      tag.raw,
    ),
  );
  if (removed.length) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM zenmoney_tags WHERE id NOT IN (${[...incomingIds].map(() => "?").join(",")})`,
      ).bind(...incomingIds),
    );
  }
  const chunkSize = 40;
  for (let index = 0; index < statements.length; index += chunkSize) {
    await env.DB.batch(statements.slice(index, index + chunkSize));
  }
  return incoming.filter((tag) => !known.has(tag.id)).length;
}
