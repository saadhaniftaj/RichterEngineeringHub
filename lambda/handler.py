"""
Spare Parts Document Hub — Lambda Handler
Triggered by S3 PutObject event → calls Textract AnalyzeDocument (TABLES)
→ parses table rows → indexes to OpenSearch

Free-tier guard: processes MAX_PAGES (10) pages only.
"""

import json
import os
import logging
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth

# ─── Logging ─────────────────────────────────────────────────────────────────
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ─── Config from Environment Variables ───────────────────────────────────────
OPENSEARCH_ENDPOINT = os.environ["OPENSEARCH_ENDPOINT"]  # without https://
OPENSEARCH_INDEX    = os.environ.get("OPENSEARCH_INDEX", "spare_parts")
AWS_REGION          = os.environ.get("AWS_REGION", "us-east-1")
MAX_PAGES           = int(os.environ.get("MAX_PAGES", "10"))  # Free-tier guard

# ─── AWS Clients ──────────────────────────────────────────────────────────────
s3_client       = boto3.client("s3", region_name=AWS_REGION)
textract_client = boto3.client("textract", region_name=AWS_REGION)
session         = boto3.Session()
credentials     = session.get_credentials()

# ─── OpenSearch Client ────────────────────────────────────────────────────────
awsauth = AWS4Auth(
    credentials.access_key,
    credentials.secret_key,
    AWS_REGION,
    "es",
    session_token=credentials.token,
)

os_client = OpenSearch(
    hosts=[{"host": OPENSEARCH_ENDPOINT, "port": 443}],
    http_auth=awsauth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    timeout=60,
)


# ─── Main Handler ─────────────────────────────────────────────────────────────
def handler(event, context):
    """Entry point for S3-triggered Lambda."""
    logger.info("Event received: %s", json.dumps(event))

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key    = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

        logger.info("Processing: s3://%s/%s", bucket, key)

        if not key.lower().endswith(".pdf"):
            logger.info("Skipping non-PDF: %s", key)
            continue

        try:
            process_document(bucket, key)
        except Exception as exc:
            logger.error("Failed processing %s: %s", key, exc, exc_info=True)
            raise  # Let Lambda retry / surface in CloudWatch


def process_document(bucket: str, key: str):
    """Orchestrates Textract call → parse → index."""
    document_name = key.split("/")[-1]

    # ── 1. Get total page count (head metadata) ───────────────────────────────
    # We stream the PDF byte header to check page count cheaply via S3 Select
    # or we simply pass the S3 reference and let Textract handle it.
    # Textract S3 reference call:
    logger.info("Calling Textract AnalyzeDocument for %s", document_name)

    response = textract_client.analyze_document(
        Document={
            "S3Object": {
                "Bucket": bucket,
                "Name": key,
            }
        },
        FeatureTypes=["TABLES"],
    )

    blocks = response.get("Blocks", [])
    logger.info("Textract returned %d blocks", len(blocks))

    # ── 2. Parse tables from blocks ───────────────────────────────────────────
    documents = parse_textract_tables(blocks, document_name, key)
    logger.info("Parsed %d indexable rows from tables", len(documents))

    if not documents:
        logger.warning("No table rows found in %s — indexing raw text blocks", document_name)
        documents = parse_textract_raw_text(blocks, document_name, key)

    # ── 3. Bulk index to OpenSearch ───────────────────────────────────────────
    if documents:
        bulk_index(documents)
    else:
        logger.warning("No indexable content found in %s", document_name)


# ─── Textract Table Parser ────────────────────────────────────────────────────
def parse_textract_tables(blocks: list, document_name: str, s3_key: str) -> list:
    """
    Parse Textract TABLES output into structured rows.
    Maintains Part Number → Description → Quantity relationship within each row.
    Returns a list of dicts ready for OpenSearch indexing.
    """
    # Build block lookup
    block_map = {b["Id"]: b for b in blocks}

    # Collect TABLE blocks
    tables = [b for b in blocks if b["BlockType"] == "TABLE"]

    documents = []
    for table_idx, table in enumerate(tables):
        page_number = table.get("Page", 1)

        # Free-tier guard — skip tables beyond MAX_PAGES
        if page_number > MAX_PAGES:
            logger.info("Skipping table on page %d (beyond MAX_PAGES=%d)", page_number, MAX_PAGES)
            continue

        # Collect cells keyed by (row, col)
        cells: dict[tuple, dict] = {}
        for rel in table.get("Relationships", []):
            if rel["Type"] == "CHILD":
                for cell_id in rel["Ids"]:
                    cell = block_map.get(cell_id)
                    if cell and cell["BlockType"] == "CELL":
                        row = cell["RowIndex"]
                        col = cell["ColumnIndex"]
                        text = _get_cell_text(cell, block_map)
                        cells[(row, col)] = {
                            "text": text,
                            "row": row,
                            "col": col,
                        }

        if not cells:
            continue

        # Detect header row (row 1)
        max_row = max(k[0] for k in cells)
        max_col = max(k[1] for k in cells)

        headers = {
            col: cells.get((1, col), {}).get("text", f"col_{col}").strip().lower()
            for col in range(1, max_col + 1)
        }

        # Map headers to semantic fields
        field_map = _map_headers_to_fields(headers, max_col)

        # Parse data rows (skip header row 1)
        for row_idx in range(2, max_row + 1):
            row_data = {
                col: cells.get((row_idx, col), {}).get("text", "").strip()
                for col in range(1, max_col + 1)
            }

            part_number = row_data.get(field_map.get("part_number"), "").strip()
            description = row_data.get(field_map.get("description"), "").strip()
            quantity    = row_data.get(field_map.get("quantity"), "").strip()
            unit        = row_data.get(field_map.get("unit"), "").strip()

            raw_row = " | ".join(v for v in row_data.values() if v)

            # Skip completely empty rows
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


def _get_cell_text(cell: dict, block_map: dict) -> str:
    """Concatenate all WORD children of a CELL block."""
    words = []
    for rel in cell.get("Relationships", []):
        if rel["Type"] == "CHILD":
            for word_id in rel["Ids"]:
                word_block = block_map.get(word_id)
                if word_block and word_block["BlockType"] == "WORD":
                    words.append(word_block.get("Text", ""))
    return " ".join(words)


def _map_headers_to_fields(headers: dict, max_col: int) -> dict:
    """
    Heuristically map column indices to semantic field names.
    Works with German and English column headers.
    """
    PART_NUMBER_KEYWORDS = {
        "part", "part no", "part number", "teilenummer", "art.", "artikel",
        "artikelnr", "artikelnummer", "bestell", "nr.", "no.", "ref", "p/n",
        "item", "pos", "position",
    }
    DESCRIPTION_KEYWORDS = {
        "description", "desc", "bezeichnung", "name", "benennung",
        "text", "detail", "component", "bezeichn",
    }
    QUANTITY_KEYWORDS = {
        "qty", "quantity", "menge", "anzahl", "count", "pcs", "stk", "stück",
    }
    UNIT_KEYWORDS = {
        "unit", "einheit", "uom", "ea", "piece",
    }

    field_map = {}
    for col, header in headers.items():
        h = header.lower().strip()
        if any(kw in h for kw in PART_NUMBER_KEYWORDS) and "part_number" not in field_map.values():
            field_map["part_number"] = col
        elif any(kw in h for kw in DESCRIPTION_KEYWORDS) and "description" not in field_map.values():
            field_map["description"] = col
        elif any(kw in h for kw in QUANTITY_KEYWORDS) and "quantity" not in field_map.values():
            field_map["quantity"] = col
        elif any(kw in h for kw in UNIT_KEYWORDS) and "unit" not in field_map.values():
            field_map["unit"] = col

    # Fallback: if no headers matched, assign positionally
    if "part_number" not in field_map and max_col >= 1:
        field_map["part_number"] = 1
    if "description" not in field_map and max_col >= 2:
        field_map["description"] = 2
    if "quantity" not in field_map and max_col >= 3:
        field_map["quantity"] = 3

    return field_map


def parse_textract_raw_text(blocks: list, document_name: str, s3_key: str) -> list:
    """Fallback: index raw LINE blocks when no tables are found."""
    documents = []
    for block in blocks:
        if block["BlockType"] != "LINE":
            continue
        page = block.get("Page", 1)
        if page > MAX_PAGES:
            continue
        text = block.get("Text", "").strip()
        if not text:
            continue
        documents.append({
            "document_name": document_name,
            "s3_key":        s3_key,
            "page_number":   page,
            "table_index":   -1,
            "row_index":     -1,
            "part_number":   "",
            "description":   text,
            "quantity":      "",
            "unit":          "",
            "raw_row_text":  text,
            "indexed_at":    datetime.now(timezone.utc).isoformat(),
        })
    return documents


# ─── OpenSearch Bulk Indexer ──────────────────────────────────────────────────
def bulk_index(documents: list):
    """Bulk index documents into OpenSearch using the opensearch-py client."""
    actions = []
    for doc in documents:
        actions.append({"index": {"_index": OPENSEARCH_INDEX}})
        actions.append(doc)

    response = os_client.bulk(body=actions, index=OPENSEARCH_INDEX)

    if response.get("errors"):
        error_items = [
            item for item in response["items"]
            if item.get("index", {}).get("error")
        ]
        logger.error("Bulk index errors: %s", json.dumps(error_items[:5]))
    else:
        logger.info("Successfully indexed %d documents", len(documents))
