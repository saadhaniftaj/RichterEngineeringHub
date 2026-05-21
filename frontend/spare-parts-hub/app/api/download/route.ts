import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
});

const BUCKET = process.env.AWS_S3_BUCKET || "spare-parts-docs-185529490317";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");
  const page = searchParams.get("page");

  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });

    // Generate a temporary 5-minute read URL
    let downloadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    
    // Append PDF page anchor
    if (page) {
      downloadUrl += `#page=${page}`;
    }

    // Instantly redirect the browser to the secure file URL
    return NextResponse.redirect(downloadUrl);
  } catch (err: unknown) {
    console.error("Presign download error:", err);
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }
}
