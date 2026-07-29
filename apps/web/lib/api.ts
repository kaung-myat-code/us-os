export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    // Error responses are usually RFC 7807 JSON, but a CORS rejection, proxy
    // error, or dev-server crash can return an empty/HTML body instead —
    // don't let res.json() throw a confusing SyntaxError in that case.
    let detail = 'Request failed';
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      // non-JSON error response, fall back to the generic message
    }
    throw new Error(detail);
  }

  return res.json() as Promise<T>;
}
