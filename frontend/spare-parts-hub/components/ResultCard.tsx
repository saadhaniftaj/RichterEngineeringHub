"use client";

import { FileText, Hash, Layers, Package, ExternalLink } from "lucide-react";
import { SearchResult } from "./SearchCenter";

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!text || !query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts   = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="bg-red-100 text-red-900 rounded px-0.5 font-semibold">
        {part}
      </mark>
    ) : part
  );
}

export default function ResultCard({
  result,
  index,
  query,
  lang = "EN",
  matchType = "exact",
}: {
  result: SearchResult;
  index: number;
  query: string;
  lang?: "EN" | "DE";
  matchType?: "exact" | "closest" | "none";
}) {
  const { _source, _score } = result;
  const animDelay = `${index * 0.05}s`;

  const t = {
    EN: { page: "Page", qty: "Qty", openDoc: "Open document" },
    DE: { page: "Seite", qty: "Menge", openDoc: "Dokument öffnen" },
  }[lang];

  const snippet =
    _source.raw_row_text?.length > 200
      ? _source.raw_row_text.substring(0, 200) + "…"
      : _source.raw_row_text;

  const isClosest = matchType === "closest";

  return (
    <a
      href={`/api/download?key=${encodeURIComponent(_source.s3_key)}&page=${_source.page_number}`}
      target="_blank"
      rel="noopener noreferrer"
      className="result-card p-5 animate-float-up block cursor-pointer no-underline group"
      style={{ animationDelay: animDelay, opacity: 0, animationFillMode: "forwards" }}
      title={t.openDoc}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* File icon — green for exact, amber for closest */}
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 border transition-colors group-hover:scale-105
            ${isClosest
              ? "bg-amber-50 border-amber-100"
              : "bg-green-50 border-green-100"
            }`}
          >
            <FileText size={20} className={isClosest ? "text-amber-400" : "text-green-500"} />
          </div>

          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-800 truncate group-hover:text-red-700 transition-colors" title={_source.document_name}>
              {highlightMatch(_source.document_name, query)}
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="badge badge-neutral flex items-center gap-1">
                <Layers size={10} />
                {t.page} {_source.page_number}
              </span>
              {_source.quantity && (
                <span className="badge badge-neutral flex items-center gap-1">
                  <Package size={10} />
                  {t.qty}: {_source.quantity}{_source.unit ? ` ${_source.unit}` : ""}
                </span>
              )}
              {/* Match quality badge */}
              {isClosest ? (
                <span className="badge" style={{ background: "rgba(251,191,36,0.12)", color: "#92400e", border: "1px solid rgba(251,191,36,0.3)", fontSize: "0.65rem" }}>
                  ≈ Closest
                </span>
              ) : (
                <span className="badge" style={{ background: "rgba(34,197,94,0.1)", color: "#166534", border: "1px solid rgba(34,197,94,0.25)", fontSize: "0.65rem" }}>
                  ✓ Exact
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Score + Open icon */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-gray-300 font-mono">{_score.toFixed(1)}</span>
          <ExternalLink size={14} className="text-gray-300 group-hover:text-red-500 transition-colors" />
        </div>
      </div>

      {/* Part Number chip */}
      {_source.part_number && (
        <div className="mb-3">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-red-50 border border-red-100">
            <Hash size={13} className="text-red-600" />
            <span className="text-sm font-mono font-bold text-red-800 tracking-wider">
              {highlightMatch(_source.part_number, query)}
            </span>
          </div>
        </div>
      )}

      {/* Description */}
      {_source.description && (
        <p className="text-sm mb-3 text-gray-600 leading-relaxed">
          {highlightMatch(_source.description, query)}
        </p>
      )}

      {/* Raw row snippet */}
      {snippet && snippet !== _source.description && (
        <div className="rounded bg-gray-50 border border-gray-100 px-3 py-2 text-xs text-gray-500 font-mono leading-relaxed break-all">
          {highlightMatch(snippet, query)}
        </div>
      )}
    </a>
  );
}
