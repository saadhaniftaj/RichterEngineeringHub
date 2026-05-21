#!/usr/bin/env bash
# deploy_async.sh — Upgrades the Spare Parts Hub to full async Textract pipeline
# Provisions: SNS, DynamoDB, Textract IAM role, Lambda A + B, wires everything
set -euo pipefail

ACCOUNT="185529490317"
REGION="us-east-1"
BUCKET="spare-parts-docs-${ACCOUNT}"
LAMBDA_ROLE="spare-parts-lambda-role"
LAMBDA_A="textract-kickoff"
LAMBDA_B="textract-completion-handler"
SNS_TOPIC="textract-completion"
DYNAMO_TABLE="spare-parts-doc-status"
TEXTRACT_ROLE="textract-sns-role"
OS_INDEX="spare_parts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAMBDA_DIR="${SCRIPT_DIR}/../lambda"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🏭  Spare Parts Hub — Async Pipeline Deploy"
echo "    Account: $ACCOUNT | Region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── STEP 1: Create SNS Topic ───────────────────────────────────────────────────
echo ""
echo "📢 [1/9] Creating SNS topic: $SNS_TOPIC"
SNS_ARN=$(aws sns create-topic \
  --name "$SNS_TOPIC" \
  --region "$REGION" \
  --query 'TopicArn' --output text)
echo "   ✓ SNS ARN: $SNS_ARN"

# ── STEP 2: Create DynamoDB Table ─────────────────────────────────────────────
echo ""
echo "🗄️  [2/9] Creating DynamoDB table: $DYNAMO_TABLE"
if aws dynamodb describe-table --table-name "$DYNAMO_TABLE" --region "$REGION" &>/dev/null; then
  echo "   ✓ Table already exists, skipping."
else
  aws dynamodb create-table \
    --table-name "$DYNAMO_TABLE" \
    --attribute-definitions AttributeName=doc_id,AttributeType=S \
    --key-schema AttributeName=doc_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION"
  echo "   ✓ DynamoDB table created."
fi

# ── STEP 3: Create IAM Role for Textract to publish to SNS ────────────────────
echo ""
echo "🔐 [3/9] Creating Textract→SNS IAM role: $TEXTRACT_ROLE"
TEXTRACT_TRUST='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "textract.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

if aws iam get-role --role-name "$TEXTRACT_ROLE" &>/dev/null; then
  echo "   ✓ Role already exists, skipping creation."
else
  aws iam create-role \
    --role-name "$TEXTRACT_ROLE" \
    --assume-role-policy-document "$TEXTRACT_TRUST"
  echo "   ✓ Role created."
fi

TEXTRACT_ROLE_ARN=$(aws iam get-role --role-name "$TEXTRACT_ROLE" --query 'Role.Arn' --output text)

# Attach SNS publish permission to the Textract role
aws iam put-role-policy \
  --role-name "$TEXTRACT_ROLE" \
  --policy-name "textract-sns-publish" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": \"sns:Publish\",
      \"Resource\": \"${SNS_ARN}\"
    }]
  }"
echo "   ✓ SNS publish policy attached. Role ARN: $TEXTRACT_ROLE_ARN"

# ── STEP 4: Update Lambda execution role inline policy ────────────────────────
echo ""
echo "🔐 [4/9] Updating Lambda execution role policy with new permissions"
aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE" \
  --policy-name "spare-parts-lambda-policy" \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {
        \"Sid\": \"S3Access\",
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\"],
        \"Resource\": [
          \"arn:aws:s3:::${BUCKET}\",
          \"arn:aws:s3:::${BUCKET}/*\"
        ]
      },
      {
        \"Sid\": \"TextractAsync\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"textract:StartDocumentAnalysis\",
          \"textract:GetDocumentAnalysis\",
          \"textract:AnalyzeDocument\"
        ],
        \"Resource\": \"*\"
      },
      {
        \"Sid\": \"IAMPassRole\",
        \"Effect\": \"Allow\",
        \"Action\": \"iam:PassRole\",
        \"Resource\": \"${TEXTRACT_ROLE_ARN}\"
      },
      {
        \"Sid\": \"DynamoDBAccess\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"dynamodb:PutItem\",
          \"dynamodb:GetItem\",
          \"dynamodb:UpdateItem\",
          \"dynamodb:Scan\",
          \"dynamodb:Query\"
        ],
        \"Resource\": \"arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${DYNAMO_TABLE}\"
      },
      {
        \"Sid\": \"OpenSearchAccess\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"es:ESHttpPost\",
          \"es:ESHttpPut\",
          \"es:ESHttpGet\",
          \"es:ESHttpHead\"
        ],
        \"Resource\": \"arn:aws:es:${REGION}:${ACCOUNT}:domain/spare-parts-search/*\"
      },
      {
        \"Sid\": \"CloudWatchLogs\",
        \"Effect\": \"Allow\",
        \"Action\": [
          \"logs:CreateLogGroup\",
          \"logs:CreateLogStream\",
          \"logs:PutLogEvents\"
        ],
        \"Resource\": \"arn:aws:logs:${REGION}:${ACCOUNT}:*\"
      }
    ]
  }"
echo "   ✓ Lambda role policy updated."

LAMBDA_ROLE_ARN=$(aws iam get-role --role-name "$LAMBDA_ROLE" --query 'Role.Arn' --output text)

# ── STEP 5: Package and Deploy Lambda A (kickoff) ─────────────────────────────
echo ""
echo "📦 [5/9] Packaging Lambda A: $LAMBDA_A"
cd "$LAMBDA_DIR"
zip -q kickoff.zip kickoff_handler.py

# Get current OS endpoint for env var
OS_ENDPOINT=$(aws opensearch describe-domain \
  --domain-name "spare-parts-search" \
  --region "$REGION" \
  --query 'DomainStatus.Endpoint' --output text 2>/dev/null || echo "pending")

if aws lambda get-function --function-name "$LAMBDA_A" --region "$REGION" &>/dev/null; then
  echo "   Updating existing Lambda A..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_A" \
    --zip-file fileb://kickoff.zip \
    --region "$REGION"
else
  echo "   Creating Lambda A..."
  aws lambda create-function \
    --function-name "$LAMBDA_A" \
    --runtime python3.11 \
    --role "$LAMBDA_ROLE_ARN" \
    --handler kickoff_handler.handler \
    --zip-file fileb://kickoff.zip \
    --timeout 30 \
    --memory-size 256 \
    --region "$REGION"
fi

sleep 5
aws lambda update-function-configuration \
  --function-name "$LAMBDA_A" \
  --handler kickoff_handler.handler \
  --timeout 30 \
  --environment "Variables={
    SNS_TOPIC_ARN=${SNS_ARN},
    TEXTRACT_SNS_ROLE_ARN=${TEXTRACT_ROLE_ARN},
    DYNAMODB_TABLE=${DYNAMO_TABLE},
    AWS_REGION_=${REGION}
  }" \
  --region "$REGION"
echo "   ✓ Lambda A deployed."

# ── STEP 6: Wire S3 to trigger Lambda A ───────────────────────────────────────
echo ""
echo "🔗 [6/9] Wiring S3 → Lambda A trigger"

# Remove old trigger first (textract-processor)
aws lambda remove-permission \
  --function-name "$LAMBDA_A" \
  --statement-id "s3-trigger" \
  --region "$REGION" 2>/dev/null || true

aws lambda add-permission \
  --function-name "$LAMBDA_A" \
  --statement-id "s3-trigger" \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::${BUCKET}" \
  --source-account "$ACCOUNT" \
  --region "$REGION"

LAMBDA_A_ARN=$(aws lambda get-function --function-name "$LAMBDA_A" --region "$REGION" --query 'Configuration.FunctionArn' --output text)

# Update S3 bucket notification to Lambda A
aws s3api put-bucket-notification-configuration \
  --bucket "$BUCKET" \
  --notification-configuration "{
    \"LambdaFunctionConfigurations\": [{
      \"LambdaFunctionArn\": \"${LAMBDA_A_ARN}\",
      \"Events\": [\"s3:ObjectCreated:*\"],
      \"Filter\": {
        \"Key\": {
          \"FilterRules\": [{\"Name\": \"prefix\", \"Value\": \"uploads/\"}]
        }
      }
    }]
  }"
echo "   ✓ S3 → Lambda A trigger configured."

# ── STEP 7: Package and Deploy Lambda B (completion) ──────────────────────────
echo ""
echo "📦 [7/9] Packaging Lambda B: $LAMBDA_B"

zip -q completion.zip completion_handler.py

if aws lambda get-function --function-name "$LAMBDA_B" --region "$REGION" &>/dev/null; then
  echo "   Updating existing Lambda B..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_B" \
    --zip-file fileb://completion.zip \
    --region "$REGION"
else
  echo "   Creating Lambda B..."
  aws lambda create-function \
    --function-name "$LAMBDA_B" \
    --runtime python3.11 \
    --role "$LAMBDA_ROLE_ARN" \
    --handler completion_handler.handler \
    --zip-file fileb://completion.zip \
    --timeout 900 \
    --memory-size 1024 \
    --region "$REGION"
fi

sleep 5
aws lambda update-function-configuration \
  --function-name "$LAMBDA_B" \
  --handler completion_handler.handler \
  --timeout 900 \
  --memory-size 1024 \
  --environment "Variables={
    OPENSEARCH_ENDPOINT=${OS_ENDPOINT},
    OPENSEARCH_INDEX=${OS_INDEX},
    DYNAMODB_TABLE=${DYNAMO_TABLE},
    AWS_REGION_=${REGION}
  }" \
  --region "$REGION"
echo "   ✓ Lambda B deployed."

# ── STEP 8: Wire SNS → Lambda B ───────────────────────────────────────────────
echo ""
echo "🔗 [8/9] Wiring SNS → Lambda B trigger"

LAMBDA_B_ARN=$(aws lambda get-function --function-name "$LAMBDA_B" --region "$REGION" --query 'Configuration.FunctionArn' --output text)

aws lambda remove-permission \
  --function-name "$LAMBDA_B" \
  --statement-id "sns-trigger" \
  --region "$REGION" 2>/dev/null || true

aws lambda add-permission \
  --function-name "$LAMBDA_B" \
  --statement-id "sns-trigger" \
  --action lambda:InvokeFunction \
  --principal sns.amazonaws.com \
  --source-arn "$SNS_ARN" \
  --region "$REGION"

aws sns subscribe \
  --topic-arn "$SNS_ARN" \
  --protocol lambda \
  --notification-endpoint "$LAMBDA_B_ARN" \
  --region "$REGION"
echo "   ✓ SNS → Lambda B trigger configured."

# ── STEP 9: Summary ───────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Async pipeline deployed successfully!"
echo ""
echo "   SNS Topic ARN    : $SNS_ARN"
echo "   Textract Role ARN: $TEXTRACT_ROLE_ARN"
echo "   Lambda A (kickoff): $LAMBDA_A_ARN"
echo "   Lambda B (completion): $LAMBDA_B_ARN"
echo "   DynamoDB Table: $DYNAMO_TABLE"
echo ""
echo "📋 Next steps:"
echo "   1. Upload a multi-page PDF via the web UI"
echo "   2. Watch the Documents tab — status will show 'Processing' then 'Indexed'"
echo "   3. Search for parts in the Search tab"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
