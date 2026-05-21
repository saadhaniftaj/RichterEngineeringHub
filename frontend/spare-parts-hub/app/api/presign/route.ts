import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  // Credentials auto-resolved from ~/.aws/credentials or IAM role
});

const BUCKET = process.env.AWS_S3_BUCKET || "spare-parts-docs-185529490317";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const filename    = searchParams.get("filename");
  const contentType = searchParams.get("contentType") || "application/pdf";

  if (!filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }

  // Sanitize filename and prepend uploads/ prefix
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_()[\] ]/g, "_");
  const key = `uploads/${Date.now()}-${safeFilename}`;

  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 }); // 5 min

    return NextResponse.json({ uploadUrl, key, bucket: BUCKET });
  } catch (err: unknown) {
    console.error("Presign error:", err);
    const message = err instanceof Error ? err.message : "Failed to generate upload URL";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
