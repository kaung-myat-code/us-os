import type { HealthStatus } from '@us-os/shared-types';

export default function HomePage() {
  // Constructed here (not module scope) so it reflects the actual render time.
  // This is a Server Component with no client-side re-render, so a
  // request-time timestamp cannot cause a hydration mismatch.
  const health: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };

  return (
    <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Relationship OS</h1>
      <p>
        Monorepo foundation is running. Shared type check: {health.status} at {health.timestamp}
      </p>
    </main>
  );
}
