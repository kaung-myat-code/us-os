'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AuthMeResponse, DecisionListItemResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function DecisionsPage() {
  const router = useRouter();
  const [decisions, setDecisions] = useState<DecisionListItemResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');

  useEffect(() => {
    apiFetch<AuthMeResponse>('/auth/me')
      .then(() => apiFetch<DecisionListItemResponse[]>('/decisions'))
      .then(setDecisions)
      .catch(() => router.push('/login'));
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<DecisionListItemResponse>('/decisions', {
        method: 'POST',
        body: JSON.stringify({ title, rationale: rationale || null }),
      });
      setDecisions((prev) => [created, ...(prev ?? [])]);
      setTitle('');
      setRationale('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (decisions === null) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Decisions</h1>

      <ul>
        {decisions.map((decision) => (
          <li key={decision.id}>
            <Link href={`/decisions/${decision.id}`}>{decision.title}</Link> — {decision.status}
            {decision.rationale && <p>{decision.rationale}</p>}
          </li>
        ))}
      </ul>

      <h2>New decision</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label>
            Title <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
        </div>
        <div>
          <label>
            Rationale <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </label>
        </div>
        <button type="submit">Create decision</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
