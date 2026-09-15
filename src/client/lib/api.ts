import { reportApiFailure, reportApiResponse } from '@/lib/backendHealth';

/** Minimal authenticated JSON fetch helper. Throws `Error("<status> <statusText>")` or the server's `error` field, with `status` set. */
export async function api<T>(
  path: string,
  getToken: () => Promise<string | null>,
  /** `expect`: statuses this call site handles as normal — see `apiFetch`. Still throws; it only keeps
   *  the backend-health banner from flagging a by-design non-2xx. */
  init?: RequestInit & { expect?: readonly number[] },
): Promise<T> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch (err) {
    // Single choke point: every caller of api() gets backend-fault surfacing with no call-site change.
    reportApiFailure(path, err);
    throw err;
  }
  reportApiResponse(path, res, init?.expect);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `${res.status} ${res.statusText}`), { status: res.status });
  }
  return res.json();
}
