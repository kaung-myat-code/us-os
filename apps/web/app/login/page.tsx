'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AuthMeResponse } from '@us-os/shared-types';
import { apiFetch } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const me = await apiFetch<AuthMeResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      router.push(me.space ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main>
      <h1>Log in</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        </div>
        <div>
          <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        </div>
        <button type="submit">Log in</button>
      </form>
      {error && <p>{error}</p>}
      <p><a href="/register">Need an account? Register</a></p>
    </main>
  );
}
