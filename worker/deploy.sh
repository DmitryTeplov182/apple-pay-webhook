#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$(dirname "$0")"

if [[ ! -f wrangler.toml ]]; then
  cp wrangler.toml.example wrangler.toml
fi

if grep -q 'zone_name = "example.com"' wrangler.toml; then
  echo "В worker/wrangler.toml укажите свой маршрут и зону." >&2
  exit 1
fi

if [[ ! -f "${root}/.env" ]]; then
  echo "Нет .env. Скопируйте .env.example и запишите WEBHOOK_ID." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source "${root}/.env"
set +a

if [[ ! "${WEBHOOK_ID:-}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "WEBHOOK_ID должен быть 64 строчными hex-символами." >&2
  exit 1
fi

database_id="$(wrangler d1 info apple-webhook --json 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    raise SystemExit(1)
print(json.loads(raw[start:])["uuid"])
' || true)"
if [[ -z "${database_id}" ]]; then
  create_output="$(wrangler d1 create apple-webhook --location weur)"
  echo "${create_output}"
  database_id="$(printf '%s\n' "${create_output}" | sed -n 's/.*database_id = "\([^"]*\)".*/\1/p' | head -n 1)"
fi

if [[ -z "${database_id}" ]]; then
  echo "Не удалось получить database_id для D1." >&2
  exit 1
fi

python3 - "${database_id}" <<'PY'
import pathlib, sys
database_id = sys.argv[1]
path = pathlib.Path("wrangler.toml")
text = path.read_text()
updated = text.replace('database_id = ""', f'database_id = "{database_id}"', 1)
if 'database_id = ""' in text:
    path.write_text(updated)
else:
    import re
    path.write_text(re.sub(r'database_id = "[^"]*"', f'database_id = "{database_id}"', text, count=1))
PY

wrangler d1 execute apple-webhook --remote --file=schema.sql
printf '%s' "${WEBHOOK_ID}" | wrangler secret put WEBHOOK_ID
printf '%s' "${DEBUG_BOT_TOKEN:-}" | wrangler secret put DEBUG_BOT_TOKEN
printf '%s' "${DEBUG_CHAT_ID:-}" | wrangler secret put DEBUG_CHAT_ID
printf '%s' "${NOTIFY_BOT_TOKEN:-}" | wrangler secret put NOTIFY_BOT_TOKEN
printf '%s' "${NOTIFY_CHAT_ID:-}" | wrangler secret put NOTIFY_CHAT_ID
if [[ -n "${ALTA_SMS_BOT_TOKEN:-}" ]]; then
  printf '%s' "${ALTA_SMS_BOT_TOKEN}" | wrangler secret put ALTA_SMS_BOT_TOKEN
fi
if [[ -n "${ALTA_SMS_BOT_ID:-}" ]]; then
  printf '%s' "${ALTA_SMS_BOT_ID}" | wrangler secret put ALTA_SMS_BOT_ID
fi
if [[ -n "${ZENMONEY_TOKEN:-}" ]]; then
  printf '%s' "${ZENMONEY_TOKEN}" | wrangler secret put ZENMONEY_TOKEN
fi
if [[ -n "${TIMEZONE:-}" ]]; then
  printf '%s' "${TIMEZONE}" | wrangler secret put TIMEZONE
fi
if [[ -n "${SHOW_CARD_NAME+x}" ]]; then
  printf '%s' "${SHOW_CARD_NAME}" | wrangler secret put SHOW_CARD_NAME
fi
wrangler deploy

host="$(sed -n 's/^pattern = "\([^"/]*\).*/\1/p' wrangler.toml | head -n 1)"
if [[ -n "${DEBUG_BOT_TOKEN:-}" && -n "${DEBUG_CHAT_ID:-}" ]]; then
  webhook_body="$(curl -sS -X POST "https://api.telegram.org/bot${DEBUG_BOT_TOKEN}/setWebhook" \
    -H "content-type: application/json" \
    --data "{\"url\":\"https://${host}/t/${WEBHOOK_ID}\",\"secret_token\":\"${WEBHOOK_ID}\",\"allowed_updates\":[\"message\"]}")"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("debug webhook", d.get("ok"), d.get("description", ""))' "${webhook_body}"
  keyboard_body="$(curl -sS -X POST "https://api.telegram.org/bot${DEBUG_BOT_TOKEN}/sendMessage" \
    -H "content-type: application/json" \
    --data "{\"chat_id\":\"${DEBUG_CHAT_ID}\",\"text\":\"Кнопка Sync categories обновляет категории Дзен-мани. То же самое происходит каждый час.\",\"reply_markup\":{\"keyboard\":[[{\"text\":\"Sync categories\"}]],\"resize_keyboard\":true,\"is_persistent\":true}}")"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("debug keyboard", d.get("ok"))' "${keyboard_body}"
fi
if [[ -n "${NOTIFY_BOT_TOKEN:-}" ]]; then
  notify_webhook="$(curl -sS -X POST "https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/setWebhook" \
    -H "content-type: application/json" \
    --data "{\"url\":\"https://${host}/n/${WEBHOOK_ID}\",\"secret_token\":\"${WEBHOOK_ID}\",\"allowed_updates\":[\"message\"]}")"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("notify webhook", d.get("ok"), d.get("description", ""))' "${notify_webhook}"
fi
if [[ -n "${ALTA_SMS_BOT_TOKEN:-}" ]]; then
  alta_webhook="$(curl -sS -X POST "https://api.telegram.org/bot${ALTA_SMS_BOT_TOKEN}/setWebhook" \
    -H "content-type: application/json" \
    --data "{\"url\":\"https://${host}/a/${WEBHOOK_ID}\",\"secret_token\":\"${WEBHOOK_ID}\",\"allowed_updates\":[\"message\"]}")"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("alta webhook", d.get("ok"), d.get("description", ""))' "${alta_webhook}"
fi
echo "Готово: https://${host}/w/<WEBHOOK_ID из .env>"
