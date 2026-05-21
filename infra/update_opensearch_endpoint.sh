#!/usr/bin/env bash
# update_opensearch_endpoint.sh
# Run this once `aws opensearch describe-domain` shows Processing=false
# It:
#   1. Fetches the live OpenSearch endpoint
#   2. Creates the spare_parts index with fuzzy mappings
#   3. Updates the Lambda env var
#   4. Updates your .env.local for the Next.js frontend
set -euo pipefail

ACCOUNT="185529490317"
REGION="us-east-1"
OS_DOMAIN="spare-parts-search"
OS_INDEX="spare_parts"
LAMBDA_FN="textract-processor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../frontend/spare-parts-hub/.env.local"

echo "🔍 Checking OpenSearch domain status..."
PROCESSING=$(aws opensearch describe-domain \
  --domain-name "$OS_DOMAIN" \
  --region "$REGION" \
  --query 'DomainStatus.Processing' \
  --output text)

if [ "$PROCESSING" = "True" ]; then
  echo "⏳ Domain is still provisioning (Processing=True). Try again in a few minutes."
  exit 1
fi

OS_ENDPOINT=$(aws opensearch describe-domain \
  --domain-name "$OS_DOMAIN" \
  --region "$REGION" \
  --query 'DomainStatus.Endpoint' \
  --output text)

echo "✅ OpenSearch endpoint: $OS_ENDPOINT"

# ── Create Index ────────────────────────────────────────────────────────────
echo ""
echo "📋 Creating index: $OS_INDEX"

# Use awscurl approach: sign with SigV4 using python boto3
python3 - <<PYEOF
import boto3, json, requests
from requests_aws4auth import AWS4Auth

session = boto3.Session()
creds   = session.get_credentials()
awsauth = AWS4Auth(
    creds.access_key, creds.secret_key, "$REGION", "es",
    session_token=creds.token
)

endpoint = "https://$OS_ENDPOINT"
index    = "$OS_INDEX"

with open("$SCRIPT_DIR/opensearch_index.json") as f:
    mapping = json.load(f)

# Delete if exists (for clean re-create)
r = requests.head(f"{endpoint}/{index}", auth=awsauth)
if r.status_code == 200:
    requests.delete(f"{endpoint}/{index}", auth=awsauth)
    print(f"  Deleted existing index: {index}")

r = requests.put(
    f"{endpoint}/{index}",
    auth=awsauth,
    json=mapping,
    headers={"Content-Type": "application/json"},
    verify=True,
)
print(f"  Index creation: {r.status_code} — {r.text[:200]}")
PYEOF

# ── Update Lambda Env ────────────────────────────────────────────────────────
echo ""
echo "⚡ Updating Lambda environment variable..."
aws lambda update-function-configuration \
  --function-name "$LAMBDA_FN" \
  --region "$REGION" \
  --environment "Variables={OPENSEARCH_ENDPOINT=${OS_ENDPOINT},OPENSEARCH_INDEX=${OS_INDEX},MAX_PAGES=10}" \
  --query 'Environment.Variables' \
  --output table

# ── Update .env.local ────────────────────────────────────────────────────────
echo ""
echo "📝 Updating .env.local..."
sed -i '' "s|OPENSEARCH_ENDPOINT=.*|OPENSEARCH_ENDPOINT=${OS_ENDPOINT}|" "$ENV_FILE"
echo "  ✅ Updated: $ENV_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 All done! System is fully operational."
echo ""
echo "   OpenSearch: https://$OS_ENDPOINT"
echo "   Index:      $OS_INDEX"
echo ""
echo "➡️  Now restart Next.js: npm run dev"
echo "➡️  Upload a PDF, then search in the Search Center!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
