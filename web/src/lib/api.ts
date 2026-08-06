export async function api(path: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(path, options);
  if (response.ok) return response;

  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // A non-JSON response still carries a useful HTTP status above.
  }
  throw new Error(message);
}

export async function jsonApi<T>(path: string, options?: RequestInit): Promise<T> {
  return await (await api(path, options)).json() as T;
}
