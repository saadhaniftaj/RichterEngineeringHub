"""
Lambda B: textract-completion-handler
Triggered by SNS notification from Textract when async job is done.
- Paginates through all Textract result blocks
- Parses tables page by page
- Bulk indexes to OpenSearch
- Updates DynamoDB status to "indexed" or "failed"
"""
import json
import os
import logging
from datetime import datetime, timezone
from typing import Optional

import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION            = os.environ.get("AWS_REGION", "us-east-1")
OPENSEARCH_HOST   = os.environ["OPENSEARCH_ENDPOINT"]
OPENSEARCH_INDEX  = os.environ.get("OPENSEARCH_INDEX", "spare_parts")
DYNAMO_TABLE      = os.environ.get("DYNAMODB_TABLE", "spare-parts-doc-status")
BATCH_SIZE        = 500   # Docs per OpenSearch bulk request

textract  = boto3.client("textract", region_name=REGION)
dynamo    = boto3.resource("dynamodb", region_name=REGION)
table     = dynamo.Table(DYNAMO_TABLE)
session   = boto3.Session()
creds     = session.get_credentials()

awsauth = AWS4Auth(
    creds.access_key,
    creds.secret_key,
    REGION,
    "es",
    session_token=creds.token,
)

os_client = OpenSearch(
    hosts=[{"host": OPENSEARCH_HOST, "port": 443}],
    http_auth=awsauth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    timeout=60,
)


def handler(event, context):
    """Entry point — receives SNS notification from Textract."""
    for record in event.get("Records", []):
        sns_msg = json.loads(record["Sns"]["Message"])
        job_id  = sns_msg.get("JobId")
        status  = sns_msg.get("Status")

        logger.info("Textract job %s finished with status: %s", job_id, status)

        # Resolve the s3_key by looking up job_id in DynamoDB
        s3_key = _lookup_s3_key(job_id)
        if not s3_key:
            logger.error("Could not find DynamoDB record for job_id: %s", job_id)
            return

        if status != "SUCCEEDED":
            logger.error("Textract job %s failed with status: %s", job_id, status)
            _update_status(s3_key, "failed", error=f"Textract status: {status}")
            return

        try:
            _process_completed_job(job_id, s3_key)
        except Exception as exc:
            logger.error("Error processing job %s: %s", job_id, exc, exc_info=True)
            _update_status(s3_key, "failed", error=str(exc))
            raise


def _lookup_s3_key(job_id: str) -> Optional[str]:
    """Scan DynamoDB to find the s3_key that matches this Textract job_id."""
    try:
        resp  = table.scan(
            FilterExpression="job_id = :jid",
            ExpressionAttributeValues={":jid": job_id}
        )
        items = resp.get("Items", [])
        if items:
            return items[0].get("s3_key") or items[0].get("doc_id")
    except Exception as exc:
        logger.error("DynamoDB lookup failed for job_id %s: %s", job_id, exc)
    return None


def _process_completed_job(job_id: str, s3_key: str):
    """Paginate through all Textract blocks, parse tables, index to OpenSearch."""
    document_name = s3_key.split("/")[-1]
    clean_name    = "-".join(document_name.split("-")[1:]) if "-" in document_name else document_name

    all_blocks   = []
    next_token   = None
    page_count   = 0

    logger.info("Fetching Textract results for job %s", job_id)

    # Paginate through all result pages
    while True:
        kwargs = {"JobId": job_id}
        if next_token:
            kwargs["NextToken"] = next_token

        response   = textract.get_document_analysis(**kwargs)
        blocks     = response.get("Blocks", [])
        all_blocks.extend(blocks)

        meta = response.get("DocumentMetadata", {})
        page_count = meta.get("Pages", page_count)

        next_token = response.get("NextToken")
        if not next_token:
            break

    logger.info("Fetched %d total blocks across %d pages for %s", len(all_blocks), page_count, clean_name)

    # Parse and index
    documents = parse_textract_tables(all_blocks, clean_name, s3_key)
    if not documents:
        logger.warning("No tables found — falling back to raw text lines")
        documents = parse_raw_text(all_blocks, clean_name, s3_key)

    row_count = len(documents)
    logger.info("Parsed %d indexable rows from %s", row_count, clean_name)

    if documents:
        bulk_index(documents)

    _update_status(
        s3_key,
        "indexed",
        page_count=page_count,
        row_count=row_count,
    )


# ── Table Parser ───────────────────────────────────────────────────────────────

def parse_textract_tables(blocks: list, document_name: str, s3_key: str) -> list:
    """Parse Textract TABLES blocks into structured rows ready for OpenSearch."""
    block_map = {b["Id"]: b for b in blocks}
    tables    = [b for b in blocks if b["BlockType"] == "TABLE"]
    documents = []

    for table_idx, table in enumerate(tables):
        page_number = table.get("Page", 1)

        cells: dict = {}
        for rel in table.get("Relationships", []):
            if rel["Type"] == "CHILD":
                for cell_id in rel["Ids"]:
                    cell = block_map.get(cell_id)
                    if cell and cell["BlockType"] == "CELL":
                        row = cell["RowIndex"]
                        col = cell["ColumnIndex"]
                        cells[(row, col)] = {
                            "text": _cell_text(cell, block_map),
                            "row": row, "col": col,
                        }

        if not cells:
            continue

        max_row = max(k[0] for k in cells)
        max_col = max(k[1] for k in cells)
        headers = {
            col: cells.get((1, col), {}).get("text", f"col_{col}").strip().lower()
            for col in range(1, max_col + 1)
        }
        field_map = _map_headers(headers, max_col)

        for row_idx in range(2, max_row + 1):
            row_data = {
                col: cells.get((row_idx, col), {}).get("text", "").strip()
                for col in range(1, max_col + 1)
            }
            part_number = row_data.get(field_map.get("part_number"), "")
            description = row_data.get(field_map.get("description"), "")
            quantity    = row_data.get(field_map.get("quantity"), "")
            unit        = row_data.get(field_map.get("unit"), "")
            raw_row     = " | ".join(v for v in row_data.values() if v)

            if not raw_row:
                continue

            documents.append({
                "document_name": document_name,
                "s3_key":        s3_key,
                "page_number":   page_number,
                "table_index":   table_idx,
                "row_index":     row_idx,
                "part_number":   part_number,
                "description":   description,
                "quantity":      quantity,
                "unit":          unit,
                "raw_row_text":  raw_row,
                "indexed_at":    datetime.now(timezone.utc).isoformat(),
            })

    return documents


def parse_raw_text(blocks: list, document_name: str, s3_key: str) -> list:
    """Fallback: index LINE blocks when no tables are detected."""
    return [
        {
            "document_name": document_name,
            "s3_key":        s3_key,
            "page_number":   b.get("Page", 1),
            "table_index":   -1,
            "row_index":     -1,
            "part_number":   "",
            "description":   b.get("Text", "").strip(),
            "quantity":      "",
            "unit":          "",
            "raw_row_text":  b.get("Text", "").strip(),
            "indexed_at":    datetime.now(timezone.utc).isoformat(),
        }
        for b in blocks
        if b["BlockType"] == "LINE" and b.get("Text", "").strip()
    ]


def _cell_text(cell: dict, block_map: dict) -> str:
    words = []
    for rel in cell.get("Relationships", []):
        if rel["Type"] == "CHILD":
            for wid in rel["Ids"]:
                wb = block_map.get(wid)
                if wb and wb["BlockType"] == "WORD":
                    words.append(wb.get("Text", ""))
    return " ".join(words)


def _map_headers(headers: dict, max_col: int) -> dict:
    PART_KEYWORDS = {"part","part no","part number","teilenummer","art.","artikel",
                     "artikelnr","artikelnummer","bestell","nr.","no.","ref","p/n",
                     "item","pos","position"}
    DESC_KEYWORDS = {"description","desc","bezeichnung","name","benennung",
                     "text","detail","component","bezeichn"}
    QTY_KEYWORDS  = {"qty","quantity","menge","anzahl","count","pcs","stk","stück"}
    UNIT_KEYWORDS = {"unit","einheit","uom","ea","piece"}

    field_map = {}
    for col, header in headers.items():
        h = header.lower().strip()
        if any(kw in h for kw in PART_KEYWORDS) and "part_number" not in field_map.values():
            field_map["part_number"] = col
        elif any(kw in h for kw in DESC_KEYWORDS) and "description" not in field_map.values():
            field_map["description"] = col
        elif any(kw in h for kw in QTY_KEYWORDS) and "quantity" not in field_map.values():
            field_map["quantity"] = col
        elif any(kw in h for kw in UNIT_KEYWORDS) and "unit" not in field_map.values():
            field_map["unit"] = col

    if "part_number" not in field_map and max_col >= 1: field_map["part_number"] = 1
    if "description"  not in field_map and max_col >= 2: field_map["description"]  = 2
    if "quantity"     not in field_map and max_col >= 3: field_map["quantity"]     = 3
    return field_map


# ── OpenSearch Bulk Indexer ────────────────────────────────────────────────────

def bulk_index(documents: list):
    """Bulk index in batches of BATCH_SIZE to avoid request size limits."""
    for i in range(0, len(documents), BATCH_SIZE):
        batch   = documents[i:i + BATCH_SIZE]
        actions = []
        for doc in batch:
            actions.append({"index": {"_index": OPENSEARCH_INDEX}})
            actions.append(doc)

        response = os_client.bulk(body=actions, index=OPENSEARCH_INDEX)
        if response.get("errors"):
            errors = [item for item in response["items"] if item.get("index", {}).get("error")]
            logger.error("Bulk index errors (batch %d): %s", i // BATCH_SIZE, json.dumps(errors[:3]))
        else:
            logger.info("Indexed batch %d: %d docs", i // BATCH_SIZE, len(batch))


# ── DynamoDB Status Updater ────────────────────────────────────────────────────

def _update_status(doc_id: str, status: str, page_count: Optional[int] = None,
                   row_count: Optional[int] = None, error: Optional[str] = None):
    update_expr  = "SET #st = :s, finished_at = :fa"
    expr_names   = {"#st": "status"}
    expr_values  = {":s": status, ":fa": datetime.now(timezone.utc).isoformat()}

    if page_count is not None:
        update_expr += ", page_count = :pc"
        expr_values[":pc"] = page_count
    if row_count is not None:
        update_expr += ", row_count = :rc"
        expr_values[":rc"] = row_count
    if error is not None:
        update_expr += ", #err = :e"
        expr_names["#err"] = "error"
        expr_values[":e"]  = error

    try:
        table.update_item(
            Key={"doc_id": doc_id},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
        logger.info("DynamoDB updated: %s -> %s", doc_id, status)
    except Exception as exc:
        logger.error("DynamoDB update failed: %s", exc)
