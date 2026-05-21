"use client";

import { useState, useRef, useCallback } from "react";
import { Upload, FileText, CheckCircle2, AlertCircle, X, Loader2 } from "lucide-react";

interface UploadedFile {
  name: string;
  size: number;
  status: "uploading" | "processing" | "done" | "error";
  progress: number;
  error?: string;
}

export default function UploadZone({ lang = "EN" }: { lang?: "EN" | "DE" }) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const t = {
    EN: {
      drop: "Drop PDFs here",
      drag: "Drag & drop manuals",
      or: "or",
      browse: "browse files",
      only: "PDF format only",
      uploading: "Uploading",
      processing: "Processing with AI...",
      done: "Indexed",
      failed: "Failed"
    },
    DE: {
      drop: "PDFs hier ablegen",
      drag: "Handbücher hierher ziehen",
      or: "oder",
      browse: "Dateien durchsuchen",
      only: "Nur PDF-Format",
      uploading: "Hochladen",
      processing: "KI-Verarbeitung...",
      done: "Indiziert",
      failed: "Fehlgeschlagen"
    }
  }[lang];

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const uploadFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setFiles((prev) => [
        ...prev,
        {
          name: file.name,
          size: file.size,
          status: "error",
          progress: 0,
          error: t.only,
        },
      ]);
      return;
    }

    const fileEntry: UploadedFile = {
      name: file.name,
      size: file.size,
      status: "uploading",
      progress: 0,
    };

    setFiles((prev) => [...prev, fileEntry]);

    try {
      const res = await fetch(
        `/api/presign?filename=${encodeURIComponent(file.name)}&contentType=application/pdf`
      );

      if (!res.ok) throw new Error("Failed to get upload URL");
      const { uploadUrl } = await res.json();

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 90);
            setFiles((prev) =>
              prev.map((f) =>
                f.name === file.name ? { ...f, progress: pct } : f
              )
            );
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: ${xhr.statusText}`));
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", "application/pdf");
        xhr.send(file);
      });

      setFiles((prev) =>
        prev.map((f) =>
          f.name === file.name
            ? { ...f, status: "processing", progress: 95 }
            : f
        )
      );

      await new Promise((r) => setTimeout(r, 2500));

      setFiles((prev) =>
        prev.map((f) =>
          f.name === file.name ? { ...f, status: "done", progress: 100 } : f
        )
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setFiles((prev) =>
        prev.map((f) =>
          f.name === file.name
            ? { ...f, status: "error", progress: 0, error: message }
            : f
        )
      );
    }
  }, [t.only]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const dropped = Array.from(e.dataTransfer.files);
      dropped.forEach(uploadFile);
    },
    [uploadFile]
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    selected.forEach(uploadFile);
    e.target.value = "";
  };

  const removeFile = (name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  };

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div
        className={`upload-zone p-10 text-center cursor-pointer ${
          isDragging ? "drag-over border-red-500" : "border-gray-300"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-red-50 text-red-600 flex items-center justify-center mb-2">
            <Upload size={24} />
          </div>

          <div>
            <p className="text-base font-semibold text-gray-800">
              {isDragging ? t.drop : t.drag}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              {t.or}{" "}
              <span className="text-red-600 font-medium hover:underline">
                {t.browse}
              </span>{" "}
              · {t.only}
            </p>
          </div>
        </div>
      </div>

      {files.length > 0 && (
        <div className="space-y-2 mt-6">
          {files.map((file) => (
            <FileRow key={file.name} file={file} onRemove={removeFile} formatBytes={formatBytes} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FileRow({ file, onRemove, formatBytes, t }: any) {
  const statusIcon = {
    uploading: <Loader2 size={16} className="animate-spin text-red-500" />,
    processing: <Loader2 size={16} className="animate-spin text-red-500" />,
    done: <CheckCircle2 size={16} className="text-green-500" />,
    error: <AlertCircle size={16} className="text-red-500" />,
  }[file.status as "uploading" | "processing" | "done" | "error"];

  const statusLabel = {
    uploading: `${t.uploading}… ${file.progress}%`,
    processing: t.processing,
    done: t.done,
    error: file.error || t.failed,
  }[file.status as "uploading" | "processing" | "done" | "error"];

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-4 animate-float-up shadow-sm">
      <div className="w-10 h-10 rounded bg-gray-50 flex items-center justify-center flex-shrink-0 border border-gray-100">
        <FileText size={18} className="text-gray-500" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium text-gray-800 truncate" title={file.name}>
            {file.name}
          </p>
          <span className="text-xs text-gray-500 flex-shrink-0 ml-2">
            {formatBytes(file.size)}
          </span>
        </div>

        {(file.status === "uploading" || file.status === "processing") && (
          <div className="h-1.5 rounded-full overflow-hidden mb-2 bg-gray-100">
            <div
              className="h-full bg-red-600 transition-all duration-300"
              style={{ width: `${file.progress}%` }}
            />
          </div>
        )}

        <div className="flex items-center gap-1.5">
          {statusIcon}
          <span
            className="text-xs"
            style={{ color: file.status === "done" ? "#22c55e" : file.status === "error" ? "#ef4444" : "#6b7280" }}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {(file.status === "done" || file.status === "error") && (
        <button
          onClick={() => onRemove(file.name)}
          className="p-1.5 rounded hover:bg-gray-100 transition-colors flex-shrink-0 text-gray-400 hover:text-gray-600"
          title="Dismiss"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
