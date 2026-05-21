import { NextRequest, NextResponse } from "next/server";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, ScanCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";

// Amplify blocks AWS_* env vars — use APP_* equivalents
const REGION      = process.env.APP_REGION || "eu-central-1";
const BUCKET      = process.env.APP_S3_BUCKET || "spare-parts-docs-626185424005";
const DYNAMO_TABLE = process.env.DYNAMODB_TABLE || "spare-parts-doc-status";
const OS_ENDPOINT = process.env.OPENSEARCH_ENDPOINT || "";
const OS_INDEX    = process.env.OPENSEARCH_INDEX || "spare_parts";
const ACCESS_KEY  = process.env.APP_ACCESS_KEY_ID || "";
const SECRET_KEY  = process.env.APP_SECRET_ACCESS_KEY || "";

const credentials = ACCESS_KEY && SECRET_KEY
  ? { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
  : undefined;

const s3     = new S3Client({ region: REGION, credentials });
const dynamo = new DynamoDBClient({ region: REGION, credentials });

// ── GET: List all docs (S3 + DynamoDB join) ───────────────────────────────────
export async function GET() {
  try {
    const s3Response = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "uploads/" }));
    const s3Files = (s3Response.Contents || [])
      .filter((item) => item.Key?.endsWith(".pdf"))
      .sort((a, b) => (b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0));

    let statusMap: Record<string, Record<string, string | number | null>> = {};
    try {
      const dynamoResponse = await dynamo.send(new ScanCommand({ TableName: DYNAMO_TABLE }));
      for (const item of dynamoResponse.Items || []) {
        const key = item.doc_id?.S || "";
        statusMap[key] = {
          status:      item.status?.S || "unknown",
          filename:    item.filename?.S || "",
          page_count:  item.page_count?.N ? parseInt(item.page_count.N) : null,
          row_count:   item.row_count?.N  ? parseInt(item.row_count.N)  : null,
          error:       item.error?.S || null,
          started_at:  item.started_at?.S || null,
          finished_at: item.finished_at?.S || null,
        };
      }
    } catch { /* DynamoDB may not exist yet */ }

    const docs = s3Files.map((item) => {
      const key         = item.Key || "";
      const rawFilename = key.replace("uploads/", "");
      const displayName = rawFilename.replace(/^\d+-/, "");
      const ddbRecord   = statusMap[key] || {};
      return {
        key,
        filename:    (ddbRecord.filename as string) || displayName,
        size:        item.Size || 0,
        lastModified: item.LastModified?.toISOString() || "",
        status:      (ddbRecord.status as string) || "unknown",
        page_count:  ddbRecord.page_count ?? null,
        row_count:   ddbRecord.row_count  ?? null,
        error:       ddbRecord.error      ?? null,
        started_at:  ddbRecord.started_at ?? null,
        finished_at: ddbRecord.finished_at ?? null,
      };
    });

    return NextResponse.json({ docs });
  } catch (err: unknown) {
    console.error("List docs error:", err);
    return NextResponse.json({ error: "Failed to list documents" }, { status: 500 });
  }
}

// ── DELETE: Remove doc from S3 + DynamoDB + OpenSearch ───────────────────────
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const errors: string[] = [];

  // 1. Delete from S3
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log("S3 deleted:", key);
  } catch (err) {
    console.error("S3 delete error:", err);
    errors.push("S3 deletion failed");
  }

  // 2. Delete from DynamoDB
  try {
    await dynamo.send(new DeleteItemCommand({
      TableName: DYNAMO_TABLE,
      Key: { doc_id: { S: key } },
    }));
    console.log("DynamoDB record deleted:", key);
  } catch (err) {
    console.error("DynamoDB delete error:", err);
    errors.push("Status record deletion failed");
  }

  // 3. Delete all OpenSearch documents for this s3_key
  if (OS_ENDPOINT) {
    try {
      const creds = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };
      const signer = new SignatureV4({ credentials: creds, region: REGION, service: "es", sha256: Sha256 });
      const url    = `https://${OS_ENDPOINT}/${OS_INDEX}/_delete_by_query`;
      const parsedUrl = new URL(url);
      const body   = JSON.stringify({ query: { term: { "s3_key.keyword": key } } });

      const signed = await signer.sign({
        method: "POST",
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        protocol: parsedUrl.protocol,
        headers: { "Content-Type": "application/json", host: parsedUrl.hostname },
        body,
      });

      await fetch(url, { method: "POST", headers: signed.headers as Record<string, string>, body });
      console.log("OpenSearch delete_by_query sent for key:", key);
    } catch (err) {
      console.error("OpenSearch delete error:", err);
      errors.push("Search index cleanup failed");
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ success: false, errors }, { status: 207 });
  }

  return NextResponse.json({ success: true, message: "Document fully deleted from all systems." });
}
