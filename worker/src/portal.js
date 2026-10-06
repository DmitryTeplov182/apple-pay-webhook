import { ensurePaymentExport, exportPendingPayments, syncZenmoneyAccounts } from "./zenmoney.js";

export async function handleAdmin(request, env, ctx, url) {
  if (!ctx.access) {
    return new Response("Нужен вход через Cloudflare Access.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
    return new Response(portalHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/admin/api/payments") {
    return json(await listPayments(env));
  }

  if (request.method === "GET" && url.pathname === "/admin/api/categories") {
    return json(await listCategories(env));
  }

  const paymentMatch = url.pathname.match(/^\/admin\/api\/payments\/(\d+)$/);
  if (paymentMatch && request.method === "POST") {
    return updatePayment(env, ctx, Number(paymentMatch[1]), request);
  }

  if (request.method === "GET" && url.pathname === "/admin/api/rules") {
    return json(await listRules(env));
  }

  if (request.method === "POST" && url.pathname === "/admin/api/rules") {
    return saveRule(env, ctx, request);
  }

  if (request.method === "GET" && url.pathname === "/admin/api/cards") {
    return json(await listCards(env));
  }

  if (request.method === "POST" && url.pathname === "/admin/api/cards") {
    return saveCard(env, ctx, request);
  }

  if (request.method === "POST" && url.pathname === "/admin/api/accounts/sync") {
    try {
      const result = await syncZenmoneyAccounts(env);
      return json({ ok: true, received: result.received, ...(await listCards(env)) });
    } catch {
      return json({ ok: false }, 500);
    }
  }

  return json({ detail: "Not Found" }, 404);
}

async function listPayments(env) {
  await ensurePaymentCurrency(env);
  const result = await env.DB.prepare(
    `SELECT
      p.id, p.created_at, p.amount, p.currency, p."transaction", p.name, p.card, p.merchant,
      p.category_id, t.title AS category
    FROM payments p
    LEFT JOIN zenmoney_tags t ON t.id = p.category_id
    ORDER BY p.created_at DESC, p.id DESC`,
  ).all();
  return { payments: result.results };
}

async function listCategories(env) {
  const result = await env.DB.prepare(
    `SELECT id, title, parent_id
     FROM zenmoney_tags
     WHERE show_outcome = 1
     ORDER BY title`,
  ).all();
  const byId = new Map(result.results.map((tag) => [tag.id, tag]));
  const categories = result.results
    .map((tag) => {
      const parent = tag.parent_id ? byId.get(tag.parent_id) : null;
      return {
        id: tag.id,
        title: tag.title,
        label: parent ? `${parent.title} / ${tag.title}` : tag.title,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, "ru"));
  return { categories };
}

async function updatePayment(env, ctx, id, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  const categoryId = body.category_id ?? null;
  if (categoryId !== null && typeof categoryId !== "string") {
    return json({ ok: false }, 400);
  }

  if (categoryId) {
    const category = await env.DB.prepare(
      "SELECT id FROM zenmoney_tags WHERE id = ? AND show_outcome = 1",
    )
      .bind(categoryId)
      .first();
    if (!category) {
      return json({ ok: false }, 400);
    }
  }

  const current = await env.DB.prepare(
    `SELECT id, name, merchant FROM payments WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!current) {
    return json({ detail: "Not Found" }, 404);
  }

  const label = merchantLabel(current);
  const key = label.toLowerCase();
  let ids = [current.id];
  if (key && categoryId) {
    await rememberRule(env, label, categoryId);
    ids = await paymentIdsForMerchant(env, key);
  }

  const payments = await applyCategory(env, ids, categoryId);
  ctx.waitUntil(exportPendingPayments(env));
  return json({ ok: true, payments });
}

async function listRules(env) {
  await backfillSellers(env);
  const result = await env.DB.prepare(
    `SELECT r.merchant_key, r.merchant, r.category_id, t.title AS category
     FROM merchant_rules r
     LEFT JOIN zenmoney_tags t ON t.id = r.category_id
     ORDER BY r.merchant`,
  ).all();
  return { rules: result.results };
}

async function saveRule(env, ctx, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  const label = typeof body.merchant === "string" ? body.merchant.trim() : "";
  const categoryId = body.category_id ?? null;
  if (!label || (categoryId !== null && typeof categoryId !== "string")) {
    return json({ ok: false }, 400);
  }

  await ensureRuleMerchant(env);
  const key = label.toLowerCase();
  if (!categoryId) {
    await env.DB.prepare("DELETE FROM merchant_rules WHERE merchant_key = ?").bind(key).run();
    return json({ ok: true, rules: (await listRules(env)).rules });
  }

  const category = await env.DB.prepare(
    "SELECT id FROM zenmoney_tags WHERE id = ? AND show_outcome = 1",
  )
    .bind(categoryId)
    .first();
  if (!category) {
    return json({ ok: false }, 400);
  }

  await rememberRule(env, label, categoryId);
  const payments = await applyCategory(env, await paymentIdsForMerchant(env, key), categoryId);
  ctx.waitUntil(exportPendingPayments(env));
  return json({ ok: true, rules: (await listRules(env)).rules, payments });
}

async function listCards(env) {
  const cards = await env.DB.prepare(
    `WITH names AS (
       SELECT DISTINCT trim(card) AS card
       FROM payments
       WHERE trim(card) != ''
     )
     SELECT
       names.card,
       link.account_id,
       account.title AS account_title,
       account.currency
     FROM names
     LEFT JOIN card_accounts link ON link.card = names.card
     LEFT JOIN zenmoney_accounts account ON account.id = link.account_id
     ORDER BY names.card`,
  ).all();
  const accounts = await env.DB.prepare(
    `SELECT id, title, type, currency, archive
     FROM zenmoney_accounts
     ORDER BY title`,
  ).all();
  return {
    cards: (cards.results || []).map((row) => ({
      card: row.card,
      account_id: row.account_title ? row.account_id : null,
      account_title: row.account_title || "",
      currency: row.currency || "",
    })),
    accounts: accounts.results || [],
  };
}

async function saveCard(env, ctx, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  const card = typeof body.card === "string" ? body.card.trim() : "";
  const accountId = body.account_id ?? null;
  if (!card || (accountId !== null && typeof accountId !== "string")) {
    return json({ ok: false }, 400);
  }

  if (!accountId) {
    await env.DB.prepare("DELETE FROM card_accounts WHERE card = ?").bind(card).run();
    return json({ ok: true, ...(await listCards(env)) });
  }

  const account = await env.DB.prepare(
    "SELECT id FROM zenmoney_accounts WHERE id = ?",
  )
    .bind(accountId)
    .first();
  if (!account) {
    return json({ ok: false }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO card_accounts (card, account_id) VALUES (?, ?)
     ON CONFLICT(card) DO UPDATE SET account_id = excluded.account_id`,
  )
    .bind(card, accountId)
    .run();
  ctx.waitUntil(exportPendingPayments(env));
  return json({ ok: true, ...(await listCards(env)) });
}

async function ensureRuleMerchant(env) {
  const info = await env.DB.prepare("PRAGMA table_info(merchant_rules)").all();
  const columns = info.results || [];
  const names = new Set(columns.map((column) => column.name));
  const category = columns.find((column) => column.name === "category_id");
  if (names.has("merchant") && category && !category.notnull) {
    return;
  }

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS merchant_rules_next (
      merchant_key TEXT PRIMARY KEY,
      merchant TEXT NOT NULL,
      category_id TEXT
    )`,
  ).run();
  if (names.has("merchant")) {
    await env.DB.prepare(
      `INSERT INTO merchant_rules_next (merchant_key, merchant, category_id)
       SELECT merchant_key, COALESCE(NULLIF(merchant, ''), merchant_key), category_id
       FROM merchant_rules`,
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO merchant_rules_next (merchant_key, merchant, category_id)
       SELECT merchant_key, merchant_key, category_id
       FROM merchant_rules`,
    ).run();
  }
  await env.DB.batch([
    env.DB.prepare("DROP TABLE merchant_rules"),
    env.DB.prepare("ALTER TABLE merchant_rules_next RENAME TO merchant_rules"),
  ]);
}

async function backfillSellers(env) {
  await ensureRuleMerchant(env);
  const payments = await env.DB.prepare("SELECT name, merchant FROM payments").all();
  for (const row of payments.results || []) {
    await ensureSeller(env, row.name, row.merchant);
  }
}

async function rememberRule(env, label, categoryId) {
  await ensureRuleMerchant(env);
  await env.DB.prepare(
    `INSERT INTO merchant_rules (merchant_key, merchant, category_id) VALUES (?, ?, ?)
     ON CONFLICT(merchant_key) DO UPDATE SET
       merchant = excluded.merchant,
       category_id = excluded.category_id`,
  )
    .bind(label.toLowerCase(), label, categoryId)
    .run();
}

async function paymentIdsForMerchant(env, key) {
  const rows = await env.DB.prepare("SELECT id, name, merchant FROM payments").all();
  return (rows.results || [])
    .filter((row) => merchantLabel(row).toLowerCase() === key)
    .map((row) => row.id);
}

async function applyCategory(env, ids, categoryId) {
  if (!ids.length) {
    return [];
  }
  await ensurePaymentExport(env);
  await env.DB.prepare(
    `UPDATE payments SET category_id = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(categoryId, ...ids)
    .run();
  await env.DB.prepare(
    `UPDATE payments SET zenmoney_pending = 1
     WHERE zenmoney_id IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .run();
  const payments = await env.DB.prepare(
    `SELECT
      p.id, p.created_at, p.amount, p.currency, p."transaction", p.name, p.card, p.merchant,
      p.category_id, t.title AS category
    FROM payments p
    LEFT JOIN zenmoney_tags t ON t.id = p.category_id
    WHERE p.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all();
  return payments.results;
}

export function parseSerbianAmount(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(
    /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d+))?[ \u00A0\u202F\u2007\u2009]+([A-Za-z]{3})$/,
  );
  if (!match) {
    return { amount: raw, currency: "" };
  }
  const whole = match[1].replaceAll(".", "");
  const amount = match[2] === undefined ? whole : `${whole}.${match[2]}`;
  return { amount, currency: match[3].toUpperCase() };
}

export async function ensurePaymentCurrency(env) {
  const info = await env.DB.prepare("PRAGMA table_info(payments)").all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.has("currency")) {
    await env.DB.prepare(
      "ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT ''",
    ).run();
  }
  const pending = await env.DB.prepare(
    "SELECT id, amount FROM payments WHERE currency = ''",
  ).all();
  for (const row of pending.results || []) {
    const parsed = parseSerbianAmount(row.amount);
    if (!parsed.currency || parsed.amount === row.amount) {
      continue;
    }
    await env.DB.prepare("UPDATE payments SET amount = ?, currency = ? WHERE id = ?")
      .bind(parsed.amount, parsed.currency, row.id)
      .run();
  }
}

function merchantLabel(payment) {
  return (payment.name || "").trim() || (payment.merchant || "").trim();
}

export async function ensureSeller(env, name, merchant) {
  const label = merchantLabel({ name, merchant });
  if (!label) {
    return null;
  }
  await ensureRuleMerchant(env);
  const key = label.toLowerCase();
  await env.DB.prepare(
    `INSERT INTO merchant_rules (merchant_key, merchant, category_id) VALUES (?, ?, NULL)
     ON CONFLICT(merchant_key) DO NOTHING`,
  )
    .bind(key, label)
    .run();
  const rule = await env.DB.prepare(
    "SELECT category_id FROM merchant_rules WHERE merchant_key = ?",
  )
    .bind(key)
    .first();
  return rule ? rule.category_id : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function portalHtml() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Платежи</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=Sora:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #17211e;
      --muted: #5d6b66;
      --paper: #eef3f0;
      --sheet: #f7faf8;
      --line: #d5e0da;
      --teal: #0c6b56;
      --teal-soft: #d7efe7;
      --unset: #1d4e89;
      --danger: #8f2d2d;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--paper); color: var(--ink); }
    body {
      font-family: Sora, sans-serif;
      min-height: 100dvh;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: calc(16px + env(safe-area-inset-top)) 18px 12px;
      background: color-mix(in srgb, var(--paper) 92%, transparent);
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0;
      font-family: Newsreader, serif;
      font-size: 2rem;
      font-weight: 550;
      letter-spacing: -0.03em;
    }
    .switch {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 14px;
      padding: 4px;
      background: var(--sheet);
      border: 1px solid var(--line);
      border-radius: 14px;
    }
    .switch button, .row, .choice, .back {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 0;
    }
    .switch button {
      min-height: 44px;
      border-radius: 11px;
    }
    .switch.sections { grid-template-columns: 1fr 1fr 1fr; }
    .switch.sections button { font-size: 0.86rem; padding: 0 4px; }
    .switch button[aria-pressed="true"] {
      background: var(--ink);
      color: var(--sheet);
    }
    main { padding: 4px 12px calc(24px + env(safe-area-inset-bottom)); }
    .row {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px 16px;
      text-align: left;
      padding: 16px 12px 16px 14px;
      border-bottom: 1px solid var(--line);
    }
    .row.unset { box-shadow: inset 4px 0 0 var(--unset); }
    .merchant { font-weight: 600; font-size: 1.05rem; }
    .meta { color: var(--muted); font-size: 0.92rem; }
    .amount {
      font-family: Newsreader, serif;
      font-size: 1.7rem;
      line-height: 1;
      font-weight: 550;
    }
    .category { grid-column: 1 / -1; color: var(--teal); font-size: 0.95rem; }
    .row.unset .category { color: var(--unset); }
    .empty { padding: 28px 8px; color: var(--muted); }
    .sheet {
      position: fixed;
      inset: 0;
      background: var(--paper);
      display: flex;
      flex-direction: column;
      z-index: 5;
    }
    .sheet[hidden] { display: none; }
    .sheet-bar {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: calc(10px + env(safe-area-inset-top)) 12px 0;
    }
    .hint {
      margin: 8px 16px 4px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .back { min-width: 44px; min-height: 44px; font-size: 1.4rem; }
    input[type="search"] {
      flex: 1;
      min-height: 48px;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 0 14px;
      font: inherit;
      background: var(--sheet);
      color: var(--ink);
    }
    .choices { overflow: auto; padding-bottom: env(safe-area-inset-bottom); }
    .choice {
      width: 100%;
      min-height: 56px;
      text-align: left;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      font-size: 1.05rem;
    }
    .choice.current { background: var(--teal-soft); }
    .composer {
      display: grid;
      gap: 8px;
      padding: 8px 6px 18px;
    }
    .composer input, .pick, .remember, .remove, .seller {
      font: inherit;
      color: var(--ink);
      min-height: 52px;
      border-radius: 14px;
    }
    .composer input, .pick {
      border: 1px solid var(--line);
      background: var(--sheet);
      padding: 0 14px;
    }
    .pick, .seller, .remove {
      text-align: left;
      background: transparent;
      border: 0;
    }
    .remember {
      border: 0;
      background: var(--teal);
      color: var(--sheet);
      font-weight: 600;
    }
    .rule {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      border-bottom: 1px solid var(--line);
    }
    .seller { padding: 12px 8px; }
    .seller strong, .seller span { display: block; }
    select.pick {
      display: block;
      width: 100%;
      margin-top: 8px;
      border: 1px solid var(--line);
      background: var(--sheet);
    }
    .seller span { color: var(--teal); font-size: 0.95rem; margin-top: 2px; }
    .remove { color: var(--danger); padding: 0 12px; }
    .status { padding: 18px; color: var(--danger); }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1 id="heading">Платежи</h1>
    <div class="switch sections" role="group" aria-label="Раздел">
      <button type="button" id="view-payments" aria-pressed="true">Платежи</button>
      <button type="button" id="view-rules" aria-pressed="false">Продавцы</button>
      <button type="button" id="view-cards" aria-pressed="false">Карты</button>
    </div>
    <div class="switch" id="pay-filter" role="group" aria-label="Фильтр">
      <button type="button" id="only-open" aria-pressed="true">Без категории</button>
      <button type="button" id="show-all" aria-pressed="false">Все</button>
    </div>
  </header>
  <main>
    <div id="list"></div>
    <div id="rules-panel" hidden>
      <form class="composer" id="composer">
        <input id="rule-merchant" type="text" placeholder="YANDEXTAXI" autocomplete="off" enterkeyhint="done">
        <button class="pick" type="button" id="rule-category">Выбрать категорию</button>
        <button class="remember" type="submit">Запомнить</button>
      </form>
      <div id="rule-list"></div>
    </div>
    <div id="cards-panel" hidden>
      <form class="composer" id="card-sync">
        <button class="remember" type="submit">Синхронизировать счета</button>
      </form>
      <p class="empty" id="account-note"></p>
      <div id="card-list"></div>
    </div>
  </main>
  <p class="status" id="status" hidden></p>
  <section class="sheet" id="sheet" hidden>
    <div class="sheet-bar">
      <button class="back" type="button" id="close" aria-label="Назад">←</button>
      <input id="search" type="search" placeholder="Категория" enterkeyhint="search" autocomplete="off">
    </div>
    <p class="hint" id="hint"></p>
    <div class="choices" id="choices"></div>
  </section>
  <script>
    const listEl = document.querySelector("#list");
    const rulesPanel = document.querySelector("#rules-panel");
    const ruleList = document.querySelector("#rule-list");
    const ruleMerchant = document.querySelector("#rule-merchant");
    const ruleCategory = document.querySelector("#rule-category");
    const cardsPanel = document.querySelector("#cards-panel");
    const cardList = document.querySelector("#card-list");
    const accountNote = document.querySelector("#account-note");
    const payFilter = document.querySelector("#pay-filter");
    const heading = document.querySelector("#heading");
    const statusEl = document.querySelector("#status");
    const sheet = document.querySelector("#sheet");
    const choices = document.querySelector("#choices");
    const search = document.querySelector("#search");
    const hint = document.querySelector("#hint");
    const onlyOpen = document.querySelector("#only-open");
    const showAll = document.querySelector("#show-all");
    let payments = [];
    let categories = [];
    let rules = [];
    let cards = [];
    let accounts = [];
    let activeId = null;
    let onlyMissing = true;
    let view = "payments";
    let sheetMode = "payment";
    let draftCategory = null;

    function money(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return value;
      return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(number);
    }

    function visiblePayments() {
      return payments.filter((payment) => !onlyMissing || !payment.category_id);
    }

    function updateTabs() {
      const openPayments = payments.filter((payment) => !payment.category_id).length;
      const openRules = rules.filter((rule) => !rule.category_id).length;
      const openCards = cards.filter((card) => !card.account_id).length;
      document.querySelector("#view-payments").textContent = "Платежи (" + openPayments + ")";
      document.querySelector("#view-rules").textContent = "Продавцы (" + openRules + ")";
      document.querySelector("#view-cards").textContent = "Карты (" + openCards + ")";
      const titles = {
        payments: "Платежи (" + openPayments + ")",
        rules: "Продавцы (" + openRules + ")",
        cards: "Карты (" + openCards + ")",
      };
      heading.textContent = titles[view];
      document.title = titles[view];
    }

    function render() {
      updateTabs();
      const rows = visiblePayments();
      if (!rows.length) {
        listEl.innerHTML = '<p class="empty">Всё размечено.</p>';
        return;
      }
      listEl.replaceChildren(...rows.map((payment) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "row" + (payment.category_id ? "" : " unset");
        button.innerHTML =
          '<span class="merchant"></span><span class="amount"></span><span class="meta"></span><span class="category"></span>';
        button.querySelector(".merchant").textContent = payment.merchant || payment.name || "Платёж";
        button.querySelector(".amount").textContent = [money(payment.amount), payment.currency].filter(Boolean).join(" ");
        button.querySelector(".meta").textContent = [payment.card && ("карта " + payment.card), payment.name].filter(Boolean).join(", ");
        button.querySelector(".category").textContent = payment.category || "Выбрать категорию";
        button.addEventListener("click", () => openSheet(payment.id));
        return button;
      }));
    }

    function currentCategoryId() {
      if (sheetMode === "draft") return draftCategory && draftCategory.id;
      if (sheetMode === "rule") {
        const rule = rules.find((item) => item.merchant === ruleMerchant.value.trim());
        return rule && rule.category_id;
      }
      const payment = payments.find((item) => item.id === activeId);
      return payment && payment.category_id;
    }

    function renderChoices() {
      const query = search.value.trim().toLocaleLowerCase("ru");
      const selected = currentCategoryId();
      const matched = categories.filter((category) =>
        category.label.toLocaleLowerCase("ru").includes(query),
      );
      choices.replaceChildren(...matched.map((category) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "choice" + (selected === category.id ? " current" : "");
        button.textContent = category.label;
        button.addEventListener("click", () => save(category.id));
        return button;
      }));
    }

    function renderRules() {
      updateTabs();
      if (!rules.length) {
        ruleList.innerHTML = '<p class="empty">Пока нет ни одного продавца.</p>';
        return;
      }
      ruleList.replaceChildren(...rules.map((rule) => {
        const row = document.createElement("div");
        row.className = "rule";
        const seller = document.createElement("button");
        seller.type = "button";
        seller.className = "seller";
        const name = document.createElement("strong");
        name.textContent = rule.merchant;
        const category = document.createElement("span");
        category.textContent = rule.category || "Без категории";
        seller.append(name, category);
        seller.addEventListener("click", () => openRule(rule));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "remove";
        remove.textContent = "Убрать";
        remove.addEventListener("click", () => forgetRule(rule.merchant));
        row.append(seller, remove);
        return row;
      }));
    }

    function openSheet(id) {
      sheetMode = "payment";
      activeId = id;
      const payment = payments.find((item) => item.id === id);
      const seller = payment && (payment.name || payment.merchant);
      hint.textContent = seller ? "Запомнится для всех «" + seller + "»" : "";
      search.value = "";
      renderChoices();
      sheet.hidden = false;
      search.focus();
    }

    function openDraft() {
      sheetMode = "draft";
      hint.textContent = ruleMerchant.value.trim()
        ? "Для всех «" + ruleMerchant.value.trim() + "»"
        : "Сначала можно выбрать категорию";
      search.value = "";
      renderChoices();
      sheet.hidden = false;
      search.focus();
    }

    function openRule(rule) {
      sheetMode = "rule";
      ruleMerchant.value = rule.merchant;
      draftCategory = { id: rule.category_id, label: rule.category };
      ruleCategory.textContent = rule.category || "Выбрать категорию";
      hint.textContent = "Для всех «" + rule.merchant + "»";
      search.value = "";
      renderChoices();
      sheet.hidden = false;
      search.focus();
    }

    function closeSheet() {
      sheet.hidden = true;
      activeId = null;
    }

    function showError(text) {
      statusEl.hidden = false;
      statusEl.textContent = text;
    }

    function takePayments(payload) {
      const fresh = new Map((payload.payments || []).map((payment) => [payment.id, payment]));
      if (!fresh.size) return;
      payments = payments.map((payment) => fresh.get(payment.id) || payment);
    }

    async function save(categoryId) {
      if (sheetMode === "draft") {
        const category = categories.find((item) => item.id === categoryId);
        draftCategory = category || { id: categoryId, label: categoryId };
        ruleCategory.textContent = draftCategory.label;
        closeSheet();
        return;
      }
      if (sheetMode === "rule") {
        await storeRule(ruleMerchant.value.trim(), categoryId);
        closeSheet();
        return;
      }
      const response = await fetch("/admin/api/payments/" + activeId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category_id: categoryId }),
      });
      if (!response.ok) {
        showError("Не удалось сохранить.");
        return;
      }
      takePayments(await response.json());
      closeSheet();
      render();
      loadRules().catch(() => {});
    }

    async function storeRule(merchant, categoryId) {
      const response = await fetch("/admin/api/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant: merchant, category_id: categoryId }),
      });
      if (!response.ok) {
        showError("Не удалось запомнить продавца.");
        return false;
      }
      const payload = await response.json();
      rules = payload.rules || [];
      takePayments(payload);
      renderRules();
      render();
      statusEl.hidden = true;
      return true;
    }

    async function forgetRule(merchant) {
      await storeRule(merchant, null);
    }

    async function loadRules() {
      const response = await fetch("/admin/api/rules");
      if (!response.ok) throw new Error("rules");
      const payload = await response.json();
      rules = payload.rules || [];
      renderRules();
    }

    function accountLabel(account) {
      return [account.title, account.currency].filter(Boolean).join(", ");
    }

    function renderCards() {
      updateTabs();
      const visibleAccounts = accounts.filter((account) => !account.archive);
      accountNote.textContent = visibleAccounts.length
        ? "Счетов: " + visibleAccounts.length
        : "Сначала синхронизируйте счета.";
      if (!cards.length) {
        cardList.innerHTML = '<p class="empty">Карт в платежах пока нет.</p>';
        return;
      }
      cardList.replaceChildren(...cards.map((card) => {
        const row = document.createElement("div");
        row.className = "rule";
        const seller = document.createElement("div");
        seller.className = "seller";
        const name = document.createElement("strong");
        name.textContent = card.card;
        const select = document.createElement("select");
        select.className = "pick";
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = "Выбрать счёт";
        select.append(empty);
        for (const account of visibleAccounts) {
          const option = document.createElement("option");
          option.value = account.id;
          option.textContent = accountLabel(account);
          select.append(option);
        }
        if (card.account_id && !visibleAccounts.some((account) => account.id === card.account_id)) {
          const option = document.createElement("option");
          option.value = card.account_id;
          option.textContent = accountLabel(card);
          select.append(option);
        }
        select.value = card.account_id || "";
        select.addEventListener("change", () => storeCard(card.card, select.value || null));
        seller.append(name, select);
        row.append(seller);
        return row;
      }));
    }

    async function storeCard(card, accountId) {
      const response = await fetch("/admin/api/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ card: card, account_id: accountId }),
      });
      if (!response.ok) {
        showError("Не удалось сохранить карту.");
        return;
      }
      const payload = await response.json();
      cards = payload.cards || [];
      accounts = payload.accounts || accounts;
      statusEl.hidden = true;
      renderCards();
    }

    async function loadCards() {
      const response = await fetch("/admin/api/cards");
      if (!response.ok) throw new Error("cards");
      const payload = await response.json();
      cards = payload.cards || [];
      accounts = payload.accounts || [];
      renderCards();
    }

    async function syncAccounts() {
      const button = document.querySelector("#card-sync button");
      button.disabled = true;
      const response = await fetch("/admin/api/accounts/sync", { method: "POST" });
      button.disabled = false;
      if (!response.ok) {
        showError("Не удалось синхронизировать счета.");
        return;
      }
      const payload = await response.json();
      cards = payload.cards || [];
      accounts = payload.accounts || [];
      statusEl.hidden = true;
      renderCards();
    }

    function setFilter(missing) {
      onlyMissing = missing;
      onlyOpen.setAttribute("aria-pressed", String(missing));
      showAll.setAttribute("aria-pressed", String(!missing));
      render();
    }

    function setView(next) {
      view = next;
      document.querySelector("#view-payments").setAttribute("aria-pressed", String(next === "payments"));
      document.querySelector("#view-rules").setAttribute("aria-pressed", String(next === "rules"));
      document.querySelector("#view-cards").setAttribute("aria-pressed", String(next === "cards"));
      payFilter.hidden = next !== "payments";
      listEl.hidden = next !== "payments";
      rulesPanel.hidden = next !== "rules";
      cardsPanel.hidden = next !== "cards";
      updateTabs();
      if (next === "rules") loadRules().catch(() => showError("Не удалось загрузить продавцов."));
      if (next === "cards") loadCards().catch(() => showError("Не удалось загрузить карты."));
    }

    onlyOpen.addEventListener("click", () => setFilter(true));
    showAll.addEventListener("click", () => setFilter(false));
    document.querySelector("#view-payments").addEventListener("click", () => setView("payments"));
    document.querySelector("#view-rules").addEventListener("click", () => setView("rules"));
    document.querySelector("#view-cards").addEventListener("click", () => setView("cards"));
    document.querySelector("#card-sync").addEventListener("submit", (event) => {
      event.preventDefault();
      syncAccounts();
    });
    document.querySelector("#rule-category").addEventListener("click", openDraft);
    document.querySelector("#composer").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!ruleMerchant.value.trim() || !draftCategory) {
        showError("Нужны имя продавца и категория.");
        return;
      }
      storeRule(ruleMerchant.value.trim(), draftCategory.id).then((saved) => {
        if (!saved) return;
        ruleMerchant.value = "";
        draftCategory = null;
        ruleCategory.textContent = "Выбрать категорию";
      });
    });
    document.querySelector("#close").addEventListener("click", closeSheet);
    search.addEventListener("input", renderChoices);

    Promise.all([
      fetch("/admin/api/payments").then((response) => response.json()),
      fetch("/admin/api/categories").then((response) => response.json()),
      fetch("/admin/api/rules").then((response) => response.json()),
      fetch("/admin/api/cards").then((response) => response.json()),
    ]).then(([paymentPayload, categoryPayload, rulePayload, cardPayload]) => {
      payments = paymentPayload.payments || [];
      categories = categoryPayload.categories || [];
      rules = rulePayload.rules || [];
      cards = cardPayload.cards || [];
      accounts = cardPayload.accounts || [];
      renderRules();
      renderCards();
      if (!payments.some((payment) => !payment.category_id)) setFilter(false);
      else render();
    }).catch(() => {
      statusEl.hidden = false;
      statusEl.textContent = "Не удалось загрузить платежи.";
    });
  </script>
</body>
</html>`;
}
