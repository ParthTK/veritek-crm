const TOKEN_KEY = 'veritek.session';

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token, remember = true) {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: the session lasts for this page only */
  }
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || {};
  }

  get fields() {
    return this.details?.fields || {};
  }

  get code() {
    return this.details?.code;
  }
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    params.set(k, v === true ? '1' : v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Calls the API. A network failure never pretends to succeed: the caller gets a clear error and keeps the
 * user's input so the save can be retried (with the same idempotency key, so it cannot duplicate).
 */
export async function api(path, { method = 'GET', body, query, key, raw, contentType } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  if (raw) headers['Content-Type'] = contentType || 'application/octet-stream';
  else if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}${queryString(query)}`, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Nothing was saved — your entries are kept, so you can try again.');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : await res.text();
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    setToken(null);
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!res.ok) throw new ApiError(res.status, (isJson && data?.error) || `Request failed (${res.status})`, isJson ? data?.details : undefined);
  return data;
}

api.get = (path, query) => api(path, { query });
api.post = (path, body, opts = {}) => api(path, { method: 'POST', body: body ?? {}, ...opts });
api.put = (path, body) => api(path, { method: 'PUT', body: body ?? {} });
api.del = (path) => api(path, { method: 'DELETE' });

/** Uploads a file to private storage, optionally linked to a record. */
export async function uploadFile(file, { entity_type, entity_id, description } = {}) {
  if (file.size > 20 * 1024 * 1024) throw new ApiError(400, `${file.name} is larger than 20 MB`);
  return api('/attachments', { method: 'POST', raw: file, contentType: file.type || 'application/octet-stream', query: { name: file.name, entity_type, entity_id, description } });
}

/** Opens a document through a short-lived, user-bound link (the session token never goes in a URL). */
export async function openFile(id, { download = false } = {}) {
  const { url } = await api.get(`/attachments/${id}/url`);
  window.open(`${url}${download ? '&download=1' : ''}`, '_blank', 'noopener');
}

/** Fetches an authenticated image (e.g. a QR code) and returns an object URL for <img src>. */
export async function authedBlobUrl(path) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError(0, 'Cannot reach the server.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Could not load the image');
  }
  return URL.createObjectURL(await res.blob());
}

/** Downloads an authenticated CSV/ZIP export. */
export async function downloadAuthed(path, query, fallbackName = 'export.csv') {
  const token = getToken();
  let res;
  try {
    res = await fetch(`/api${path}${queryString(query)}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new ApiError(0, 'Cannot reach the server.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || 'Download failed');
  }
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
