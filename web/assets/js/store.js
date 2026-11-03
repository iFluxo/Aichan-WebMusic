import { clamp, normalizeTrack } from './util.js';

const KEYS = {
  queue: 'awm.v1.queue',
  library: 'awm.v1.library',
  playlists: 'awm.v1.playlists',
  history: 'awm.v1.history',
  prefs: 'awm.v1.prefs',
};

const MAX_QUEUE = 200;
const MAX_LIBRARY = 300;
const MAX_HISTORY = 24;

const listeners = new Set();

export const state = {
  queue: [],
  index: -1,
  current: null,
  playing: false,
  loading: false,
  library: [],
  playlists: [],
  history: [],
  volume: 0.8,
  muted: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(type, detail = {}) {
  for (const fn of [...listeners]) {
    try {
      fn(type, detail);
    } catch (error) {
      console.error('store listener failed', error);
    }
  }
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode/quota); state still works in memory.
  }
}

function cleanList(value, limit) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const track = normalizeTrack(raw);
    if (!track || seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
    if (out.length >= limit) break;
  }
  return out;
}

function persistQueue() {
  writeJSON(KEYS.queue, { tracks: state.queue, index: state.index });
}

function persistLibrary() {
  writeJSON(KEYS.library, state.library);
}

function persistPlaylists() {
  writeJSON(KEYS.playlists, state.playlists);
}

function persistPrefs() {
  writeJSON(KEYS.prefs, { volume: state.volume, muted: state.muted });
}

export function hydrate() {
  const q = readJSON(KEYS.queue, null);
  if (q && Array.isArray(q.tracks)) {
    state.queue = cleanList(q.tracks, MAX_QUEUE);
    const idx = Number.isInteger(q.index) ? q.index : -1;
    state.index = state.queue.length ? clamp(idx, 0, state.queue.length - 1) : -1;
    state.current = state.index >= 0 ? state.queue[state.index] : null;
  }

  state.library = cleanList(readJSON(KEYS.library, []), MAX_LIBRARY);
  state.history = cleanList(readJSON(KEYS.history, []), MAX_HISTORY);

  const playlists = readJSON(KEYS.playlists, []);
  if (Array.isArray(playlists)) {
    state.playlists = playlists
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .slice(0, 60)
      .map((p) => ({
        id: p.id,
        name: String(p.name).slice(0, 60),
        createdAt: Number(p.createdAt) || Date.now(),
        tracks: cleanList(p.tracks, MAX_QUEUE),
      }));
  }

  const prefs = readJSON(KEYS.prefs, null);
  if (prefs) {
    if (Number.isFinite(prefs.volume)) state.volume = clamp(prefs.volume, 0, 1);
    if (typeof prefs.muted === 'boolean') state.muted = prefs.muted;
  }
}

/* ---------------- queue ---------------- */

export function setQueue(tracks, startIndex = 0) {
  state.queue = cleanList(tracks, MAX_QUEUE);
  if (!state.queue.length) {
    state.index = -1;
    state.current = null;
  } else {
    state.index = clamp(startIndex, 0, state.queue.length - 1);
    state.current = state.queue[state.index];
  }
  persistQueue();
  emit('queue');
  emit('track', { track: state.current });
  return state.current;
}

export function setIndex(index) {
  if (!state.queue.length) {
    state.index = -1;
    state.current = null;
  } else {
    state.index = clamp(index, 0, state.queue.length - 1);
    state.current = state.queue[state.index];
  }
  persistQueue();
  emit('queue');
  emit('track', { track: state.current });
  return state.current;
}

export function enqueue(track, { next = false } = {}) {
  const t = normalizeTrack(track);
  if (!t) return { added: false, reason: 'invalid' };
  if (state.queue.some((item) => item.id === t.id)) {
    return { added: false, reason: 'duplicate' };
  }
  if (!state.queue.length) {
    state.queue = [t];
    state.index = 0;
    state.current = t;
  } else if (next && state.index >= 0) {
    state.queue.splice(state.index + 1, 0, t);
  } else {
    state.queue.push(t);
  }
  persistQueue();
  emit('queue');
  emit('track', { track: state.current });
  return { added: true, index: state.queue.findIndex((item) => item.id === t.id) };
}

export function removeAt(index) {
  if (index < 0 || index >= state.queue.length) return { removed: false };
  const wasCurrent = index === state.index;
  const [removed] = state.queue.splice(index, 1);

  if (!state.queue.length) {
    state.index = -1;
    state.current = null;
  } else if (index < state.index) {
    state.index -= 1;
    state.current = state.queue[state.index];
  } else if (wasCurrent) {
    state.index = clamp(index, 0, state.queue.length - 1);
    state.current = state.queue[state.index];
  }

  persistQueue();
  emit('queue');
  if (wasCurrent) emit('track', { track: state.current });
  return { removed: true, wasCurrent, removedTrack: removed, current: state.current };
}

export function move(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return;
  const currentID = state.current?.id;
  const [item] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, item);
  if (currentID) {
    const nextIndex = state.queue.findIndex((track) => track.id === currentID);
    if (nextIndex >= 0) state.index = nextIndex;
  }
  persistQueue();
  emit('queue');
}

export function clearQueue() {
  state.queue = [];
  state.index = -1;
  state.current = null;
  persistQueue();
  emit('queue');
  emit('track', { track: null });
}

/* ---------------- library ---------------- */

export function isSaved(id) {
  return state.library.some((track) => track.id === id);
}

export function toggleSaved(track) {
  const t = normalizeTrack(track);
  if (!t) return false;
  const existing = state.library.findIndex((item) => item.id === t.id);
  if (existing >= 0) {
    state.library.splice(existing, 1);
    persistLibrary();
    emit('library');
    return false;
  }
  state.library.unshift(t);
  state.library = state.library.slice(0, MAX_LIBRARY);
  persistLibrary();
  emit('library');
  return true;
}

/* ---------------- playlists ---------------- */

function newID() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // ignore
  }
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createPlaylist(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return null;
  const playlist = { id: newID(), name: clean, createdAt: Date.now(), tracks: [] };
  state.playlists.unshift(playlist);
  persistPlaylists();
  emit('playlists');
  return playlist;
}

export function deletePlaylist(id) {
  const before = state.playlists.length;
  state.playlists = state.playlists.filter((p) => p.id !== id);
  if (state.playlists.length === before) return false;
  persistPlaylists();
  emit('playlists');
  return true;
}

export function getPlaylist(id) {
  return state.playlists.find((p) => p.id === id) || null;
}

export function addToPlaylist(id, track) {
  const playlist = getPlaylist(id);
  const t = normalizeTrack(track);
  if (!playlist || !t) return false;
  if (playlist.tracks.some((item) => item.id === t.id)) return false;
  playlist.tracks.unshift(t);
  persistPlaylists();
  emit('playlists');
  return true;
}

export function removeFromPlaylist(id, trackID) {
  const playlist = getPlaylist(id);
  if (!playlist) return false;
  const before = playlist.tracks.length;
  playlist.tracks = playlist.tracks.filter((item) => item.id !== trackID);
  if (playlist.tracks.length === before) return false;
  persistPlaylists();
  emit('playlists');
  return true;
}

/* ---------------- history + prefs ---------------- */

export function pushHistory(track) {
  const t = normalizeTrack(track);
  if (!t) return;
  if (state.history[0]?.id === t.id) return;
  state.history = [t, ...state.history.filter((item) => item.id !== t.id)].slice(0, MAX_HISTORY);
  writeJSON(KEYS.history, state.history);
  emit('history');
}

export function setVolume(volume, muted) {
  state.volume = clamp(volume, 0, 1);
  if (typeof muted === 'boolean') state.muted = muted;
  persistPrefs();
  emit('prefs');
}
