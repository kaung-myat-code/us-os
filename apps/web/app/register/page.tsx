'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { UserProfile } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch<UserProfile>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, pairingCode: pairingCode || undefined }),
      });
      router.push(pairingCode ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Register</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        </div>
        <div>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></label>
        </div>
        <div>
          <label>Pairing code (optional) <input value={pairingCode} onChange={(e) => setPairingCode(e.target.value)} maxLength={8} /></label>
        </div>
        <button type="submit">Register</button>
      </form>
      {error && <p>{error}</p>}
      <p><a href="/login">Already have an account? Log in</a></p>
    </main>
  );
}
