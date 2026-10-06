const NBS_RATES_URL = "https://kurs.resenje.org/api/v1/rates/today";

export function parseAltaSms(text) {
  const source = String(text || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
  const card = source.match(
    /Placanje VISA karticom \*\*(\d+): iznos ([0-9][0-9,]*\.\d{2})([A-Z]{3}), mesto (.+?), dana (\d{2}\.\d{2}\.\d{4}) u (\d{2}:\d{2}:\d{2})h\./i,
  );
  if (card) {
    return {
      kind: "card",
      card: `VISA **${card[1]}`,
      amount: usAmount(card[2]),
      currency: card[3].toUpperCase(),
      merchant: card[4].trim(),
      date: card[5],
      time: card[6],
      source,
    };
  }
  const transfer = source.match(
    /Odliv sa racuna: (\d+) u iznosu od: ([0-9][0-9,]*\.\d{2}) ([A-Z]{3}), dana: (\d{2}\.\d{2}\.\d{4})/i,
  );
  if (transfer) {
    return {
      kind: "transfer",
      account: transfer[1],
      card: "",
      amount: usAmount(transfer[2]),
      currency: transfer[3].toUpperCase(),
      merchant: "Prenesi",
      date: transfer[4],
      time: "00:00:00",
      source,
    };
  }
  return null;
}

export async function altaTransactionId(source) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `alta:${hex}`;
}

export function zonedTimeToIso(date, time, timeZone) {
  const [day, month, year] = date.split(".").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const zone = (timeZone || "").trim() || "Europe/Belgrade";
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = target;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utc));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const shown = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    );
    utc += target - shown;
  }
  return new Date(utc).toISOString();
}

export function zoneDate(timeZone) {
  const zone = (timeZone || "").trim() || "Europe/Belgrade";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const value = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${value("year")}-${value("month")}-${value("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function rsdFromRate(amount, middle, parity) {
  const unit = Number(parity) || 1;
  const rsd = (Number(amount) * Number(middle)) / unit;
  return (Math.round(rsd * 100) / 100).toFixed(2);
}

export async function ensureNbsRates(env) {
  await ensureNbsTable(env);
  const today = zoneDate(env.TIMEZONE);
  const have = await env.DB.prepare(
    "SELECT 1 AS ok FROM nbs_rates WHERE fetched_on = ? LIMIT 1",
  )
    .bind(today)
    .first();
  if (have) {
    return;
  }
  const rates = await fetchNbsRates();
  const statements = rates.map((rate) =>
    env.DB.prepare(
      `INSERT INTO nbs_rates (currency, rate_date, parity, middle, fetched_on)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(currency, rate_date) DO UPDATE SET
         parity = excluded.parity,
         middle = excluded.middle,
         fetched_on = excluded.fetched_on`,
    ).bind(rate.currency, rate.rateDate, rate.parity, rate.middle, today),
  );
  const chunkSize = 40;
  for (let index = 0; index < statements.length; index += chunkSize) {
    await env.DB.batch(statements.slice(index, index + chunkSize));
  }
}

export async function convertToRsd(env, currency, amount) {
  const code = String(currency || "").toUpperCase();
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (code === "RSD") {
    return {
      amount: (Math.round(numeric * 100) / 100).toFixed(2),
      currency: "RSD",
      rate: null,
      parity: null,
      rateDate: null,
    };
  }
  await ensureNbsTable(env);
  const rate = await env.DB.prepare(
    `SELECT middle, parity, rate_date
     FROM nbs_rates
     WHERE currency = ?
     ORDER BY rate_date DESC
     LIMIT 1`,
  )
    .bind(code)
    .first();
  if (!rate) {
    return null;
  }
  return {
    amount: rsdFromRate(numeric, rate.middle, rate.parity),
    currency: "RSD",
    rate: rate.middle,
    parity: rate.parity,
    rateDate: rate.rate_date,
  };
}

async function ensureNbsTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS nbs_rates (
      currency TEXT NOT NULL,
      rate_date TEXT NOT NULL,
      parity REAL NOT NULL,
      middle REAL NOT NULL,
      fetched_on TEXT NOT NULL,
      PRIMARY KEY (currency, rate_date)
    )`,
  ).run();
}

async function fetchNbsRates() {
  let response;
  try {
    response = await fetch(NBS_RATES_URL, { headers: { accept: "application/json" } });
  } catch {
    throw new Error("NBS rate request failed");
  }
  if (!response.ok) {
    throw new Error(`NBS rate HTTP ${response.status}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload.rates) ? payload.rates : [];
  const rates = rows
    .filter((row) => row && row.code && row.exchange_middle != null && row.date)
    .map((row) => ({
      currency: String(row.code).toUpperCase(),
      rateDate: String(row.date),
      parity: Number(row.parity) || 1,
      middle: Number(row.exchange_middle),
    }))
    .filter((row) => Number.isFinite(row.middle) && row.middle > 0);
  if (rates.length === 0) {
    throw new Error("NBS returned no rates");
  }
  return rates;
}

function usAmount(value) {
  return value.replaceAll(",", "");
}
