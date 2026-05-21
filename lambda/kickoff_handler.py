"""
Lambda A: textract-kickoff
Triggered by S3 PutObject event.
- Calls textract.start_document_analysis (async, supports multi-page PDFs)
- Writes processing status to DynamoDB
- Old sync handler is fully replaced by this.
"""
import json
import os
import logging
import re
import urllib.parse
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION         = os.environ.get("AWS_REGION", "us-east-1")
SNS_TOPIC_ARN  = os.environ["SNS_TOPIC_ARN"]
DYNAMO_TABLE   = os.environ.get("DYNAMODB_TABLE", "spare-parts-doc-status")

textract = boto3.client("textract", region_name=REGION)
dynamo   = boto3.resource("dynamodb", region_name=REGION)
table    = dynamo.Table(DYNAMO_TABLE)


def handler(event, context):
    logger.info("Kickoff event: %s", json.dumps(event))

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key    = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        size   = record["s3"]["object"].get("size", 0)

        if not key.lower().endswith(".pdf"):
            logger.info("Skipping non-PDF: %s", key)
            continue

        filename    = key.split("/")[-1]
        # Strip timestamp prefix for display: "1234567890-myfile.pdf" -> "myfile.pdf"
        clean_name  = "-".join(filename.split("-")[1:]) if "-" in filename else filename
        doc_id      = key  # use the S3 key as the unique identifier

        logger.info("Starting async Textract job for: %s", key)

        try:
            # JobTag: Textract only allows [a-zA-Z0-9_.-:] max 64 chars
            # We use a sanitized short tag just for CloudWatch traceability
            safe_tag = re.sub(r'[^a-zA-Z0-9_.\-:]', '_', filename)[:64]

            response = textract.start_document_analysis(
                DocumentLocation={
                    "S3Object": {"Bucket": bucket, "Name": key}
                },
                FeatureTypes=["TABLES", "FORMS"],
                NotificationChannel={
                    "SNSTopicArn": SNS_TOPIC_ARN,
                    "RoleArn": os.environ["TEXTRACT_SNS_ROLE_ARN"],
                },
                JobTag=safe_tag,
            )

            job_id = response["JobId"]
            logger.info("Textract job started: %s for %s", job_id, key)

            # Write initial status to DynamoDB
            table.put_item(Item={
                "doc_id":      doc_id,
                "job_id":      job_id,
                "filename":    clean_name,
                "s3_key":      key,
                "bucket":      bucket,
                "file_size":   size,
                "status":      "processing",
                "page_count":  None,
                "row_count":   None,
                "error":       None,
                "started_at":  datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
            })

        except Exception as exc:
            logger.error("Failed to start Textract job for %s: %s", key, exc, exc_info=True)
            # Write failure status to DynamoDB
            table.put_item(Item={
                "doc_id":      doc_id,
                "job_id":      "N/A",
                "filename":    clean_name,
                "s3_key":      key,
                "bucket":      bucket,
                "file_size":   size,
                "status":      "failed",
                "error":       str(exc),
                "started_at":  datetime.now(timezone.utc).isoformat(),
                "finished_at": datetime.now(timezone.utc).isoformat(),
            })
            raise
