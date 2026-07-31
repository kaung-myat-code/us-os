'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse, PromiseResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function PromisesPage() {
  const router = useRouter();
  const [promises, setPromises] = useState<PromiseResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<PromiseResponse[]>('/promises'))
      .then(setPromises)
      .catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<PromiseResponse>('/promises', {
        method: 'POST',
        body: JSON.stringify({ title, dueDate: dueDate || null, note: note || null }),
      });
      setPromises((prev) => [created, ...(prev ?? [])]);
      setTitle('');
      setDueDate('');
      setNote('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleResolve(promise: PromiseResponse, status: 'kept' | 'broken') {
    setError(null);
    try {
      const updated = await apiFetch<PromiseResponse>(`/promises/${promise.id}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setPromises((prev) => (prev ?? []).map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(promise: PromiseResponse) {
    if (!window.confirm('Delete this promise?')) return;
    setError(null);
    try {
      await apiFetch(`/promises/${promise.id}`, { method: 'DELETE' });
      setPromises((prev) => (prev ?? []).filter((p) => p.id !== promise.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (promises === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Promises</h1>

      <ul>
        {promises.map((promise) => (
          <li key={promise.id}>
            <strong>{promise.title}</strong> — {promise.status}
            {promise.dueDate && <span> — due: {promise.dueDate}</span>}
            {promise.note && <p>{promise.note}</p>}
            {promise.status === 'pending' ? (
              <div>
                <button type="button" onClick={() => handleResolve(promise, 'kept')}>
                  Mark kept
                </button>
                <button type="button" onClick={() => handleResolve(promise, 'broken')}>
                  Mark broken
                </button>
              </div>
            ) : (
              <p>
                Resolved by {promise.resolvedBy} at {promise.resolvedAt}
              </p>
            )}
            <button type="button" onClick={() => handleDelete(promise)}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <h2>New promise</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Due date <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>
        <div>
          <label>
            Note <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create promise</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
