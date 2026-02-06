import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addPropertyControls, ControlType } from 'framer';

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
  apiBaseUrl: string;
  bearerToken?: string;
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
/*  Helper: parse error response from server                          */
/* ------------------------------------------------------------------ */

async function parseErrorResponse(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // Try parsing as JSON to extract the error message
    try {
      const json = JSON.parse(text);
      if (json.error && typeof json.error === 'string') return json.error;
      if (json.message && typeof json.message === 'string') return json.message;
    } catch { /* not JSON, use raw text */ }
    return text || 'Error al procesar tu W2.';
  } catch {
    return 'Error al procesar tu W2.';
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
  const [loadingStep, setLoadingStep] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadingInterval = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Cleanup loading interval on unmount
  useEffect(() => {
    return () => {
      if (loadingInterval.current) clearInterval(loadingInterval.current);
    };
  }, []);

  const canSubmit = useMemo(() => !!file && !loading, [file, loading]);

  const loadingSteps = [
    'Subiendo documento...',
    'Analizando W2 con IA...',
    'Extrayendo Box 2 y Box 17...',
    'Calculando reembolso...',
  ];

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
      setError('Solo se aceptan archivos JPG, PNG y PDF.');
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

  /* ---- loading animation ---- */

  function startLoadingAnimation() {
    setLoadingStep(0);
    let step = 0;
    loadingInterval.current = setInterval(() => {
      step += 1;
      if (step < loadingSteps.length) {
        setLoadingStep(step);
      }
    }, 2500);
  }

  function stopLoadingAnimation() {
    if (loadingInterval.current) {
      clearInterval(loadingInterval.current);
      loadingInterval.current = null;
    }
  }

  /* ---- submit ---- */

  async function onCalculate() {
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);
    startLoadingAnimation();

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
        const errorMsg = await parseErrorResponse(response);
        throw new Error(errorMsg);
      }

      const data = (await response.json()) as EstimateResponse;
      setResult(data);

      saveResultToSession({
        ...data,
        calculatedAt: new Date().toISOString(),
        documentName: file.name,
      });
    } catch (e: any) {
      setError(e?.message || 'No pudimos procesar tu W2 en este momento.');
    } finally {
      stopLoadingAnimation();
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
  /*  Render — Loading state                                          */
  /* ================================================================ */

  if (loading) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>Calculadora de Reembolso</h3>

        <div style={styles.loadingContainer}>
          {/* Spinner */}
          <div style={styles.spinnerWrapper}>
            <div style={styles.spinnerOuter} />
            <div style={styles.spinnerInner} />
            <span style={styles.spinnerIcon}>💰</span>
          </div>

          {/* AI badge */}
          <div style={styles.aiBadge}>
            <span>🤖</span>
            <span style={{ fontWeight: 600 }}>Análisis con IA</span>
          </div>

          {/* Step text */}
          <div style={styles.loadingStep}>
            {loadingSteps[loadingStep] || loadingSteps[loadingSteps.length - 1]}
          </div>

          {/* Progress dots */}
          <div style={styles.progressDots}>
            {loadingSteps.map((_, i) => (
              <div
                key={i}
                style={{
                  ...styles.dot,
                  ...(i <= loadingStep ? styles.dotActive : {}),
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ================================================================ */
  /*  Render — Result state                                           */
  /* ================================================================ */

  if (result) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>Calculadora de Reembolso</h3>

        <div style={styles.resultContainer}>
          <div style={styles.refundLabel}>Reembolso Estimado</div>
          <div style={styles.refundAmount}>${result.estimatedRefund.toFixed(2)}</div>

          {(result.box2Federal > 0 || result.box17State > 0) && (
            <div style={styles.breakdown}>
              <div style={styles.breakdownRow}>
                <span style={styles.breakdownLabel}>Box 2 (Federal)</span>
                <span style={styles.breakdownValue}>${result.box2Federal.toFixed(2)}</span>
              </div>
              <div style={styles.breakdownRow}>
                <span style={styles.breakdownLabel}>Box 17 (Estatal)</span>
                <span style={styles.breakdownValue}>${result.box17State.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Status badges */}
          <div style={styles.badges}>
            <div style={styles.badge}>
              <span>✓</span>
              <span>W2 Procesado</span>
            </div>
            <div style={styles.badge}>
              <span>🔒</span>
              <span>Guardado localmente</span>
            </div>
          </div>

          <div style={styles.sessionNote}>
            <span>Este cálculo está guardado localmente en este navegador y se borrará al finalizar la sesión.</span>
          </div>
        </div>

        <button type="button" onClick={resetCalculator} style={styles.resetButton}>
          Calcular con otro documento
        </button>
      </div>
    );
  }

  /* ================================================================ */
  /*  Render — Upload state                                           */
  /* ================================================================ */

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Calculadora de Reembolso</h3>
      <p style={styles.subtitle}>
        Sube tu W-2 y extraeremos Box 2 y Box 17 automáticamente.
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
          <img src={previewUrl} alt="Vista previa W2" style={styles.previewImage} />
        ) : file ? (
          <div style={styles.fileInfo}>
            <span style={{ fontSize: 32 }}>📄</span>
            <span style={styles.fileName}>{file.name}</span>
          </div>
        ) : (
          <div style={styles.dropzoneContent}>
            <span style={{ fontSize: 32 }}>📤</span>
            <span style={styles.dropzoneMain}>Arrastra tu W2 aquí</span>
            <span style={styles.dropzoneOr}>o</span>
            <span style={styles.dropzoneBrowse}>haz clic para seleccionar</span>
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
        Calcular desde W-2
      </button>

      {error && <p style={styles.errorText}>{error}</p>}

      <div style={styles.sessionNote}>
        <span>🔒 Tu información se guarda localmente durante esta sesión y se elimina al cerrarla.</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Framer Property Controls                                          */
/* ------------------------------------------------------------------ */

addPropertyControls(W2CalculatorEmbed, {
  apiBaseUrl: {
    type: ControlType.String,
    title: 'API Base URL',
    description: 'URL del backend en Railway (ej: https://tax-calculator-production.up.railway.app)',
    defaultValue: '',
  },
  bearerToken: {
    type: ControlType.String,
    title: 'Bearer Token',
    description: 'Token de autenticación (opcional)',
    defaultValue: '',
  },
});

/* ------------------------------------------------------------------ */
/*  Keyframe animation (injected once)                                */
/* ------------------------------------------------------------------ */

const SPINNER_ID = 'jai1-spinner-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(SPINNER_ID)) {
  const style = document.createElement('style');
  style.id = SPINNER_ID;
  style.textContent = `
    @keyframes jai1-spin {
      0%   { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes jai1-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.7; transform: scale(1.08); }
    }
  `;
  document.head.appendChild(style);
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

  /* Loading */
  loadingContainer: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    padding: '32px 0',
    gap: 16,
  },
  spinnerWrapper: {
    position: 'relative' as const,
    width: 80,
    height: 80,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinnerOuter: {
    position: 'absolute' as const,
    inset: 0,
    borderRadius: '50%',
    border: '3px solid #e5e7eb',
    borderTopColor: '#111827',
    animation: 'jai1-spin 1s linear infinite',
  },
  spinnerInner: {
    position: 'absolute' as const,
    inset: 8,
    borderRadius: '50%',
    border: '3px solid #e5e7eb',
    borderTopColor: '#6b7280',
    animation: 'jai1-spin 1.5s linear infinite reverse',
  },
  spinnerIcon: {
    fontSize: 28,
    animation: 'jai1-pulse 2s ease-in-out infinite',
  },
  aiBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 14px',
    background: 'rgba(17, 24, 39, 0.06)',
    borderRadius: 20,
    fontSize: 13,
    color: '#111827',
  },
  loadingStep: {
    fontSize: 15,
    fontWeight: 500,
    color: '#374151',
    textAlign: 'center' as const,
  },
  progressDots: {
    display: 'flex',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#e5e7eb',
    transition: 'background 0.3s',
  },
  dotActive: {
    background: '#111827',
  },

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
  badges: {
    display: 'flex',
    justifyContent: 'center',
    gap: 10,
    marginTop: 14,
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 10px',
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 500,
    background: 'rgba(22, 101, 52, 0.08)',
    color: '#166534',
  },

  /* Session note */
  sessionNote: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    fontSize: 12,
    color: '#9ca3af',
    justifyContent: 'center',
    textAlign: 'center' as const,
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
