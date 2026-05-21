import { NextRequest, NextResponse } from "next/server";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";

// Amplify blocks AWS_* env vars — use APP_* equivalents
const REGION      = process.env.APP_REGION || "eu-central-1";
const OS_ENDPOINT = process.env.OPENSEARCH_ENDPOINT || "";
const OS_INDEX    = process.env.OPENSEARCH_INDEX || "spare_parts";
const ACCESS_KEY  = process.env.APP_ACCESS_KEY_ID || "";
const SECRET_KEY  = process.env.APP_SECRET_ACCESS_KEY || "";

async function signedSearch(body: object): Promise<Response> {
  const url     = `https://${OS_ENDPOINT}/${OS_INDEX}/_search`;
  const bodyStr = JSON.stringify(body);
  const creds   = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };
  const signer  = new SignatureV4({ credentials: creds, region: REGION, service: "es", sha256: Sha256 });
  const parsedUrl = new URL(url);

  const signed = await signer.sign({
    method: "POST",
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname,
    protocol: parsedUrl.protocol,
    headers: { "Content-Type": "application/json", host: parsedUrl.hostname },
    body: bodyStr,
  });

  return fetch(url, { method: "POST", headers: signed.headers as Record<string, string>, body: bodyStr });
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q    = searchParams.get("q")?.trim();
  const size = Math.min(parseInt(searchParams.get("size") || "20"), 50);

  if (!q) return NextResponse.json({ hits: { hits: [], total: { value: 0 } }, matchType: "none" });

  if (!OS_ENDPOINT || OS_ENDPOINT === "pending") {
    return NextResponse.json({ error: "OpenSearch is still provisioning." }, { status: 503 });
  }

  // NOTE: Only table row data is indexed — part numbers, descriptions, quantities.
  // Page headers, footers, and company names printed on every page corner are
  // NOT indexed by design. They are document decoration, not searchable parts data.

  // ── Tier 1: Exact / phrase match ──────────────────────────────────────────
  const exactQuery = {
    size,
    query: {
      bool: {
        should: [
          { match_phrase: { raw_row_text:          { query: q, boost: 30 } } },
          { match_phrase: { description:           { query: q, boost: 25 } } },
          { term:         { "part_number.keyword": { value: q, boost: 20 } } },
          { match_phrase: { part_number:           { query: q, boost: 15 } } },
        ],
        minimum_should_match: 1,
        filter: [
          {
            bool: {
              should: [
                { term:         { "part_number.keyword": q } },
                { match_phrase: { part_number:           { query: q } } },
                { match_phrase: { description:           { query: q } } },
                { match_phrase: { raw_row_text:          { query: q } } },
              ],
              minimum_should_match: 1,
            },
          },
        ],
      },
    },
    highlight: _highlightFields(),
    _source: _sourceFields(),
  };

  // ── Tier 2: Fuzzy / closest match ─────────────────────────────────────────
  const wordCount = q.trim().split(/\s+/).length;
  const minMatch  = wordCount > 1 ? 2 : 1;

  const fuzzyQuery = {
    size,
    query: {
      bool: {
        should: [
          { match_phrase: { raw_row_text:          { query: q, boost: 20 } } },
          { match_phrase: { description:           { query: q, boost: 15 } } },
          { match: { "part_number.keyword":        { query: q, boost: 10 } } },
          { match: { part_number:  { query: q, fuzziness: "AUTO", prefix_length: 2, boost: 6 } } },
          { match: { description:  { query: q, fuzziness: "AUTO", boost: 3 } } },
          { match: { raw_row_text: { query: q, fuzziness: "AUTO", boost: 2 } } },
        ],
        minimum_should_match: minMatch,
      },
    },
    highlight: _highlightFields(),
    _source: _sourceFields(),
  };

  try {
    const exactRes  = await signedSearch(exactQuery);
    if (!exactRes.ok) throw new Error(`OpenSearch ${exactRes.status}`);
    const exactData = await exactRes.json();

    if ((exactData.hits?.total?.value ?? 0) > 0) {
      return NextResponse.json({ ...exactData, matchType: "exact" });
    }

    const fuzzyRes  = await signedSearch(fuzzyQuery);
    if (!fuzzyRes.ok) throw new Error(`OpenSearch ${fuzzyRes.status}`);
    const fuzzyData = await fuzzyRes.json();

    return NextResponse.json({ ...fuzzyData, matchType: "closest" });

  } catch (err: unknown) {
    console.error("Search error:", err);
    const message = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function _highlightFields() {
  return {
    fields: {
      part_number:  {},
      description:  {},
      raw_row_text: { fragment_size: 200, number_of_fragments: 1 },
    },
  };
}

function _sourceFields() {
  return ["document_name", "page_number", "part_number", "description",
          "quantity", "unit", "raw_row_text", "s3_key", "indexed_at"];
}
