import { state, emit, setIndex, setQueue, removeAt, move, clearQueue, pushHistory, setVolume } from './store.js';
import { formatTime, icon, thumbURL } from './util.js';
import { showToast } from './toast.js';
import { api, isAbort } from './api.js';

const playerEl = document.getElementById('player');
const audio = new Audio();
audio.preload = 'metadata';

const refs = {
  art: document.getElementById('player-art'),
  title: document.getElementById('player-title'),
  channel: document.getElementById('player-channel'),
  play: document.getElementById('btn-play'),
  playIcon: document.getElementById('play-icon'),
  prev: document.getElementById('btn-prev'),
  next: document.getElementById('btn-next'),
  seek: document.getElementById('seek'),
  current: document.getElementById('time-current'),
  total: document.getElementById('time-total'),
  volume: document.getElementById('volume'),
  mute: document.getElementById('btn-mute'),
  volumeIcon: document.getElementById('volume-icon'),
  like: document.getElementById('player-like'),
};

let loadedID = null;
let historyID = null;
let seeking = false;
let suppressingVolumeEvent = false;

// Resolve-first playback state. The audio element is only given a src after the
// backend has cached a playable source; this keeps cold yt-dlp extraction from
// tripping browser media request timeouts.
let desiredPlaying = false;
let loadSeq = 0;
let pendingResolve = null; // { id, controller, promise }

const DEFAULT_TITLE = 'Aichan Music · liquid glass player';

function setFill(input, percent) {
  input.style.setProperty('--fill', `${Math.min(100, Math.max(0, percent))}%`);
}

function updatePlayUI() {
  const playing = !audio.paused && !audio.ended && loadedID !== null;
  state.playing = playing;
  refs.playIcon.innerHTML = icon(playing ? 'pause' : 'play');
  refs.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch { /* ignore */ }
  }
  emit('player', { playing });
}

function setLoading(loading) {
  state.loading = loading;
  playerEl.classList.toggle('loading', loading);
  refs.play.setAttribute('aria-busy', loading ? 'true' : 'false');
}

function renderTrack(track) {
  if (!track) {
    refs.title.textContent = 'Nothing playing yet';
    refs.channel.textContent = 'Pick a track to begin';
    refs.art.innerHTML = `<div class="art-fallback">${icon('music')}</div>`;
    refs.like.disabled = true;
    refs.like.classList.remove('is-active');
    refs.like.setAttribute('aria-pressed', 'false');
    refs.seek.disabled = true;
    refs.seek.value = 0;
    setFill(refs.seek, 0);
    refs.current.textContent = '0:00';
    refs.total.textContent = '0:00';
    document.title = DEFAULT_TITLE;
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = null; } catch { /* ignore */ }
    }
    return;
  }

  refs.title.textContent = track.title;
  refs.channel.textContent = track.channel || 'Unknown artist';
  const url = thumbURL(track);
  refs.art.innerHTML = url
    ? `<img class="art-img" src="${url}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : `<div class="art-fallback">${icon('music')}</div>`;
  refs.like.disabled = false;
  refs.seek.disabled = false;
  refs.total.textContent = formatTime(track.duration || 0);
  document.title = `${track.title} · Aichan Music`;

  updateMediaSession(track);
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    const artwork = thumbURL(track);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.channel || 'Unknown artist',
      album: 'Aichan Music',
      artwork: artwork ? [{ src: artwork, type: 'image/jpeg' }] : [],
    });
  } catch {
    // Media Session is best-effort.
  }
}

function updateProgress() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (state.current?.duration || 0);
  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

  if (!seeking) {
    const percent = duration > 0 ? (currentTime / duration) * 100 : 0;
    refs.seek.value = String(Math.round(percent * 10));
    setFill(refs.seek, percent);
    refs.current.textContent = formatTime(currentTime);
  }
  refs.total.textContent = formatTime(duration);
}

function applySeek(value) {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (state.current?.duration || 0);
  if (!duration || !state.current) return;
  const target = (Number(value) / 1000) * duration;
  try {
    audio.currentTime = Math.max(0, Math.min(duration - 0.15, target));
  } catch {
    // Seeking can fail before metadata is ready.
  }
  refs.current.textContent = formatTime(target);
  setFill(refs.seek, Number(value) / 10);
}

function updateVolumeUI() {
  const percent = Math.round(state.volume * 100);
  suppressingVolumeEvent = true;
  refs.volume.value = String(percent);
  setFill(refs.volume, percent);
  suppressingVolumeEvent = false;
  refs.volumeIcon.innerHTML = `<use href="#i-${audio.muted || state.volume === 0 ? 'mute' : 'volume'}"/>`;
  refs.mute.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
  refs.mute.classList.toggle('is-active', audio.muted);
}

function applyVolume() {
  audio.volume = Math.min(1, Math.max(0, state.volume));
  audio.muted = state.muted;
  updateVolumeUI();
}

// A short silent clip primes the audio element during the user's gesture.
// Resolving a stream can take several seconds, after which the original
// gesture may have expired for stricter browsers (notably iOS Safari).
const SILENT_SRC = '/assets/audio/silence.wav';
let unlocked = false;
let unlocking = false;
let unlockSeq = -1;

function unlockHandler() {
  if (unlocked || unlocking) return;
  if (loadedID !== null || pendingResolve || audio.getAttribute('src')) return;
  unlocking = true;
  unlockSeq = loadSeq;
  audio.muted = true;
  audio.src = SILENT_SRC;
  const promise = audio.play();
  if (promise) {
    promise.then(finishUnlock).catch(() => {
      unlocking = false;
      audio.muted = state.muted;
      audio.removeAttribute('src');
      audio.load();
    });
  } else {
    finishUnlock();
  }
}

function finishUnlock() {
  if (!unlocking) return;
  unlocking = false;
  unlocked = true;
  document.removeEventListener('pointerdown', unlockHandler, true);
  document.removeEventListener('keydown', unlockHandler, true);
  audio.muted = state.muted;
  // A real track may have started loading during the unlock; leave it alone.
  if (loadedID !== null || pendingResolve || loadSeq !== unlockSeq) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  renderTrack(state.current);
  setLoading(false);
  updatePlayUI();
  updateProgress();
}

export function initPlayer() {
  applyVolume();
  renderTrack(state.current);

  document.addEventListener('pointerdown', unlockHandler, { capture: true, passive: true });
  document.addEventListener('keydown', unlockHandler, true);

  refs.play.addEventListener('click', () => toggle());
  refs.prev.addEventListener('click', () => previous());
  refs.next.addEventListener('click', () => next());
  refs.mute.addEventListener('click', toggleMute);
  refs.like.addEventListener('click', () => {
    if (state.current) emit('request-like', { track: state.current });
  });

  refs.volume.addEventListener('input', () => {
    if (suppressingVolumeEvent) return;
    const volume = Number(refs.volume.value) / 100;
    state.volume = volume;
    audio.volume = volume;
    if (volume > 0 && audio.muted) {
      audio.muted = false;
      state.muted = false;
    }
    setFill(refs.volume, volume * 100);
    updateVolumeUI();
  });
  refs.volume.addEventListener('change', () => {
    setVolume(state.volume, audio.muted);
  });

  refs.seek.addEventListener('input', () => {
    seeking = true;
    const percent = Number(refs.seek.value) / 10;
    setFill(refs.seek, percent);
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.current?.duration || 0);
    refs.current.textContent = formatTime((percent / 100) * duration);
  });
  refs.seek.addEventListener('change', () => {
    seeking = false;
    applySeek(refs.seek.value);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (!loadedID) return;
    setLoading(false);
    updateProgress();
  });
  audio.addEventListener('durationchange', updateProgress);
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('play', () => { if (!unlocking) updatePlayUI(); });
  audio.addEventListener('pause', updatePlayUI);
  audio.addEventListener('playing', () => {
    if (!loadedID) return;
    setLoading(false);
    updatePlayUI();
    if (state.current && historyID !== state.current.id) {
      historyID = state.current.id;
      pushHistory(state.current);
    }
  });
  audio.addEventListener('waiting', () => {
    if (loadedID) setLoading(true);
  });
  audio.addEventListener('canplay', () => { if (loadedID) setLoading(false); });
  audio.addEventListener('stalled', () => {
    if (loadedID && !audio.paused) setLoading(true);
  });
  audio.addEventListener('volumechange', updateVolumeUI);
  audio.addEventListener('ended', () => {
    if (!loadedID || unlocking) return;
    if (state.index + 1 < state.queue.length) {
      next({ auto: true });
    } else {
      updatePlayUI();
      updateProgress();
      setLoading(false);
    }
  });
  audio.addEventListener('error', () => {
    if (!loadedID) return;
    setLoading(false);
    updatePlayUI();
    const code = audio.error?.code;
    let message = 'Could not stream this track. Try another one.';
    if (code === MediaError.MEDIA_ERR_NETWORK) message = 'Network error while loading audio. Check the server connection.';
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) message = 'This audio format is not playable in your browser.';
    showToast(message, 'error', 6000);
  });

  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => toggle(true),
      pause: () => toggle(false),
      previoustrack: () => previous(),
      nexttrack: () => next(),
      stop: () => { audio.pause(); },
      seekbackward: (details) => seekBy(-(details?.seekOffset || 10)),
      seekforward: (details) => seekBy(details?.seekOffset || 10),
      seekto: (details) => { if (Number.isFinite(details?.seekTime)) audio.currentTime = details.seekTime; },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
  }
}

function startAudio(seq) {
  if (seq !== loadSeq) return;
  if (audio.ended) {
    try { audio.currentTime = 0; } catch { /* ignore */ }
  }
  const promise = audio.play();
  if (promise) {
    promise.catch((error) => {
      if (error?.name === 'AbortError' || seq !== loadSeq) return;
      setLoading(false);
      updatePlayUI();
      if (error?.name === 'NotAllowedError') {
        showToast('Autoplay was blocked. Press play to start the music.', 'info');
      } else {
        showToast('Playback could not start. Try another track.', 'error');
      }
    });
  }
}

function resetProgress(track) {
  refs.seek.value = '0';
  setFill(refs.seek, 0);
  refs.current.textContent = '0:00';
  refs.total.textContent = formatTime(track?.duration || 0);
}

async function activate(shouldPlay) {
  const track = state.current;
  if (!track) {
    stopPlayback();
    return;
  }

  desiredPlaying = Boolean(shouldPlay);
  const trackID = track.id;
  const seq = ++loadSeq;

  renderTrack(track);
  emit('track', { track });

  if (loadedID === trackID) {
    setLoading(false);
    if (desiredPlaying) startAudio(seq);
    else {
      audio.pause();
      updatePlayUI();
    }
    return;
  }

  resetProgress(track);
  setLoading(true);
  updatePlayUI();

  // Real playback takes priority over speculative prefetches.
  window.dispatchEvent(new CustomEvent('aichan:resolve-start', { detail: { id: trackID } }));

  // Reuse an in-flight resolve for the same track, abort one for another track.
  let entry = pendingResolve;
  if (entry?.id !== trackID) {
    if (entry) entry.controller.abort();
    const controller = new AbortController();
    entry = { id: trackID, controller, promise: api.resolve(trackID, controller.signal) };
    pendingResolve = entry;
  }

  try {
    await entry.promise;
  } catch (error) {
    if (pendingResolve === entry) pendingResolve = null;
    if (seq !== loadSeq || isAbort(error)) return;
    setLoading(false);
    updatePlayUI();
    if (desiredPlaying) {
      showToast(error?.message || 'Could not load this track. Try another one.', 'error', 6000);
    }
    return;
  }

  if (pendingResolve === entry) pendingResolve = null;
  if (seq !== loadSeq) return;
  if (state.current?.id !== trackID) return;

  loadedID = trackID;
  historyID = null;
  audio.src = `/api/stream?id=${encodeURIComponent(trackID)}`;
  audio.load();

  if (desiredPlaying) {
    startAudio(seq);
  } else {
    setLoading(false);
    updatePlayUI();
  }
}

export function playContext(tracks, startIndex = 0) {
  if (!Array.isArray(tracks) || !tracks.length) return;
  setQueue(tracks, startIndex);
  activate(true);
}

export function playQueueIndex(index) {
  if (index < 0 || index >= state.queue.length) return;
  const track = state.queue[index];
  if (state.current?.id === track.id && loadedID === track.id) {
    toggle();
    return;
  }
  setIndex(index);
  activate(true);
}

export function currentTrack() {
  return state.current;
}

export function toggle(force) {
  if (!state.current) {
    showToast('Choose a track to start listening.', 'info');
    return;
  }
  const shouldPlay = typeof force === 'boolean' ? force : audio.paused || audio.ended;
  if (shouldPlay) {
    if (loadedID !== state.current.id) {
      activate(true);
      return;
    }
    desiredPlaying = true;
    startAudio(loadSeq);
  } else {
    desiredPlaying = false;
    audio.pause();
  }
}

export function next({ auto = false } = {}) {
  if (!state.queue.length) return;
  const nextIndex = state.index + 1;
  if (nextIndex < state.queue.length) {
    playQueueIndex(nextIndex);
  } else if (!auto && state.queue.length > 1) {
    playQueueIndex(0);
  } else if (auto) {
    updatePlayUI();
    showToast('You reached the end of the queue.', 'info');
  }
}

export function previous() {
  if (!state.current) return;
  if (audio.currentTime > 3) {
    try { audio.currentTime = 0; } catch { /* ignore */ }
    updateProgress();
    return;
  }
  if (state.index > 0) {
    playQueueIndex(state.index - 1);
  } else {
    try { audio.currentTime = 0; } catch { /* ignore */ }
    updateProgress();
  }
}

export function seekBy(seconds) {
  if (!state.current) return;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (state.current.duration || 0);
  if (!duration) return;
  try {
    audio.currentTime = Math.min(duration - 0.15, Math.max(0, audio.currentTime + seconds));
    updateProgress();
  } catch {
    // ignore
  }
}

export function setVolumePercent(percent) {
  state.volume = Math.min(1, Math.max(0, percent / 100));
  if (state.volume > 0) state.muted = false;
  audio.volume = state.volume;
  audio.muted = state.muted;
  updateVolumeUI();
  setVolume(state.volume, state.muted);
}

export function toggleMute() {
  audio.muted = !audio.muted;
  state.muted = audio.muted;
  updateVolumeUI();
  setVolume(state.volume, state.muted);
  showToast(audio.muted ? 'Muted' : 'Sound on', 'info', 1600);
}

export function removeQueueAt(index) {
  const shouldResume = desiredPlaying || !audio.paused;
  const result = removeAt(index);
  if (!result.removed) return;
  if (result.wasCurrent) {
    if (result.current) {
      activate(shouldResume);
    } else {
      stopPlayback();
    }
  }
  emit('queue');
}

function cancelPending() {
  loadSeq += 1;
  desiredPlaying = false;
  if (pendingResolve) {
    pendingResolve.controller.abort();
    pendingResolve = null;
  }
}

export function clearQueueAndStop() {
  cancelPending();
  audio.pause();
  loadedID = null;
  historyID = null;
  audio.removeAttribute('src');
  audio.load();
  clearQueue();
  resetUI();
  emit('queue');
}

export function moveQueueItem(from, to) {
  move(from, to);
}

function resetUI() {
  renderTrack(null);
  setLoading(false);
  updatePlayUI();
  updateProgress();
}

function stopPlayback() {
  cancelPending();
  audio.pause();
  loadedID = null;
  historyID = null;
  audio.removeAttribute('src');
  audio.load();
  resetUI();
  emit('player', { playing: false });
}

export function updateLikeUI(saved) {
  refs.like.classList.toggle('is-active', saved);
  refs.like.setAttribute('aria-pressed', saved ? 'true' : 'false');
  refs.like.innerHTML = icon(saved ? 'heart-fill' : 'heart');
}

export function refreshPlayerTrack() {
  renderTrack(state.current);
}

export function isAudioPlaying() {
  return !audio.paused;
}
