async function request(path, { signal, timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, timeout);

  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    const response = await fetch(path, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = payload?.error?.code;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}

export const api = {
  search(query, signal) {
    return request(`/api/search?q=${encodeURIComponent(query)}`, { signal, timeout: 35000 });
  },
  discover(signal) {
    return request('/api/discover', { signal, timeout: 60000 });
  },
  info(id, signal) {
    return request(`/api/info?id=${encodeURIComponent(id)}`, { signal, timeout: 35000 });
  },
  resolve(id, signal) {
    return request(`/api/resolve?id=${encodeURIComponent(id)}`, { signal, timeout: 60000 });
  },
  health(signal) {
    return request('/api/health', { signal, timeout: 12000 });
  },
};

export function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 20;
}
