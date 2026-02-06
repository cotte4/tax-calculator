import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type EstimateResponse = {
  box2Federal: number;
  box17State: number;
  estimatedRefund: number;
  ocrConfidence: 'high' | 'medium' | 'low' | 'ai-extracted' | 'manual';
};

type CachedResult = EstimateResponse & {
  calculatedAt: string;
  documentName?: string;
};

type Props = {
  apiBaseUrl: string;       // e.g. https://api.yourdomain.com
  bearerToken?: string;     // optional auth token
};

/* ------------------------------------------------------------------ */
/*  Session-scoped result cache (sessionStorage)                      */
/* ------------------------------------------------------------------ */

const RESULT_KEY = 'jai1_calculator_result';

function saveResultToSession(result: CachedResult): void {
  try { sessionStorage.setItem(RESULT_KEY, JSON.stringify(result)); } catch { /* */ }
}

function loadResultFromSession(): CachedResult | null {
  try {
    const stored = sessionStorage.getItem(RESULT_KEY);
    if (stored) return JSON.parse(stored);
    // Clean up legacy localStorage entry if present
    const legacy = localStorage.getItem(RESULT_KEY);
    if (legacy) localStorage.removeItem(RESULT_KEY);
  } catch { /* */ }
  return null;
}

function clearResultFromSession(): void {
  try { sessionStorage.removeItem(RESULT_KEY); } catch { /* */ }
}

/* ------------------------------------------------------------------ */
/*  Session-scoped W2 file cache (IndexedDB + sessionStorage sentinel)*/
/*  - IndexedDB persists across sessions so we use a sessionStorage   */
/*    sentinel to detect a new browser session and wipe it.           */
/*  - Files are stored as { buffer, name, type, lastModified } to    */
/*    avoid the Blob-without-name issue on retrieval.                 */
/* ------------------------------------------------------------------ */

const DB_NAME = 'jai1_w2_embed_cache';
const STORE_NAME = 'w2_files';
const FILE_KEY = 'current_w2';
const SESSION_KEY = 'jai1_w2_embed_session';

async function openDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    return await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function clearCachedFile(): Promise<void> {
  try {
    const db = await openDB();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(FILE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* fail silently */ }
}

async function resetIfNewSession(): Promise<void> {
  if (sessionStorage.getItem(SESSION_KEY)) return;
  sessionStorage.setItem(SESSION_KEY, Date.now().toString());
  await clearCachedFile();
  clearResultFromSession();
}

async function saveCachedFile(file: File): Promise<void> {
  try {
    await resetIfNewSession();
    const db = await openDB();
    if (!db) return;
    // Store raw buffer + metadata so we can reconstruct a proper File later
    const buffer = await file.arrayBuffer();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(
        { buffer, name: file.name, type: file.type, lastModified: file.lastModified },
        FILE_KEY,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { /* fail silently */ }
}

async function loadCachedFile(): Promise<File | null> {
  try {
    await resetIfNewSession();
    const db = await openDB();
    if (!db) return null;
    return await new Promise<File | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(FILE_KEY);
      req.onsuccess = () => {
        const data = req.result;
        if (!data?.buffer) { resolve(null); return; }
        // Reconstruct a real File from the stored buffer + metadata
        const file = new File([data.buffer], data.name || 'w2.jpg', {
          type: data.type || 'image/jpeg',
          lastModified: data.lastModified || Date.now(),
        });
        resolve(file);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function W2CalculatorEmbed({ apiBaseUrl, bearerToken }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResponse | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Restore cached result and/or file on mount
  useEffect(() => {
    const cached = loadResultFromSession();
    if (cached) {
      setResult(cached);
      return;
    }
    loadCachedFile()
      .then((f) => {
        if (f) {
          setFile(f);
          if (f.type.startsWith('image/')) {
            setPreviewUrl(URL.createObjectURL(f));
          }
        }
      })
      .catch(() => {});
  }, []);

  const canSubmit = useMemo(() => !!file && !loading, [file, loading]);

  /* ---- file selection ---- */

  function onSelectFile(nextFile: File | null) {
    setFile(nextFile);
    setResult(null);
    setError(null);
    clearResultFromSession();

    if (previewUrl) URL.revokeObjectURL(previewUrl);

    if (!nextFile) {
      setPreviewUrl(null);
      void clearCachedFile();
      return;
    }

    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (!validTypes.includes(nextFile.type)) {
      setFile(null);
      setPreviewUrl(null);
      setError('Only JPG, PNG, and PDF files are allowed.');
      return;
    }

    if (nextFile.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(nextFile));
    }
    void saveCachedFile(nextFile);
  }

  /* ---- drag & drop ---- */

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) onSelectFile(files[0]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewUrl],
  );

  /* ---- submit ---- */

  async function onCalculate() {
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('w2Image', file);

      const headers: Record<string, string> = {};
      if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
      }

      const response = await fetch(
        `${apiBaseUrl.replace(/\/$/, '')}/api/upload-w2`,
        {
          method: 'POST',
          headers,
          body: formData,
        },
      );

      if (!response.ok) {
        const txt = await response.text();
        throw new Error(txt || 'Failed to process W2.');
      }

      const data = (await response.json()) as EstimateResponse;
      setResult(data);

      saveResultToSession({
        ...data,
        calculatedAt: new Date().toISOString(),
        documentName: file.name,
      });
    } catch (e: any) {
      setError(e?.message || 'Could not process W2 right now.');
    } finally {
      setLoading(false);
    }
  }

  /* ---- reset ---- */

  function resetCalculator() {
    setFile(null);
    setResult(null);
    setError(null);
    setLoading(false);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    clearResultFromSession();
    void clearCachedFile();
  }

  /* ================================================================ */
  /*  Render — Result state                                           */
  /* ================================================================ */

  if (result && !loading) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>Tax Refund Calculator</h3>

        <div style={styles.resultContainer}>
          <div style={styles.refundLabel}>Estimated Refund</div>
          <div style={styles.refundAmount}>${result.estimatedRefund.toFixed(2)}</div>

          {(result.box2Federal > 0 || result.box17State > 0) && (
            <div style={styles.breakdown}>
              <div style={styles.breakdownRow}>
                <span style={styles.breakdownLabel}>Box 2 (Federal)</span>
                <span style={styles.breakdownValue}>${result.box2Federal.toFixed(2)}</span>
              </div>
              <div style={styles.breakdownRow}>
                <span style={styles.breakdownLabel}>Box 17 (State)</span>
                <span style={styles.breakdownValue}>${result.box17State.toFixed(2)}</span>
              </div>
            </div>
          )}

          <div style={styles.sessionNote}>
            <span>🔒</span>
            <span>Saved locally — clears when you close the browser.</span>
          </div>
        </div>

        <button type="button" onClick={resetCalculator} style={styles.resetButton}>
          Calculate with another document
        </button>
      </div>
    );
  }

  /* ================================================================ */
  /*  Render — Upload state                                           */
  /* ================================================================ */

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Tax Refund Calculator</h3>
      <p style={styles.subtitle}>
        Upload your W-2 image and we'll extract Box 2 and Box 17 automatically.
      </p>

      {/* Drop zone */}
      <div
        style={{
          ...styles.dropzone,
          ...(isDragging ? styles.dropzoneActive : {}),
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,application/pdf"
          style={{ display: 'none' }}
          onChange={(e) => onSelectFile(e.target.files?.[0] ?? null)}
        />

        {previewUrl && file?.type.startsWith('image/') ? (
          <img src={previewUrl} alt="W2 preview" style={styles.previewImage} />
        ) : file ? (
          <div style={styles.fileInfo}>
            <span style={{ fontSize: 32 }}>📄</span>
            <span style={styles.fileName}>{file.name}</span>
          </div>
        ) : (
          <div style={styles.dropzoneContent}>
            <span style={{ fontSize: 32 }}>📤</span>
            <span style={styles.dropzoneMain}>Drag your W2 here</span>
            <span style={styles.dropzoneOr}>or</span>
            <span style={styles.dropzoneBrowse}>click to browse</span>
            <div style={styles.formats}>
              <span style={styles.formatBadge}>JPG</span>
              <span style={styles.formatBadge}>PNG</span>
              <span style={styles.formatBadge}>PDF</span>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onCalculate}
        disabled={!canSubmit}
        style={{
          ...styles.submitButton,
          ...(canSubmit ? {} : styles.submitButtonDisabled),
        }}
      >
        {loading ? 'Processing W-2…' : 'Calculate from W-2'}
      </button>

      {error && <p style={styles.errorText}>{error}</p>}

      <div style={styles.sessionNote}>
        <span>🔒</span>
        <span>Your information is stored locally for this session only.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                            */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  card: {
    maxWidth: 560,
    border: '1px solid #e5e7eb',
    borderRadius: 14,
    padding: 24,
    background: '#fff',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  },
  title: {
    margin: '0 0 4px',
    fontSize: 20,
    fontWeight: 700,
    color: '#111827',
  },
  subtitle: {
    marginTop: 0,
    marginBottom: 16,
    color: '#6b7280',
    fontSize: 14,
  },

  /* Drop zone */
  dropzone: {
    border: '2px dashed #d1d5db',
    borderRadius: 12,
    padding: 24,
    textAlign: 'center' as const,
    cursor: 'pointer',
    transition: 'border-color 0.2s, background 0.2s',
    background: '#fafafa',
  },
  dropzoneActive: {
    borderColor: '#111827',
    background: '#f3f4f6',
  },
  dropzoneContent: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 4,
  },
  dropzoneMain: { fontSize: 15, fontWeight: 600, color: '#374151' },
  dropzoneOr: { fontSize: 13, color: '#9ca3af' },
  dropzoneBrowse: { fontSize: 14, color: '#2563eb', fontWeight: 500 },
  formats: { display: 'flex', gap: 6, marginTop: 8 },
  formatBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    background: '#f3f4f6',
    color: '#6b7280',
  },
  previewImage: {
    width: '100%',
    maxHeight: 280,
    objectFit: 'contain' as const,
    borderRadius: 8,
  },
  fileInfo: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
  },
  fileName: { fontSize: 14, fontWeight: 500, color: '#374151' },

  /* Submit */
  submitButton: {
    marginTop: 14,
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: 'none',
    color: '#fff',
    background: '#111827',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 15,
    transition: 'opacity 0.2s',
  },
  submitButtonDisabled: {
    background: '#9ca3af',
    cursor: 'not-allowed',
  },

  /* Error */
  errorText: { marginTop: 12, color: '#b91c1c', fontSize: 14 },

  /* Result */
  resultContainer: {
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    textAlign: 'center' as const,
  },
  refundLabel: { fontSize: 13, color: '#166534', fontWeight: 500, marginBottom: 4 },
  refundAmount: { fontSize: 36, fontWeight: 800, color: '#15803d' },
  breakdown: {
    marginTop: 12,
    paddingTop: 10,
    borderTop: '1px solid #dcfce7',
  },
  breakdownRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
    fontSize: 14,
  },
  breakdownLabel: { color: '#4b5563' },
  breakdownValue: { fontWeight: 600, color: '#111827' },

  /* Session note */
  sessionNote: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    fontSize: 12,
    color: '#9ca3af',
    justifyContent: 'center',
  },

  /* Reset */
  resetButton: {
    marginTop: 14,
    width: '100%',
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid #d1d5db',
    background: '#fff',
    color: '#374151',
    cursor: 'pointer',
    fontWeight: 500,
    fontSize: 14,
  },
};
