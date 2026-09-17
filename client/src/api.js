const TOKEN_KEY = 'veritek.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session lasts for this tab only */
  }
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function api(path, { method = 'GET', body, query } = {}) {
  const headers = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}${queryString(query)}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/public')) {
    setToken(null);
    window.dispatchEvent(new Event('auth:expired'));
  }
  if (!res.ok) throw new ApiError(res.status, (isJson && data?.error) || 'Request failed', isJson ? data?.details : undefined);
  return data;
}

api.get = (path, query) => api(path, { query });
api.post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
api.put = (path, body) => api(path, { method: 'PUT', body: body ?? {} });
api.del = (path) => api(path, { method: 'DELETE' });

export function fileUrl(id, { download = false } = {}) {
  return `/api/attachments/${id}/file?access_token=${encodeURIComponent(getToken() || '')}${download ? '&download=1' : ''}`;
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Upload a File or Blob. Unlinked uploads (entity "pending") are attached when the parent record saves. */
export async function uploadFile(file, { entity = 'pending', entity_id = 0, kind = 'file', name } = {}) {
  if (file.size > 20 * 1024 * 1024) throw new ApiError(400, `${file.name || 'File'} is larger than 20 MB`);
  const data = await readAsDataUrl(file);
  return api.post('/attachments', { name: name || file.name || 'upload', mime: file.type || 'application/octet-stream', data, entity, entity_id, kind });
}
