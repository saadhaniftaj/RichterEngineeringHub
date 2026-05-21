"use client";

import { useState, useEffect, useCallback } from "react";
import { FileText, Calendar, Loader2, AlertCircle, CheckCircle, XCircle, HelpCircle, RefreshCw, Hash, Trash2 } from "lucide-react";

interface Document {
  key: string;
  filename: string;
  size: number;
  lastModified: string;
  status: "processing" | "indexed" | "failed" | "unknown";
  page_count: number | null;
  row_count: number | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const i18n = {
  EN: {
    loading: "Loading documents...",
    noDocs: "No documents uploaded yet.",
    error: "Failed to load documents.",
    size: "Size",
    pages: "pages",
    rows: "rows indexed",
    status_processing: "Processing",
    status_indexed: "Indexed",
    status_failed: "Failed",
    status_unknown: "In S3",
    refresh: "Refresh",
    delete: "Delete",
    confirmDelete: "Confirm delete?",
    confirmYes: "Yes, delete",
    confirmNo: "Cancel",
    deleting: "Deleting...",
    deleteError: "Failed to delete.",
  },
  DE: {
    loading: "Dokumente werden geladen...",
    noDocs: "Noch keine Dokumente hochgeladen.",
    error: "Fehler beim Laden der Dokumente.",
    size: "Größe",
    pages: "Seiten",
    rows: "Zeilen indexiert",
    status_processing: "Verarbeitung",
    status_indexed: "Indexiert",
    status_failed: "Fehler",
    status_unknown: "In S3",
    refresh: "Aktualisieren",
    delete: "Löschen",
    confirmDelete: "Löschen bestätigen?",
    confirmYes: "Ja, löschen",
    confirmNo: "Abbrechen",
    deleting: "Wird gelöscht...",
    deleteError: "Löschen fehlgeschlagen.",
  },
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status, t }: { status: Document["status"]; t: typeof i18n["EN"] }) {
  const configs = {
    processing: {
      icon: <Loader2 size={11} className="animate-spin" />,
      label: t.status_processing,
      cls: "bg-amber-50 text-amber-800 border-amber-200",
    },
    indexed: {
      icon: <CheckCircle size={11} />,
      label: t.status_indexed,
      cls: "bg-green-50 text-green-800 border-green-200",
    },
    failed: {
      icon: <XCircle size={11} />,
      label: t.status_failed,
      cls: "bg-red-50 text-red-800 border-red-200",
    },
    unknown: {
      icon: <HelpCircle size={11} />,
      label: t.status_unknown,
      cls: "bg-gray-50 text-gray-600 border-gray-200",
    },
  };
  const cfg = configs[status] || configs.unknown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

export default function DocsList({ lang = "EN" }: { lang?: "EN" | "DE" }) {
  const t = i18n[lang];
  const [docs, setDocs]           = useState<Document[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deletingKey, setDeletingKey]           = useState<string | null>(null);
  const [deleteError, setDeleteError]           = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());

  const fetchDocs = useCallback(async () => {
    try {
      const res  = await fetch("/api/docs");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDocs(data.docs || []);
      setError(null);
    } catch (err) {
      setError(t.error);
    } finally {
      setIsLoading(false);
    }
  }, [t.error]);

  const handleDelete = async (key: string) => {
    setDeletingKey(key);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/docs?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success && res.status !== 207) throw new Error(data.errors?.join(", ") || "Delete failed");
      // Remove from local state immediately
      setDocs((prev) => prev.filter((d) => d.key !== key));
      setConfirmingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t.deleteError);
    } finally {
      setDeletingKey(null);
    }
  };

  // Initial load
  useEffect(() => { fetchDocs(); }, [fetchDocs, lastRefresh]);

  // Auto-poll every 10s if any doc is still processing
  useEffect(() => {
    const hasProcessing = docs.some((d) => d.status === "processing");
    if (!hasProcessing) return;
    const interval = setInterval(fetchDocs, 10000);
    return () => clearInterval(interval);
  }, [docs, fetchDocs]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
        <Loader2 size={28} className="animate-spin text-red-500 mb-3" />
        <p className="text-sm">{t.loading}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg p-4 bg-red-50 border border-red-100 flex items-start gap-3">
        <AlertCircle className="text-red-500 mt-0.5" size={18} />
        <p className="text-sm font-medium text-red-800">{error}</p>
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <FileText size={34} className="mx-auto mb-3 opacity-40" />
        <p className="text-sm">{t.noDocs}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-5xl mx-auto">
      {/* Header row */}
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-gray-400 font-medium">{docs.length} document{docs.length !== 1 ? "s" : ""}</p>
        <button
          onClick={() => { setIsLoading(true); setLastRefresh(Date.now()); }}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-600 transition-colors"
        >
          <RefreshCw size={12} />
          {t.refresh}
        </button>
      </div>

      {deleteError && (
        <div className="rounded-lg p-3 bg-red-50 border border-red-100 flex items-center gap-2 text-xs text-red-800 animate-float-up">
          <AlertCircle size={14} className="text-red-500" />
          {deleteError}
        </div>
      )}

      {docs.map((doc, idx) => (
        <div
          key={doc.key}
          className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4 animate-float-up shadow-sm hover:border-red-200 transition-colors"
          style={{ animationDelay: `${idx * 0.04}s`, opacity: 0, animationFillMode: "forwards" }}
        >
          {/* Icon */}
          <div className={`w-10 h-10 rounded flex items-center justify-center flex-shrink-0 border
            ${doc.status === "indexed"    ? "bg-green-50 border-green-100"
            : doc.status === "processing" ? "bg-amber-50 border-amber-100"
            : doc.status === "failed"     ? "bg-red-50 border-red-100"
            : "bg-gray-50 border-gray-100"}`}
          >
            <FileText size={19} className={
              doc.status === "indexed"    ? "text-green-500"
              : doc.status === "processing" ? "text-amber-400"
              : doc.status === "failed"     ? "text-red-400"
              : "text-gray-400"
            } />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold text-gray-800 truncate" title={doc.filename}>
                {doc.filename}
              </p>
              <StatusBadge status={doc.status} t={t} />
            </div>

            <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-400 flex-wrap">
              <span>{formatBytes(doc.size)}</span>
              {doc.page_count && (
                <span className="flex items-center gap-1"><FileText size={11} />{doc.page_count} {t.pages}</span>
              )}
              {doc.row_count && (
                <span className="flex items-center gap-1"><Hash size={11} />{doc.row_count} {t.rows}</span>
              )}
              {doc.lastModified && (
                <span className="flex items-center gap-1"><Calendar size={11} />{new Date(doc.lastModified).toLocaleDateString()}</span>
              )}
            </div>

            {doc.error && (
              <p className="text-xs text-red-600 mt-1 truncate" title={doc.error}>{doc.error}</p>
            )}
          </div>

          {/* Delete Controls */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {deletingKey === doc.key ? (
              <Loader2 size={15} className="animate-spin text-red-400" />
            ) : confirmingDelete === doc.key ? (
              <div className="flex items-center gap-2 animate-float-up">
                <span className="text-xs text-gray-500">{t.confirmDelete}</span>
                <button
                  onClick={() => handleDelete(doc.key)}
                  className="text-xs font-semibold text-white bg-red-600 hover:bg-red-700 px-2.5 py-1 rounded transition-colors"
                >
                  {t.confirmYes}
                </button>
                <button
                  onClick={() => setConfirmingDelete(null)}
                  className="text-xs font-medium text-gray-500 hover:text-gray-800 px-2 py-1 rounded transition-colors"
                >
                  {t.confirmNo}
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setConfirmingDelete(doc.key); setDeleteError(null); }}
                className="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                title={t.delete}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
