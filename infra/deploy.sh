#!/usr/bin/env bash
# ============================================================
#  Richter Engineering Spare Parts Hub — Full Deploy Script
#  Target: eu-central-1 (Frankfurt) — closest to Germany
#  Usage: bash infra/deploy.sh
# ============================================================
set -e

REGION="eu-central-1"
ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text)
BUCKET="spare-parts-docs-${ACCOUNT}"
DYNAMO_TABLE="spare-parts-doc-status"
OS_DOMAIN="spare-parts-search"
SNS_NAME="textract-completion"
LAMBDA_ROLE="spare-parts-lambda-role"
TEXTRACT_ROLE="textract-sns-role"
LAMBDA_A="textract-kickoff"
LAMBDA_B="textract-completion-handler"
OS_INDEX="spare_parts"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🏭  Spare Parts Hub — Full Deploy"
echo "    Account: ${ACCOUNT} | Region: ${REGION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. S3 Bucket ─────────────────────────────────────────
echo ""
echo "🪣 [1/11] Creating S3 bucket: ${BUCKET}"
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "   ✓ Bucket already exists."
else
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  echo "   ✓ Bucket created."
fi

aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-cors \
  --bucket "$BUCKET" \
  --cors-configuration '{
    "CORSRules": [{
      "AllowedHeaders": ["*"],
      "AllowedMethods": ["GET","PUT","POST"],
      "AllowedOrigins": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3000
    }]
  }'
echo "   ✓ S3 configured (versioning, CORS, public block)."

# ── 2. SNS Topic ─────────────────────────────────────────
echo ""
echo "📢 [2/11] Creating SNS topic: ${SNS_NAME}"
SNS_ARN=$(aws sns create-topic \
  --name "$SNS_NAME" \
  --region "$REGION" \
  --query 'TopicArn' --output text)
echo "   ✓ SNS ARN: ${SNS_ARN}"

# ── 3. DynamoDB ───────────────────────────────────────────
echo ""
echo "🗄️  [3/11] Creating DynamoDB table: ${DYNAMO_TABLE}"
if aws dynamodb describe-table --table-name "$DYNAMO_TABLE" --region "$REGION" &>/dev/null; then
  echo "   ✓ Table already exists."
else
  aws dynamodb create-table \
    --table-name "$DYNAMO_TABLE" \
    --attribute-definitions AttributeName=doc_id,AttributeType=S \
    --key-schema AttributeName=doc_id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION"
  aws dynamodb wait table-exists --table-name "$DYNAMO_TABLE" --region "$REGION"
  echo "   ✓ DynamoDB table created."
fi

# ── 4. IAM: textract-sns-role ────────────────────────────
echo ""
echo "🔐 [4/11] Creating IAM role: ${TEXTRACT_ROLE}"
if aws iam get-role --role-name "$TEXTRACT_ROLE" &>/dev/null; then
  echo "   ✓ Role already exists."
else
  aws iam create-role \
    --role-name "$TEXTRACT_ROLE" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"textract.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' > /dev/null
fi
TEXTRACT_ROLE_ARN=$(aws iam get-role --role-name "$TEXTRACT_ROLE" --query 'Role.Arn' --output text)
aws iam put-role-policy \
  --role-name "$TEXTRACT_ROLE" \
  --policy-name "textract-sns-publish" \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sns:Publish\",\"Resource\":\"${SNS_ARN}\"}]
  }"
echo "   ✓ textract-sns-role ARN: ${TEXTRACT_ROLE_ARN}"

# ── 5. IAM: spare-parts-lambda-role ─────────────────────
echo ""
echo "🔐 [5/11] Creating IAM role: ${LAMBDA_ROLE}"
if aws iam get-role --role-name "$LAMBDA_ROLE" &>/dev/null; then
  echo "   ✓ Role already exists."
else
  aws iam create-role \
    --role-name "$LAMBDA_ROLE" \
    --description "Execution role for Spare Parts Hub Lambdas" \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' > /dev/null
fi
LAMBDA_ROLE_ARN=$(aws iam get-role --role-name "$LAMBDA_ROLE" --query 'Role.Arn' --output text)
aws iam put-role-policy \
  --role-name "$LAMBDA_ROLE" \
  --policy-name "spare-parts-lambda-policy" \
  --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[
      {\"Sid\":\"S3Access\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:ListBucket\",\"s3:DeleteObject\"],\"Resource\":[\"arn:aws:s3:::${BUCKET}\",\"arn:aws:s3:::${BUCKET}/*\"]},
      {\"Sid\":\"TextractAsync\",\"Effect\":\"Allow\",\"Action\":[\"textract:StartDocumentAnalysis\",\"textract:GetDocumentAnalysis\",\"textract:AnalyzeDocument\"],\"Resource\":\"*\"},
      {\"Sid\":\"IAMPassRole\",\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"${TEXTRACT_ROLE_ARN}\"},
      {\"Sid\":\"DynamoDB\",\"Effect\":\"Allow\",\"Action\":[\"dynamodb:PutItem\",\"dynamodb:GetItem\",\"dynamodb:UpdateItem\",\"dynamodb:Scan\",\"dynamodb:Query\",\"dynamodb:DeleteItem\"],\"Resource\":\"arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${DYNAMO_TABLE}\"},
      {\"Sid\":\"OpenSearch\",\"Effect\":\"Allow\",\"Action\":[\"es:ESHttpPost\",\"es:ESHttpPut\",\"es:ESHttpGet\",\"es:ESHttpHead\",\"es:ESHttpDelete\"],\"Resource\":\"arn:aws:es:${REGION}:${ACCOUNT}:domain/${OS_DOMAIN}/*\"},
      {\"Sid\":\"CloudWatch\",\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:${REGION}:${ACCOUNT}:*\"}
    ]
  }"
echo "   ✓ Lambda role ARN: ${LAMBDA_ROLE_ARN}"

# Wait for IAM propagation
echo "   ⏳ Waiting 10s for IAM propagation..."
sleep 10

# ── 6. OpenSearch Domain ─────────────────────────────────
echo ""
echo "🔍 [6/11] Creating OpenSearch domain: ${OS_DOMAIN}"
if aws opensearch describe-domain --domain-name "$OS_DOMAIN" --region "$REGION" &>/dev/null; then
  echo "   ✓ Domain already exists."
else
  aws opensearch create-domain \
    --domain-name "$OS_DOMAIN" \
    --engine-version "OpenSearch_2.11" \
    --cluster-config "InstanceType=t3.small.search,InstanceCount=1" \
    --ebs-options "EBSEnabled=true,VolumeType=gp3,VolumeSize=10,Iops=3000,Throughput=125" \
    --encryption-at-rest-options "Enabled=true" \
    --node-to-node-encryption-options "Enabled=true" \
    --domain-endpoint-options "EnforceHTTPS=true,TLSSecurityPolicy=Policy-Min-TLS-1-2-2019-07" \
    --access-policies "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::${ACCOUNT}:root\"},\"Action\":\"es:*\",\"Resource\":\"arn:aws:es:${REGION}:${ACCOUNT}:domain/${OS_DOMAIN}/*\"}]}" \
    --region "$REGION" > /dev/null
  echo "   ⏳ Domain creation initiated — takes ~15 minutes. Continuing with other steps..."
fi

# ── 7. Lambda A: textract-kickoff ────────────────────────
echo ""
echo "📦 [7/11] Deploying Lambda A: ${LAMBDA_A}"
cd "$(dirname "$0")/../lambda"
zip -q kickoff_deploy.zip kickoff_handler.py

if aws lambda get-function --function-name "$LAMBDA_A" --region "$REGION" &>/dev/null; then
  aws lambda update-function-code \
    --function-name "$LAMBDA_A" \
    --zip-file fileb://kickoff_deploy.zip \
    --region "$REGION" --output text --query 'CodeSize' > /dev/null
  echo "   ✓ Lambda A updated."
else
  aws lambda create-function \
    --function-name "$LAMBDA_A" \
    --runtime python3.11 \
    --role "$LAMBDA_ROLE_ARN" \
    --handler kickoff_handler.handler \
    --zip-file fileb://kickoff_deploy.zip \
    --timeout 30 \
    --memory-size 256 \
    --region "$REGION" > /dev/null
  echo "   ✓ Lambda A created."
fi
sleep 5
aws lambda update-function-configuration \
  --function-name "$LAMBDA_A" \
  --environment "Variables={SNS_TOPIC_ARN=${SNS_ARN},TEXTRACT_SNS_ROLE_ARN=${TEXTRACT_ROLE_ARN},DYNAMODB_TABLE=${DYNAMO_TABLE}}" \
  --region "$REGION" --output text --query 'LastUpdateStatus' > /dev/null
LAMBDA_A_ARN=$(aws lambda get-function --function-name "$LAMBDA_A" --region "$REGION" --query 'Configuration.FunctionArn' --output text)
echo "   ✓ Lambda A ARN: ${LAMBDA_A_ARN}"

# ── 8. Lambda B: textract-completion-handler ────────────
echo ""
echo "📦 [8/11] Packaging & deploying Lambda B: ${LAMBDA_B}"
pip3 install opensearch-py requests-aws4auth boto3 -t ./package_deploy --quiet
cp completion_handler.py package_deploy/
cd package_deploy
zip -qr ../completion_deploy.zip . -x "*.pyc" -x "*/__pycache__/*"
cd ..

if aws lambda get-function --function-name "$LAMBDA_B" --region "$REGION" &>/dev/null; then
  aws lambda update-function-code \
    --function-name "$LAMBDA_B" \
    --zip-file fileb://completion_deploy.zip \
    --region "$REGION" --output text --query 'CodeSize' > /dev/null
  echo "   ✓ Lambda B code updated."
else
  aws lambda create-function \
    --function-name "$LAMBDA_B" \
    --runtime python3.11 \
    --role "$LAMBDA_ROLE_ARN" \
    --handler completion_handler.handler \
    --zip-file fileb://completion_deploy.zip \
    --timeout 900 \
    --memory-size 1024 \
    --region "$REGION" > /dev/null
  echo "   ✓ Lambda B created."
fi

# Wait for OpenSearch endpoint
echo ""
echo "   ⏳ Waiting for OpenSearch domain to become Active..."
while true; do
  STATUS=$(aws opensearch describe-domain --domain-name "$OS_DOMAIN" --region "$REGION" \
    --query 'DomainStatus.Processing' --output text 2>/dev/null)
  if [ "$STATUS" = "False" ]; then break; fi
  echo "   ... still processing, waiting 30s..."
  sleep 30
done

OS_ENDPOINT=$(aws opensearch describe-domain \
  --domain-name "$OS_DOMAIN" --region "$REGION" \
  --query 'DomainStatus.Endpoint' --output text)
echo "   ✓ OpenSearch endpoint: ${OS_ENDPOINT}"

sleep 5
aws lambda update-function-configuration \
  --function-name "$LAMBDA_B" \
  --environment "Variables={OPENSEARCH_ENDPOINT=${OS_ENDPOINT},OPENSEARCH_INDEX=${OS_INDEX},DYNAMODB_TABLE=${DYNAMO_TABLE}}" \
  --region "$REGION" --output text --query 'LastUpdateStatus' > /dev/null
LAMBDA_B_ARN=$(aws lambda get-function --function-name "$LAMBDA_B" --region "$REGION" --query 'Configuration.FunctionArn' --output text)
echo "   ✓ Lambda B ARN: ${LAMBDA_B_ARN}"

# ── 9. OpenSearch Index Mapping ──────────────────────────
echo ""
echo "🗂️  [9/11] Creating OpenSearch index: ${OS_INDEX}"
INDEX_EXISTS=$(curl -s -o /dev/null -w "%{http_code}" \
  "https://${OS_ENDPOINT}/${OS_INDEX}" \
  --aws-sigv4 "aws:amz:${REGION}:es" \
  --user "$(aws configure get aws_access_key_id):$(aws configure get aws_secret_access_key)")

if [ "$INDEX_EXISTS" = "200" ]; then
  echo "   ✓ Index already exists."
else
  curl -s -X PUT "https://${OS_ENDPOINT}/${OS_INDEX}" \
    --aws-sigv4 "aws:amz:${REGION}:es" \
    --user "$(aws configure get aws_access_key_id):$(aws configure get aws_secret_access_key)" \
    -H "Content-Type: application/json" \
    -d '{
      "settings":{
        "analysis":{
          "tokenizer":{"part_ngram_tokenizer":{"type":"ngram","min_gram":2,"max_gram":12,"token_chars":["letter","digit","punctuation"]}},
          "analyzer":{"part_number_analyzer":{"type":"custom","tokenizer":"part_ngram_tokenizer","filter":["lowercase"]}}
        },
        "index":{"max_ngram_diff":11}
      },
      "mappings":{"properties":{
        "document_name":{"type":"text","fields":{"keyword":{"type":"keyword"}}},
        "s3_key":{"type":"keyword"},
        "page_number":{"type":"integer"},
        "table_index":{"type":"integer"},
        "row_index":{"type":"integer"},
        "part_number":{"type":"text","analyzer":"part_number_analyzer","fields":{"keyword":{"type":"keyword"}}},
        "description":{"type":"text","fields":{"keyword":{"type":"keyword"}}},
        "quantity":{"type":"keyword"},
        "unit":{"type":"keyword"},
        "raw_row_text":{"type":"text"},
        "indexed_at":{"type":"date"}
      }}
    }' | python3 -m json.tool
  echo "   ✓ Index created with n-gram mapping."
fi

# ── 10. Wire S3 → Lambda A ───────────────────────────────
echo ""
echo "🔗 [10/11] Wiring S3 → Lambda A trigger"
aws lambda add-permission \
  --function-name "$LAMBDA_A" \
  --statement-id "s3-trigger" \
  --action lambda:InvokeFunction \
  --principal s3.amazonaws.com \
  --source-arn "arn:aws:s3:::${BUCKET}" \
  --source-account "$ACCOUNT" \
  --region "$REGION" 2>/dev/null || echo "   (permission already exists)"

aws s3api put-bucket-notification-configuration \
  --bucket "$BUCKET" \
  --notification-configuration "{
    \"LambdaFunctionConfigurations\":[{
      \"LambdaFunctionArn\":\"${LAMBDA_A_ARN}\",
      \"Events\":[\"s3:ObjectCreated:*\"],
      \"Filter\":{\"Key\":{\"FilterRules\":[{\"Name\":\"prefix\",\"Value\":\"uploads/\"}]}}
    }]
  }"
echo "   ✓ S3 → Lambda A trigger set."

# ── 11. Wire SNS → Lambda B ──────────────────────────────
echo ""
echo "🔗 [11/11] Wiring SNS → Lambda B trigger"
aws lambda add-permission \
  --function-name "$LAMBDA_B" \
  --statement-id "sns-trigger" \
  --action lambda:InvokeFunction \
  --principal sns.amazonaws.com \
  --source-arn "$SNS_ARN" \
  --region "$REGION" 2>/dev/null || echo "   (permission already exists)"

aws sns subscribe \
  --topic-arn "$SNS_ARN" \
  --protocol lambda \
  --notification-endpoint "$LAMBDA_B_ARN" \
  --region "$REGION" > /dev/null
echo "   ✓ SNS → Lambda B wired."

# ── Write .env.local for frontend ────────────────────────
ENV_FILE="$(dirname "$0")/../frontend/spare-parts-hub/.env.local"
cat > "$ENV_FILE" <<EOF
NEXT_PUBLIC_AWS_REGION=${REGION}
AWS_REGION=${REGION}
AWS_S3_BUCKET=${BUCKET}
OPENSEARCH_ENDPOINT=${OS_ENDPOINT}
OPENSEARCH_INDEX=${OS_INDEX}
DYNAMODB_TABLE=${DYNAMO_TABLE}
EOF
echo ""
echo "   ✓ .env.local written for frontend."

# ── Summary ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Deploy complete!"
echo ""
echo "   Region          : ${REGION}"
echo "   S3 Bucket       : ${BUCKET}"
echo "   OpenSearch      : https://${OS_ENDPOINT}"
echo "   SNS Topic       : ${SNS_ARN}"
echo "   Lambda A        : ${LAMBDA_A_ARN}"
echo "   Lambda B        : ${LAMBDA_B_ARN}"
echo "   DynamoDB        : ${DYNAMO_TABLE}"
echo ""
echo "   Next: cd frontend/spare-parts-hub && npm run dev"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Cleanup temp build dirs
rm -rf package_deploy kickoff_deploy.zip completion_deploy.zip
