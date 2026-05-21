"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Clock, X, CheckCircle, AlertCircle } from "lucide-react";
import ResultCard from "./ResultCard";

export interface SearchResult {
  _id: string;
  _score: number;
  _source: {
    document_name: string;
    page_number: number;
    part_number: string;
    description: string;
    quantity: string;
    unit: string;
    raw_row_text: string;
    s3_key: string;
    indexed_at: string;
  };
  highlight?: Record<string, string[]>;
}

const STORAGE_KEY = "richter_recent_searches";

const i18n = {
  EN: {
    placeholder: "Search part numbers, descriptions...",
    recent: "Recent Searches",
    noResults: "No results found.",
    errorSearch: "Search failed. Check your connection.",
    noExact: "No exact match found.",
    showClosest: "Show closest results",
    exactBanner: "Exact Match",
    closestBanner: "Closest Results — No exact match found.",
    results: "results",
    emptyHint: "Upload manuals in the other tab, then search for parts here.",
  },
  DE: {
    placeholder: "Teilenummern, Beschreibungen suchen...",
    recent: "Letzte Suchen",
    noResults: "Keine Ergebnisse gefunden.",
    errorSearch: "Suche fehlgeschlagen.",
    noExact: "Keine genaue Übereinstimmung gefunden.",
    showClosest: "Ähnliche Ergebnisse anzeigen",
    exactBanner: "Genaue Übereinstimmung",
    closestBanner: "Ähnliche Ergebnisse — Keine genaue Übereinstimmung gefunden.",
    results: "Ergebnisse",
    emptyHint: "Handbücher auf dem anderen Reiter hochladen, dann hier nach Teilen suchen.",
  },
};

export default function SearchCenter({ lang = "EN" }: { lang?: "EN" | "DE" }) {
  const t = i18n[lang];
  const [query, setQuery]         = useState("");
  const [results, setResults]     = useState<SearchResult[]>([]);
  const [matchType, setMatchType] = useState<"exact" | "closest" | "none">("none");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [hasSearched, setHasSearched]       = useState(false);
  const [showClosest, setShowClosest]       = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      setRecentSearches(stored);
    } catch {}
  }, []);

  const saveRecent = (q: string) => {
    const updated = [q, ...recentSearches.filter((s) => s !== q)].slice(0, 8);
    setRecentSearches(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const runSearch = async (q: string) => {
    if (!q.trim()) {
      setResults([]); setMatchType("none"); setHasSearched(false); return;
    }
    setIsLoading(true); setError(null); setHasSearched(true); setShowClosest(false);

    try {
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}&size=20`);
      const data = await res.json();

      if (data.error) throw new Error(data.error);

      const hits = data.hits?.hits || [];
      setResults(hits);
      setMatchType(data.matchType || "none");
      saveRecent(q);
    } catch (err) {
      setError(t.errorSearch);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(val), 380);
  };

  const clearSearch = () => {
    setQuery(""); setResults([]); setMatchType("none"); setHasSearched(false);
  };

  const removeRecent = (term: string) => {
    const updated = recentSearches.filter((s) => s !== term);
    setRecentSearches(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  };

  const showChips = !hasSearched && recentSearches.length > 0;

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {/* Search Input */}
      <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
          {isLoading ? (
            <div className="w-5 h-5 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Search size={18} className="text-gray-400" />
          )}
        </div>
        <input
          className="search-bar w-full pl-11 pr-10 py-3.5 rounded-xl text-sm"
          placeholder={t.placeholder}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch(query)}
          autoFocus
        />
        {query && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Recent Searches */}
      {showChips && (
        <div className="animate-float-up">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
            {t.recent}
          </p>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((term) => (
              <span key={term} className="chip group">
                <Clock size={11} />
                <button onClick={() => { setQuery(term); runSearch(term); }}>
                  {term}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); removeRecent(term); }}
                  className="opacity-0 group-hover:opacity-100 ml-1 transition-opacity"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg p-3 bg-red-50 border border-red-100 flex items-center gap-2 text-sm text-red-800">
          <AlertCircle size={16} className="text-red-500" />
          {error}
        </div>
      )}

      {/* Match Type Banners */}
      {hasSearched && !isLoading && !error && results.length > 0 && (
        <div className="flex items-center gap-2">
          {matchType === "exact" ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-xs font-semibold text-green-800">
              <CheckCircle size={13} className="text-green-600" />
              {t.exactBanner} — {results.length} {t.results}
            </div>
          ) : matchType === "closest" ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs font-semibold text-amber-800">
              <AlertCircle size={13} className="text-amber-500" />
              {t.closestBanner}
            </div>
          ) : null}
        </div>
      )}

      {/* No Exact Match — Show Closest Option */}
      {hasSearched && !isLoading && !error && results.length === 0 && matchType !== "none" && (
        <div className="text-center py-8 space-y-3 animate-float-up">
          <p className="text-gray-500 text-sm">{t.noResults}</p>
        </div>
      )}

      {/* Empty state */}
      {!hasSearched && !isLoading && (
        <div className="text-center py-10 text-gray-400">
          <Search size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t.emptyHint}</p>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-3">
          {results.map((result, idx) => (
            <ResultCard
              key={result._id || idx}
              result={result}
              index={idx}
              query={query}
              lang={lang}
              matchType={matchType}
            />
          ))}
        </div>
      )}
    </div>
  );
}
