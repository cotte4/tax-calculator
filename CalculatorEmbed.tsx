import React, { useMemo, useState } from 'react';

type SimpleEstimateResponse = {
  box2Federal: number;
  box17State: number;
  estimatedRefund: number;
  ocrConfidence: 'manual';
};

type CalculatorEmbedProps = {
  apiBaseUrl: string; // e.g. https://your-backend.vercel.app or https://your-backend.netlify.app
  onSuccess?: (result: SimpleEstimateResponse) => void;
};

export default function CalculatorEmbed({
  apiBaseUrl,
  onSuccess,
}: CalculatorEmbedProps) {
  const [box2Federal, setBox2Federal] = useState('');
  const [box17State, setBox17State] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimatedRefund, setEstimatedRefund] = useState<number | null>(null);

  const canSubmit = useMemo(() => {
    const federal = Number(box2Federal);
    const state = Number(box17State);
    return (
      box2Federal.trim() !== '' &&
      box17State.trim() !== '' &&
      Number.isFinite(federal) &&
      Number.isFinite(state) &&
      federal >= 0 &&
      state >= 0
    );
  }, [box2Federal, box17State]);

  async function calculate() {
    if (!canSubmit) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${apiBaseUrl.replace(/\/$/, '')}/api/calculate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            box2Federal: Number(box2Federal),
            box17State: Number(box17State),
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to calculate estimate');
      }

      const data = (await response.json()) as SimpleEstimateResponse;
      setEstimatedRefund(data.estimatedRefund);
      onSuccess?.(data);
    } catch (err) {
      setEstimatedRefund(null);
      setError(
        err instanceof Error
          ? err.message
          : 'Could not calculate estimate right now.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 420,
        border: '1px solid #d1d5db',
        borderRadius: 12,
        padding: 16,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <h3 style={{ marginTop: 0 }}>Refund Calculator</h3>

      <label style={{ display: 'block', marginBottom: 10 }}>
        <div style={{ marginBottom: 6 }}>Box 2 (Federal)</div>
        <input
          type="number"
          min={0}
          step="0.01"
          value={box2Federal}
          onChange={(e) => setBox2Federal(e.target.value)}
          style={{ width: '100%', padding: 8, borderRadius: 8 }}
        />
      </label>

      <label style={{ display: 'block', marginBottom: 10 }}>
        <div style={{ marginBottom: 6 }}>Box 17 (State)</div>
        <input
          type="number"
          min={0}
          step="0.01"
          value={box17State}
          onChange={(e) => setBox17State(e.target.value)}
          style={{ width: '100%', padding: 8, borderRadius: 8 }}
        />
      </label>

      <button
        type="button"
        onClick={calculate}
        disabled={!canSubmit || loading}
        style={{
          width: '100%',
          padding: 10,
          borderRadius: 8,
          border: 'none',
          color: '#fff',
          background: !canSubmit || loading ? '#9ca3af' : '#111827',
          cursor: !canSubmit || loading ? 'not-allowed' : 'pointer',
        }}
      >
        {loading ? 'Calculating...' : 'Calculate'}
      </button>

      {error && <p style={{ color: '#b91c1c', marginTop: 12 }}>{error}</p>}

      {estimatedRefund !== null && (
        <p style={{ marginTop: 12 }}>
          Estimated refund: <strong>${estimatedRefund.toFixed(2)}</strong>
        </p>
      )}
    </div>
  );
}

