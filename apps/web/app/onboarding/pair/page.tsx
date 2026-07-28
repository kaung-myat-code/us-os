'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../lib/api';

export default function OnboardingPairPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch('/spaces/pairing-codes/redeem', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Join your partner&apos;s Space</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Pairing code <input value={code} onChange={(e) => setCode(e.target.value)} required maxLength={8} /></label>
        </div>
        <button type="submit">Join</button>
      </form>
      {error && <p>{error}</p>}
    </main>
  );
}
