#!/usr/bin/env bash
# create_index.sh — Creates the spare_parts OpenSearch index after domain is ACTIVE
# Run this AFTER OpenSearch domain status shows Processing=false
set -euo pipefail

ACCOUNT="185529490317"
REGION="us-east-1"
OS_DOMAIN="spare-parts-search"
OS_INDEX="spare_parts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔍 Fetching OpenSearch endpoint..."
OS_ENDPOINT=$(aws opensearch describe-domain \
  --domain-name "$OS_DOMAIN" \
  --region "$REGION" \
  --query 'DomainStatus.Endpoint' \
  --output text)

if [ "$OS_ENDPOINT" = "None" ] || [ -z "$OS_ENDPOINT" ]; then
  echo "❌ OpenSearch endpoint not available yet. Check domain status:"
  echo "   aws opensearch describe-domain --domain-name $OS_DOMAIN --query 'DomainStatus.Processing'"
  exit 1
fi

echo "   Endpoint: $OS_ENDPOINT"
echo ""
echo "📋 Creating index: $OS_INDEX"

# Sign request with AWS SigV4 and create index
aws opensearchservice es-request \
  --domain-name "$OS_DOMAIN" 2>/dev/null || true

# Use curl with AWS SigV4 signing via aws cli
RESPONSE=$(aws opensearch-utils describe 2>/dev/null || \
  curl -s -X PUT \
    "https://${OS_ENDPOINT}/${OS_INDEX}" \
    -H "Content-Type: application/json" \
    --aws-sigv4 "aws:amz:${REGION}:es" \
    --user "$(aws configure get aws_access_key_id):$(aws configure get aws_secret_access_key)" \
    -d @"$SCRIPT_DIR/opensearch_index.json" 2>/dev/null)

echo "$RESPONSE"

echo ""
echo "✅ Index creation complete!"
echo ""
echo "📝 Now update the Lambda environment variable with the endpoint:"
echo "   aws lambda update-function-configuration \\"
echo "     --function-name textract-processor \\"
echo "     --environment 'Variables={OPENSEARCH_ENDPOINT=${OS_ENDPOINT},OPENSEARCH_INDEX=${OS_INDEX},MAX_PAGES=10}'"
