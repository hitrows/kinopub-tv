#!/bin/sh
# Upload worker.js as a Cloudflare Worker and turn on its workers.dev URL.
#
#   CLOUDFLARE_API_TOKEN=...  (template "Edit Cloudflare Workers")
#   CLOUDFLARE_ACCOUNT_ID=...
#   WORKER_NAME=kp-orsay      (optional)
#
# Prints the plain-HTTP URL to give the TV (KP_CLOUD_URL for proxy.py).
set -e
cd "$(dirname "$0")"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
NAME=${WORKER_NAME:-kp-orsay}
API=https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers
AUTH="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else (print(json.dumps(d.get("errors")), file=sys.stderr) or 1))'; }

curl -s -X PUT "$API/scripts/$NAME" -H "$AUTH" \
	-F 'metadata={"main_module":"worker.js","compatibility_date":"2026-10-01"};type=application/json' \
	-F "worker.js=@worker.js;type=application/javascript+module" | ok
curl -s -X POST "$API/scripts/$NAME/subdomain" -H "$AUTH" -H "Content-Type: application/json" \
	-d '{"enabled":true,"previews_enabled":false}' | ok

SUB=$(curl -s "$API/subdomain" -H "$AUTH" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("result") or {}).get("subdomain") or "")')
[ -n "$SUB" ] || { echo "this account has no workers.dev subdomain yet: create one in the dashboard (Workers & Pages) or PUT $API/subdomain"; exit 1; }
echo "http://$NAME.$SUB.workers.dev"
