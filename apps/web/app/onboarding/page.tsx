'use client';

import { useState } from 'react';
import type { PairingCodeResponse, Space } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function OnboardingPage() {
  const [name, setName] = useState('');
  const [space, setSpace] = useState<Space | null>(null);
  const [pairingCode, setPairingCode] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreateSpace(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await apiFetch<Space>('/spaces', { method: 'POST', body: JSON.stringify({ name }) });
      setSpace(created);
      const code = await apiFetch<PairingCodeResponse>('/spaces/pairing-codes', { method: 'POST', body: '{}' });
      setPairingCode(code);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (space && pairingCode) {
    return (
      <main>
        <h1>{space.name} created</h1>
        <p>Share this code with your partner. It expires at {pairingCode.expiresAt}.</p>
        <p><strong>{pairingCode.code}</strong></p>
        <p><a href="/dashboard">Continue</a></p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your Space</h1>
      <form onSubmit={handleCreateSpace}>
        <div>
          <label>Space name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        </div>
        <button type="submit">Create Space</button>
      </form>
      {error && <p>{error}</p>}
      <p><a href="/onboarding/pair">Have a pairing code instead?</a></p>
    </main>
  );
}
