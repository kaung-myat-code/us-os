'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type {
  AuthMeResponse,
  DecisionDetailResponse,
  DecisionOptionResponse,
  TradeOffType,
} from '@us-os/shared-types';
import { apiFetch } from '../../../lib/api';

function computeScore(tradeOffs: DecisionOptionResponse['tradeOffs']): number {
  return tradeOffs.reduce((sum, item) => sum + (item.type === 'pro' ? item.weight : -item.weight), 0);
}

export default function DecisionDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const decisionId = params.id;

  const [decision, setDecision] = useState<DecisionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [optionLabel, setOptionLabel] = useState('');
  const [tradeOffForms, setTradeOffForms] = useState<
    Record<string, { type: TradeOffType; label: string; weight: number }>
  >({});
  const [chosenOptionId, setChosenOptionId] = useState('');
  const [outcomeNote, setOutcomeNote] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<DecisionDetailResponse>(`/decisions/${decisionId}`))
      .then(setDecision)
      .catch(() => router.push('/login'));
  }, [decisionId, router]);

  function tradeOffFormFor(optionId: string) {
    return tradeOffForms[optionId] ?? { type: 'pro' as TradeOffType, label: '', weight: 3 };
  }

  async function refresh() {
    const updated = await apiFetch<DecisionDetailResponse>(`/decisions/${decisionId}`);
    setDecision(updated);
  }

  async function handleAddOption(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/options`, {
        method: 'POST',
        body: JSON.stringify({ label: optionLabel }),
      });
      setOptionLabel('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeleteOption(optionId: string) {
    if (!window.confirm('Delete this option?')) return;
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/options/${optionId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAddTradeOff(optionId: string, e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const form = tradeOffFormFor(optionId);
    try {
      await apiFetch(`/decisions/${decisionId}/options/${optionId}/tradeoffs`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setTradeOffForms((prev) => ({ ...prev, [optionId]: { type: 'pro', label: '', weight: 3 } }));
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDeleteTradeOff(optionId: string, tradeoffId: string) {
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/options/${optionId}/tradeoffs/${tradeoffId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDecide(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/decide`, {
        method: 'PATCH',
        body: JSON.stringify({ chosenOptionId, outcomeNote: outcomeNote || undefined }),
      });
      setChosenOptionId('');
      setOutcomeNote('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleReopen() {
    setError(null);
    try {
      await apiFetch(`/decisions/${decisionId}/reopen`, { method: 'PATCH' });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (decision === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  const chosenOption = decision.options.find((option) => option.id === decision.chosenOptionId);

  return (
    <main>
      <h1>{decision.title}</h1>
      <p>Status: {decision.status}</p>
      {decision.rationale && <p>{decision.rationale}</p>}

      {decision.options.map((option) => {
        const form = tradeOffFormFor(option.id);
        return (
          <section key={option.id}>
            <h2>
              {option.label} — score: {computeScore(option.tradeOffs)}
            </h2>
            <ul>
              {option.tradeOffs.map((item) => (
                <li key={item.id}>
                  [{item.type}] {item.label} (weight {item.weight}){' '}
                  <button type="button" onClick={() => handleDeleteTradeOff(option.id, item.id)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={(e) => handleAddTradeOff(option.id, e)}>
              <select
                value={form.type}
                onChange={(e) =>
                  setTradeOffForms((prev) => ({
                    ...prev,
                    [option.id]: { ...form, type: e.target.value as TradeOffType },
                  }))
                }
              >
                <option value="pro">pro</option>
                <option value="con">con</option>
              </select>
              <input
                placeholder="Label"
                value={form.label}
                onChange={(e) => setTradeOffForms((prev) => ({ ...prev, [option.id]: { ...form, label: e.target.value } }))}
                required
              />
              <input
                type="number"
                min={1}
                max={5}
                value={form.weight}
                onChange={(e) =>
                  setTradeOffForms((prev) => ({ ...prev, [option.id]: { ...form, weight: Number(e.target.value) } }))
                }
              />
              <button type="submit">Add trade-off</button>
            </form>
            <button type="button" onClick={() => handleDeleteOption(option.id)}>
              Delete option
            </button>
          </section>
        );
      })}

      {decision.options.length < 6 && (
        <form onSubmit={handleAddOption}>
          <label>
            New option <input value={optionLabel} onChange={(e) => setOptionLabel(e.target.value)} required />
          </label>
          <button type="submit">Add option</button>
        </form>
      )}

      {decision.status === 'open' ? (
        <form onSubmit={handleDecide}>
          <h2>Decide</h2>
          <select value={chosenOptionId} onChange={(e) => setChosenOptionId(e.target.value)} required>
            <option value="">Choose an option</option>
            {decision.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <textarea
            placeholder="Outcome note (optional)"
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value)}
          />
          <button type="submit">Decide</button>
        </form>
      ) : (
        <section>
          <h2>Decided: {chosenOption?.label}</h2>
          {decision.outcomeNote && <p>{decision.outcomeNote}</p>}
          <button type="button" onClick={handleReopen}>
            Reopen
          </button>
        </section>
      )}

      {error && <p>{error}</p>}
    </main>
  );
}
