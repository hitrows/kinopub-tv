#!/bin/sh
# How much of the Workers free plan (100,000 requests a day, reset at 00:00 UTC)
# the Worker has used today, plus the last 7 days.
#
#   CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...  ./worker/usage.sh
set -e
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}" "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
NAME=${WORKER_NAME:-kp-orsay}

python3 - "$CLOUDFLARE_ACCOUNT_ID" "$NAME" <<'PY' |
import datetime, json, sys
acc, name = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc)
since = (now - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
q = """query($acc:String!,$since:Date!,$name:String!){viewer{accounts(filter:{accountTag:$acc}){
  workersInvocationsAdaptive(limit:20,filter:{date_geq:$since,scriptName:$name},orderBy:[date_ASC]){
    sum{requests errors} dimensions{date}}}}}"""
print(json.dumps({"query": q, "variables": {"acc": acc, "since": since, "name": name}}))
PY
curl -s https://api.cloudflare.com/client/v4/graphql \
	-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data @- |
python3 -c '
import datetime, json, sys
d = json.load(sys.stdin)
if d.get("errors"):
    sys.exit("Cloudflare: %s" % d["errors"])
rows = d["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
days = {}
for r in rows:
    day = r["dimensions"]["date"]
    req, err = days.get(day, (0, 0))
    days[day] = (req + r["sum"]["requests"], err + r["sum"]["errors"])
today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
LIMIT = 100000
used = days.get(today, (0, 0))[0]
print("Сегодня (UTC %s): %d из %d запросов (%.1f%%), сброс в 00:00 UTC" % (today, used, LIMIT, used * 100.0 / LIMIT))
print("За 7 дней:")
for day in sorted(days):
    req, err = days[day]
    print("  %s  %7d запросов  %s" % (day, req, ("%d ошибок" % err) if err else ""))
'
