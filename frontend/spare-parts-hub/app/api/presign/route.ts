import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Amplify blocks env vars prefixed with AWS_ (reserved by the runtime).
// We use APP_* equivalents set in the Amplify Console.
const REGION = process.env.APP_REGION || "eu-central-1";
const BUCKET = process.env.APP_S3_BUCKET || "spare-parts-docs-626185424005";
const ACCESS_KEY = process.env.APP_ACCESS_KEY_ID || "";
const SECRET_KEY = process.env.APP_SECRET_ACCESS_KEY || "";

const s3 = new S3Client({
  region: REGION,
  credentials: ACCESS_KEY && SECRET_KEY
    ? { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
    : undefined, // fallback to IAM role if running locally
});

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
