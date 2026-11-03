import { api, isAbort } from './api.js';
import {
  state, subscribe,
  toggleSaved, isSaved, enqueue,
  getPlaylist, addToPlaylist, createPlaylist, deletePlaylist, removeFromPlaylist,
} from './store.js';
import {
  playContext, playQueueIndex, removeQueueAt, clearQueueAndStop, moveQueueItem,
  updateLikeUI, toggle as togglePlayback,
} from './player.js';
import {
  icon, escapeHTML, formatDuration, artHTML,
  initials, greeting, todayLabel, debounce,
} from './util.js';
import { showToast } from './toast.js';

const view = document.getElementById('view');
const pageTitle = document.getElementById('page-title');
const pageEyebrow = document.getElementById('page-eyebrow');
const drawer = document.getElementById('queue-drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');
const drawerBody = document.getElementById('queue-drawer-body');
let drawerOpen = false;
const modalRoot = document.getElementById('modal-root');

const POPULAR_QUERIES = [
  'lofi hip hop', 'indie pop', 'acoustic covers', 'jazz café',
  'chill r&b', 'anime openings', 'daft punk', 'evening piano',
];

let route = { name: 'home', query: '' };
let renderToken = 0;
let discover = { data: null, error: null, promise: null, at: 0 };
let search = { query: '', loading: false, error: null, results: [], controller: null, requestId: 0 };
let searchCache = new Map();
let libraryTab = 'songs';
let openPlaylistId = null;
let dragIndex = null;
let modalTrack = null;
let modalReturnFocus = null;
let modalResolve = null;
let modalSeq = 0;

/* ---------------------------------------------------------
   Stream prefetch
   --------------------------------------------------------- */

const warmedTracks = new Set();
const warmControllers = new Map();
const MAX_WARMED = 32;

// Warm the backend source cache so pressing play attaches the audio element to
// a ready stream instead of waiting on cold yt-dlp extraction. Only one
// background resolve runs at a time so playback is never starved.
function warmTrack(id) {
  if (!id || warmedTracks.has(id) || warmControllers.size >= 1) return;
  warmedTracks.add(id);
  if (warmedTracks.size > MAX_WARMED) {
    const oldest = warmedTracks.values().next().value;
    warmedTracks.delete(oldest);
  }
  const controller = new AbortController();
  warmControllers.set(id, controller);
  api.resolve(id, controller.signal)
    .catch(() => { warmedTracks.delete(id); })
    .finally(() => {
      if (warmControllers.get(id) === controller) warmControllers.delete(id);
    });
}

function abortPrefetch(exceptID) {
  for (const [id, controller] of warmControllers) {
    if (id === exceptID) continue;
    controller.abort();
    warmControllers.delete(id);
    warmedTracks.delete(id);
  }
}

const MAX_SEARCH_CACHE = 40;

function cacheSearch(key, results) {
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > MAX_SEARCH_CACHE) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

/* ---------------------------------------------------------
   Render helpers
   --------------------------------------------------------- */

function trackRowHTML(track, ctx, index) {
  const id = escapeHTML(track.id);
  const current = state.current?.id === track.id;
  const saved = isSaved(track.id);
  const title = escapeHTML(track.title);
  const channel = escapeHTML(track.channel || 'Unknown artist');
  const ctxAttr = escapeHTML(ctx);
  return `
    <article class="track-row${current ? ' is-current' : ''}" data-track-id="${id}">
      <div class="track-index" aria-hidden="true">
        <span class="num">${index + 1}</span>
        <span class="equalizer"><span></span><span></span><span></span></span>
      </div>
      <button class="row-play" type="button" data-action="play-track"
        data-track-id="${id}" data-ctx="${ctxAttr}" data-index="${index}"
        aria-label="Play ${title}">
        ${artHTML(track)}
        <span class="play-overlay" aria-hidden="true">${icon('play')}</span>
      </button>
      <div class="track-main">
        <span class="track-title" title="${title}">${title}</span>
        <span class="track-sub">
          <span class="track-artist" title="${channel}">${channel}</span>
          <span class="track-id" title="YouTube video ID">${id}</span>
        </span>
      </div>
      <span class="track-duration">${formatDuration(track.duration)}</span>
      <div class="track-actions">
        <button class="icon-btn${saved ? ' is-active' : ''}" type="button" data-action="save-track"
          data-track-id="${id}" aria-label="${saved ? 'Remove from library' : 'Save to library'}"
          aria-pressed="${saved ? 'true' : 'false'}" title="${saved ? 'Remove from library' : 'Save to library'}">
          ${icon(saved ? 'heart-fill' : 'heart')}
        </button>
        <button class="icon-btn" type="button" data-action="add-queue" data-track-id="${id}"
          aria-label="Add to queue" title="Add to queue">${icon('list-plus')}</button>
        <button class="icon-btn" type="button" data-action="track-menu" data-track-id="${id}"
          aria-label="More options" title="More options">${icon('more')}</button>
      </div>
    </article>`;
}

function trackListHTML(tracks, ctx) {
  return `<div class="track-list">${tracks.map((track, i) => trackRowHTML(track, ctx, i)).join('')}</div>`;
}

function featureCardHTML(track, index) {
  const id = escapeHTML(track.id);
  const title = escapeHTML(track.title);
  const channel = escapeHTML(track.channel || 'Unknown artist');
  return `
    <button class="feature-card" type="button" data-action="play-track"
      data-track-id="${id}" data-ctx="discover:0" data-index="${index}"
      aria-label="Play ${title}">
      ${artHTML(track, 'feature-art')}
      <span class="feature-badge">Featured</span>
      <span class="feature-play" aria-hidden="true">${icon('play')}</span>
      <span class="feature-title">${title}</span>
      <span class="feature-meta"><span>${channel}</span><span class="dot-sep">·</span><span>${formatDuration(track.duration)}</span></span>
    </button>`;
}

function historyCardHTML(track, index) {
  const id = escapeHTML(track.id);
  const title = escapeHTML(track.title);
  return `
    <button class="history-card" type="button" data-action="play-track"
      data-track-id="${id}" data-ctx="history" data-index="${index}" aria-label="Play ${title}">
      ${artHTML(track, 'history-art')}
      <span class="history-text"><strong>${title}</strong><span>${escapeHTML(track.channel || '')}</span></span>
    </button>`;
}

function emptyStateHTML({ iconName = 'music', title, text, action, actionLabel, actionIcon }) {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon(iconName)}</div>
      <h3>${escapeHTML(title)}</h3>
      <p>${escapeHTML(text)}</p>
      ${action ? `<button class="btn btn-primary btn-small" type="button" data-action="${action}">${actionIcon ? icon(actionIcon) : ''}${escapeHTML(actionLabel)}</button>` : ''}
    </div>`;
}

function skeletonRows(count = 7) {
  return `<div class="track-list">${Array.from({ length: count }, () => '<div class="skeleton skeleton-row"></div>').join('')}</div>`;
}

function skeletonCards(count = 4) {
  return `<div class="rail">${Array.from({ length: count }, () => '<div class="skeleton skeleton-card"></div>').join('')}</div>`;
}

/* ---------------------------------------------------------
   Home
   --------------------------------------------------------- */

function heroHTML() {
  const queryChips = POPULAR_QUERIES.map((q) => `
    <button class="chip" type="button" data-action="search-query" data-query="${escapeHTML(q)}">${escapeHTML(q)}</button>`).join('');

  return `
    <section class="hero glass">
      <div class="hero-copy">
        <span class="pill"><span class="dot"></span> Live search via yt-dlp</span>
        <h2 class="hero-title">${greeting()},<br><span class="grad-text">what sounds good?</span></h2>
        <p class="hero-sub">${todayLabel()} · Stream millions of tracks instantly. Audio is resolved on demand, never downloaded to disk.</p>
        <form class="hero-search" data-form="hero-search" role="search">
          <svg class="ico" aria-hidden="true"><use href="#i-search"/></svg>
          <input id="hero-search-input" name="q" type="search" placeholder="Search a song, artist or mood…" maxlength="120" autocomplete="off" aria-label="Search for music">
          <button class="btn btn-primary" type="submit">Search</button>
        </form>
        <div class="hero-chips" aria-label="Popular searches">
          <span class="eyebrow" style="align-self:center;margin-right:2px">Popular</span>
          ${queryChips}
        </div>
      </div>
      <div class="hero-art" aria-hidden="true">
        <div class="eq"><span></span><span></span><span></span><span></span></div>
        <div class="orb orb-a"></div>
        <div class="orb orb-b"></div>
        <div class="vinyl"><div class="vinyl-label">${icon('music')}</div></div>
      </div>
    </section>`;
}

function recentHTML() {
  const items = state.history.slice(0, 10);
  return `
    <section class="section-block" id="recent-section">
      <div class="section-head">
        <div>
          <span class="section-kicker">${icon('clock')} Recently played</span>
          <h2 class="section-title">Pick up where you left off</h2>
        </div>
        ${items.length ? `<div class="section-actions"><button class="text-btn" type="button" data-action="play-history">Play all</button></div>` : ''}
      </div>
      ${items.length
        ? `<div class="history-rail">${items.map(historyCardHTML).join('')}</div>`
        : `<div class="empty-state">
            <div class="empty-icon">${icon('music')}</div>
            <h3>No listening history yet</h3>
            <p>Play a track and it will show up here for a quick return.</p>
            <button class="btn btn-primary btn-small" type="button" data-action="focus-search">${icon('search')} Find music</button>
          </div>`}
    </section>`;
}

function discoverSkeletonHTML() {
  return `
    <section class="section-block">
      <div class="section-head"><div><span class="section-kicker">${icon('sparkles')} Featured music</span><h2 class="section-title">Loading today's picks…</h2></div></div>
      ${skeletonCards(4)}
    </section>
    <section class="section-block">
      <div class="section-head"><div><span class="section-kicker">${icon('wave')} Recommended</span><h2 class="section-title">Tuning the engine…</h2></div></div>
      ${skeletonRows(4)}
    </section>`;
}

function discoverSectionsHTML(sections) {
  if (!sections.length) {
    return emptyStateHTML({
      iconName: 'refresh', title: 'No picks right now',
      text: 'The music engine returned no results. Try searching for something specific.',
      action: 'focus-search', actionLabel: 'Search music', actionIcon: 'search',
    });
  }

  const first = sections[0];
  const featured = `
    <section class="section-block">
      <div class="section-head">
        <div>
          <span class="section-kicker">${icon('sparkles')} Featured music</span>
          <h2 class="section-title">${escapeHTML(first.title)}</h2>
          <p class="section-sub">${escapeHTML(first.subtitle)}</p>
        </div>
        <div class="section-actions">
          <button class="btn btn-ghost btn-small" type="button" data-action="play-section" data-section="0">${icon('play')} Play all</button>
        </div>
      </div>
      <div class="rail">${first.tracks.map((track, i) => featureCardHTML(track, i)).join('')}</div>
    </section>`;

  const rest = sections.slice(1).map((section, offset) => {
    const sectionIndex = offset + 1;
    return `
      <section class="section-block">
        <div class="section-head">
          <div>
            <span class="section-kicker">${icon(sectionIndex % 2 ? 'wave' : 'disc')} Recommended</span>
            <h2 class="section-title">${escapeHTML(section.title)}</h2>
            <p class="section-sub">${escapeHTML(section.subtitle)}</p>
          </div>
          <div class="section-actions">
            <button class="btn btn-ghost btn-small" type="button" data-action="play-section" data-section="${sectionIndex}">${icon('play')} Play all</button>
          </div>
        </div>
        <div class="list-panel glass">${trackListHTML(section.tracks, `discover:${sectionIndex}`)}</div>
      </section>`;
  }).join('');

  return featured + rest;
}

async function ensureDiscover(force = false) {
  if (discover.data && !force) return discover.data;
  if (discover.promise) return discover.promise;
  discover.promise = api.discover()
    .then((data) => {
      discover.data = data;
      discover.error = null;
      discover.at = Date.now();
      return data;
    })
    .catch((error) => {
      discover.error = error;
      throw error;
    })
    .finally(() => { discover.promise = null; });
  return discover.promise;
}

async function renderHome() {
  const token = ++renderToken;
  view.innerHTML = `
    ${heroHTML()}
    <div id="recent-slot">${recentHTML()}</div>
    <div id="discover-slot">${discoverSkeletonHTML()}</div>`;

  if (discover.data) {
    document.getElementById('discover-slot').innerHTML = discoverSectionsHTML(discover.data.sections || []);
    return;
  }

  try {
    const data = await ensureDiscover();
    if (token !== renderToken || route.name !== 'home') return;
    const slot = document.getElementById('discover-slot');
    if (slot) slot.innerHTML = discoverSectionsHTML(data.sections || []);
  } catch (error) {
    if (isAbort(error)) return;
    if (token !== renderToken || route.name !== 'home') return;
    const slot = document.getElementById('discover-slot');
    if (slot) {
      slot.innerHTML = emptyStateHTML({
        iconName: 'refresh',
        title: 'The music engine is quiet',
        text: error.message || 'Could not load recommendations. Check your connection and try again.',
        action: 'retry-discover',
        actionLabel: 'Try again',
        actionIcon: 'refresh',
      });
    }
  }
}

/* ---------------------------------------------------------
   Search
   --------------------------------------------------------- */

function searchViewHTML(query) {
  return `
    <section class="search-panel glass">
      <span class="eyebrow">Search the catalogue</span>
      <h2 class="search-heading">Find your next favourite</h2>
      <form class="search-form" data-form="search" role="search">
        ${icon('search')}
        <input id="search-input" name="q" type="search" value="${escapeHTML(query)}" placeholder="Song title, artist or mood…" maxlength="120" autocomplete="off" aria-label="Search query">
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div class="search-hints">
        <span>Try</span>
        ${POPULAR_QUERIES.slice(0, 5).map((q) => `<button class="chip" type="button" data-action="search-query" data-query="${escapeHTML(q)}">${escapeHTML(q)}</button>`).join('')}
      </div>
    </section>
    <div id="search-results" class="search-results"></div>`;
}

function searchIdleHTML() {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon('search')}</div>
      <h3>Search anything</h3>
      <p>Type at least two characters to search YouTube through yt-dlp. Results include artwork, artist, duration and instant streaming.</p>
    </div>`;
}

function renderSearchResults() {
  const container = document.getElementById('search-results');
  if (!container || route.name !== 'search') return;

  if (search.loading) {
    container.innerHTML = `
      <div class="results-head"><h2>Searching…</h2><span>asking yt-dlp</span></div>
      <div class="list-panel glass">${skeletonRows(8)}</div>`;
    return;
  }

  if (search.error) {
    container.innerHTML = emptyStateHTML({
      iconName: 'refresh',
      title: 'Search failed',
      text: search.error.message || 'The music engine could not answer. Please try again.',
      action: 'retry-search', actionLabel: 'Try again', actionIcon: 'refresh',
    });
    return;
  }

  if (!search.query || search.query.length < 2) {
    container.innerHTML = searchIdleHTML();
    return;
  }

  if (!search.results.length) {
    container.innerHTML = emptyStateHTML({
      iconName: 'music',
      title: 'No tracks found',
      text: `Nothing matched “${search.query}”. Try a shorter title, the artist name, or a mood.`,
      action: 'focus-search', actionLabel: 'New search', actionIcon: 'search',
    });
    return;
  }

  container.innerHTML = `
    <div class="results-head">
      <h2>Results for “${escapeHTML(search.query)}”</h2>
      <span>${search.results.length} tracks · live from yt-dlp</span>
    </div>
    <div class="list-panel glass">${trackListHTML(search.results, 'search')}</div>`;
}

async function runSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  search.query = query;

  if (query.length < 2) {
    if (search.controller) search.controller.abort();
    search.loading = false;
    search.error = null;
    search.results = [];
    renderSearchResults();
    return;
  }

  const cached = searchCache.get(query.toLowerCase());
  if (cached && Date.now() - cached.at < 120000) {
    search.loading = false;
    search.error = null;
    search.results = cached.results;
    renderSearchResults();
    warmTrack(search.results[0]?.id);
    return;
  }

  if (search.controller) search.controller.abort();
  const controller = new AbortController();
  search.controller = controller;
  search.loading = true;
  search.error = null;
  search.results = [];
  const requestId = ++search.requestId;
  renderSearchResults();

  try {
    const data = await api.search(query, controller.signal);
    if (requestId !== search.requestId || route.name !== 'search') return;
    search.results = Array.isArray(data.tracks) ? data.tracks : [];
    search.loading = false;
    cacheSearch(query.toLowerCase(), search.results);
    renderSearchResults();
    warmTrack(search.results[0]?.id);
    warmTrack(search.results[1]?.id);
  } catch (error) {
    if (isAbort(error) || requestId !== search.requestId) return;
    if (route.name !== 'search') return;
    search.loading = false;
    search.error = error;
    renderSearchResults();
    showToast(error.message || 'Search failed.', 'error');
  }
}

/* ---------------------------------------------------------
   Library
   --------------------------------------------------------- */

function librarySongsHTML() {
  if (!state.library.length) {
    return emptyStateHTML({
      iconName: 'heart',
      title: 'Your library is waiting',
      text: 'Tap the heart on any track to keep it here. Saved songs are stored locally in your browser.',
      action: 'focus-search', actionLabel: 'Discover music', actionIcon: 'search',
    });
  }
  return `<div class="list-panel glass">${trackListHTML(state.library, 'library')}</div>`;
}

function playlistCardHTML(playlist) {
  const id = escapeHTML(playlist.id);
  return `
    <article class="playlist-card" data-playlist-card="${id}">
      <div class="playlist-cover" role="button" tabindex="0" data-action="open-playlist" data-id="${id}"
        aria-label="Open playlist ${escapeHTML(playlist.name)}">
        <span class="cover-initials">${escapeHTML(initials(playlist.name))}</span>
        <button class="cover-play" type="button" data-action="play-playlist" data-id="${id}"
          aria-label="Play playlist ${escapeHTML(playlist.name)}">${icon('play')}</button>
      </div>
      <div>
        <div class="playlist-name">${escapeHTML(playlist.name)}</div>
        <div class="playlist-meta">${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'track' : 'tracks'}</div>
      </div>
      <div class="playlist-actions">
        <button class="icon-btn" type="button" data-action="delete-playlist" data-id="${id}"
          aria-label="Delete playlist ${escapeHTML(playlist.name)}" title="Delete playlist">${icon('trash')}</button>
      </div>
    </article>`;
}

function libraryPlaylistsHTML() {
  const cards = state.playlists.map(playlistCardHTML).join('');
  return `
    <div class="playlist-grid">
      ${cards}
      <button class="playlist-card" type="button" data-action="create-playlist" aria-label="Create a playlist">
        <div class="playlist-cover" style="background:linear-gradient(135deg, rgba(255,255,255,.5), rgba(255,255,255,.18)); color:var(--violet); border:1px dashed rgba(152,120,245,.45); box-shadow:none;">
          ${icon('plus')}
        </div>
        <div>
          <div class="playlist-name">New playlist</div>
          <div class="playlist-meta">Group your favourite tracks</div>
        </div>
      </button>
    </div>`;
}

function playlistDetailHTML(playlist) {
  return `
    <div class="playlist-detail-head glass">
      <div class="playlist-detail-cover">${escapeHTML(initials(playlist.name))}</div>
      <div class="playlist-detail-info">
        <span class="eyebrow">Playlist</span>
        <h2>${escapeHTML(playlist.name)}</h2>
        <p>${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'track' : 'tracks'} · saved locally</p>
      </div>
      <div class="playlist-detail-actions">
        <button class="btn btn-primary btn-small" type="button" data-action="play-playlist" data-id="${escapeHTML(playlist.id)}" ${playlist.tracks.length ? '' : 'disabled'}>${icon('play')} Play all</button>
        <button class="btn btn-ghost btn-small" type="button" data-action="back-library">${icon('chevron-left')} Back</button>
      </div>
    </div>
    ${playlist.tracks.length
      ? `<div class="list-panel glass">${playlist.tracks.map((track, i) => `
          <article class="track-row${state.current?.id === track.id ? ' is-current' : ''}" data-track-id="${escapeHTML(track.id)}">
            <div class="track-index" aria-hidden="true"><span class="num">${i + 1}</span><span class="equalizer"><span></span><span></span><span></span></span></div>
            <button class="row-play" type="button" data-action="play-track" data-track-id="${escapeHTML(track.id)}"
              data-ctx="playlist:${escapeHTML(playlist.id)}" data-index="${i}" aria-label="Play ${escapeHTML(track.title)}">
              ${artHTML(track)}<span class="play-overlay" aria-hidden="true">${icon('play')}</span>
            </button>
            <div class="track-main">
              <span class="track-title">${escapeHTML(track.title)}</span>
              <span class="track-sub">${escapeHTML(track.channel || '')}</span>
            </div>
            <span class="track-duration">${formatDuration(track.duration)}</span>
            <div class="track-actions">
              <button class="icon-btn" type="button" data-action="playlist-remove" data-playlist="${escapeHTML(playlist.id)}"
                data-track-id="${escapeHTML(track.id)}" aria-label="Remove from playlist" title="Remove from playlist">${icon('x')}</button>
              <button class="icon-btn" type="button" data-action="track-menu" data-track-id="${escapeHTML(track.id)}"
                aria-label="More options" title="More options">${icon('more')}</button>
            </div>
          </article>`).join('')}</div>`
      : emptyStateHTML({
          iconName: 'list-plus', title: 'This playlist is empty',
          text: 'Use the three-dot menu on any track and choose “Add to playlist”.',
          action: 'focus-search', actionLabel: 'Find tracks', actionIcon: 'search',
        })}`;
}

function libraryRecentHTML() {
  if (!state.history.length) return '';
  return `
    <section class="section-block">
      <div class="section-head">
        <div>
          <span class="section-kicker">${icon('clock')} Recently played</span>
          <h2 class="section-title">Back to your rotation</h2>
        </div>
        <div class="section-actions">
          <button class="text-btn" type="button" data-action="play-history">Play all</button>
        </div>
      </div>
      <div class="history-rail">${state.history.slice(0, 8).map(historyCardHTML).join('')}</div>
    </section>`;
}

function renderLibrary() {
  const playlist = openPlaylistId ? getPlaylist(openPlaylistId) : null;
  if (openPlaylistId && !playlist) openPlaylistId = null;

  const head = `
    <div class="library-head">
      <div>
        <span class="eyebrow">Collection</span>
        <h2 class="library-title">Your library</h2>
        <p class="section-sub">${state.library.length} saved ${state.library.length === 1 ? 'track' : 'tracks'} · ${state.playlists.length} ${state.playlists.length === 1 ? 'playlist' : 'playlists'}</p>
      </div>
      <div class="section-actions">
        <div class="tabs" role="tablist" aria-label="Library sections">
          <button class="tab${libraryTab === 'songs' ? ' active' : ''}" type="button" role="tab" aria-selected="${libraryTab === 'songs'}" data-action="library-tab" data-tab="songs">Songs</button>
          <button class="tab${libraryTab === 'playlists' ? ' active' : ''}" type="button" role="tab" aria-selected="${libraryTab === 'playlists'}" data-action="library-tab" data-tab="playlists">Playlists</button>
        </div>
        <button class="btn btn-primary btn-small" type="button" data-action="create-playlist">${icon('plus')} Playlist</button>
      </div>
    </div>`;

  const body = playlist
    ? playlistDetailHTML(playlist)
    : `${libraryRecentHTML()}${libraryTab === 'songs' ? librarySongsHTML() : libraryPlaylistsHTML()}`;

  view.innerHTML = head + body;
}

/* ---------------------------------------------------------
   Queue
   --------------------------------------------------------- */

function queueItemHTML(track, index, { compact = false } = {}) {
  const id = escapeHTML(track.id);
  const current = state.current?.id === track.id;
  return `
    <div class="queue-item${current ? ' is-current' : ''}" data-index="${index}" data-track-id="${id}" draggable="true">
      <button class="drag-handle" type="button" aria-label="Reorder ${escapeHTML(track.title)}" tabindex="-1">${icon('grip')}</button>
      <button class="row-play" type="button" data-action="queue-play" data-index="${index}" aria-label="Play ${escapeHTML(track.title)}">
        ${artHTML(track, 'queue-art')}
        <span class="play-overlay" aria-hidden="true">${icon(current && state.playing ? 'pause' : 'play')}</span>
      </button>
      <div class="queue-main">
        <span class="queue-title">${escapeHTML(track.title)}</span>
        <span class="queue-sub">${escapeHTML(track.channel || '')}${current ? ' · now playing' : ''}</span>
      </div>
      <span class="queue-dur">${formatDuration(track.duration)}</span>
      <div class="queue-actions">
        ${compact ? '' : `
          <button class="icon-btn" type="button" data-action="queue-up" data-index="${index}" aria-label="Move up" title="Move up">${icon('arrow-up')}</button>
          <button class="icon-btn" type="button" data-action="queue-down" data-index="${index}" aria-label="Move down" title="Move down">${icon('arrow-down')}</button>`}
        <button class="icon-btn" type="button" data-action="queue-remove" data-index="${index}" aria-label="Remove from queue" title="Remove">${icon('x')}</button>
      </div>
    </div>`;
}

function queueListHTML({ compact = false } = {}) {
  if (!state.queue.length) {
    return `<div class="drawer-empty">The queue is empty.<br>Add tracks from search or your library.</div>`;
  }
  return `<div class="queue-list" data-queue-list>${state.queue.map((track, i) => queueItemHTML(track, i, { compact })).join('')}</div>`;
}

function renderQueueView() {
  const count = state.queue.length;
  view.innerHTML = `
    <section class="queue-panel glass">
      <div class="queue-toolbar">
        <div>
          <span class="eyebrow">Up next</span>
          <h2 class="library-title">Your queue</h2>
          <span class="queue-count">${count} ${count === 1 ? 'track' : 'tracks'}${state.current ? ` · playing “${escapeHTML(state.current.title)}”` : ''}</span>
        </div>
        <div class="section-actions">
          ${count ? `<button class="btn btn-primary btn-small" type="button" data-action="queue-play-all">${icon('play')} ${state.playing ? 'Playing' : 'Play queue'}</button>
          <button class="btn btn-ghost btn-small" type="button" data-action="queue-clear">${icon('trash')} Clear</button>` : ''}
        </div>
      </div>
      <div id="queue-list">${queueListHTML()}</div>
      ${count ? `<p class="modal-note">Drag tracks or use the arrow buttons to reorder. Playback follows the highlighted track.</p>` : ''}
    </section>`;
}

function renderQueueDrawer() {
  if (drawerBody) {
    drawerBody.innerHTML = queueListHTML({ compact: true });
  }
}

function updateCounters() {
  const q = state.queue.length;
  const l = state.library.length;
  const navQueue = document.getElementById('nav-queue-count');
  const navLibrary = document.getElementById('nav-library-count');
  const badge = document.getElementById('queue-badge');
  if (navQueue) navQueue.textContent = String(q);
  if (navLibrary) navLibrary.textContent = String(l);
  if (badge) {
    badge.textContent = String(q);
    badge.hidden = q === 0;
  }
}

function syncCurrentRows() {
  const currentID = state.current?.id;
  view.querySelectorAll('[data-track-id]').forEach((el) => {
    el.classList.toggle('is-current', el.dataset.trackId === currentID);
  });
  if (drawerBody) {
    drawerBody.querySelectorAll('[data-track-id]').forEach((el) => {
      el.classList.toggle('is-current', el.dataset.trackId === currentID);
    });
  }
}

function updateLikeStates() {
  view.querySelectorAll('[data-action="save-track"]').forEach((btn) => {
    const saved = isSaved(btn.dataset.trackId);
    btn.classList.toggle('is-active', saved);
    btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
    btn.setAttribute('aria-label', saved ? 'Remove from library' : 'Save to library');
    btn.setAttribute('title', saved ? 'Remove from library' : 'Save to library');
    btn.innerHTML = icon(saved ? 'heart-fill' : 'heart');
  });
  updateLikeUI(Boolean(currentSaved()));
}

function currentSaved() {
  return state.current ? isSaved(state.current.id) : false;
}

export function openQueueDrawer() {
  renderQueueDrawer();
  drawerOpen = true;
  drawerBackdrop.hidden = false;
  // Flush the hidden state so the opening transition starts from the edge.
  void drawerBackdrop.offsetWidth;
  drawerBackdrop.classList.add('open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
}

export function closeQueueDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawer.classList.remove('open');
  drawerBackdrop.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('drawer-open');
  setTimeout(() => {
    if (!drawerOpen) drawerBackdrop.hidden = true;
  }, 320);
}

export function toggleQueueDrawer() {
  if (drawerOpen) closeQueueDrawer();
  else openQueueDrawer();
}

export function isQueueDrawerOpen() {
  return drawerOpen;
}

/* ---------------------------------------------------------
   Modals
   --------------------------------------------------------- */

function openModal(html) {
  modalSeq += 1;
  modalReturnFocus = document.activeElement;
  modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  modalRoot.hidden = false;
  requestAnimationFrame(() => modalRoot.classList.add('open'));
  setTimeout(() => {
    const target = modalRoot.querySelector('input, .modal-option, button');
    target?.focus();
  }, 80);
}

function resolveModal(result) {
  const resolver = modalResolve;
  modalResolve = null;
  if (resolver) resolver(result);
}

export function closeModal(result = false) {
  if (modalRoot.hidden) return;
  const seq = ++modalSeq;
  modalRoot.classList.remove('open');
  const finish = () => {
    if (seq !== modalSeq) return;
    if (modalRoot.classList.contains('open')) return;
    modalRoot.hidden = true;
    modalRoot.innerHTML = '';
  };
  setTimeout(finish, 240);
  modalTrack = null;
  resolveModal(result);
  if (modalReturnFocus?.focus) {
    try { modalReturnFocus.focus(); } catch { /* ignore */ }
  }
}

function closeModalHTML() {
  return `<button class="icon-btn modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('x')}</button>`;
}

function addToPlaylistModalHTML(track) {
  const playlists = state.playlists;
  const options = playlists.length
    ? playlists.map((playlist) => `
        <button class="modal-option" type="button" data-action="playlist-pick" data-playlist="${escapeHTML(playlist.id)}">
          <span class="mini-cover">${escapeHTML(initials(playlist.name))}</span>
          <span>${escapeHTML(playlist.name)}<small>${playlist.tracks.length} ${playlist.tracks.length === 1 ? 'track' : 'tracks'}</small></span>
        </button>`).join('')
    : `<p class="modal-empty">No playlists yet. Create one below.</p>`;

  return `
    <div class="modal-head">
      <div>
        <span class="eyebrow">Save to playlist</span>
        <h2>${escapeHTML(track.title)}</h2>
        <p>${escapeHTML(track.channel || 'Unknown artist')}</p>
      </div>
      ${closeModalHTML()}
    </div>
    <div class="modal-list">${options}</div>
    <form data-form="create-playlist-inline">
      <div class="field">
        <label for="new-playlist-name">Create a new playlist</label>
        <input id="new-playlist-name" name="name" type="text" maxlength="60" placeholder="Late night favourites" autocomplete="off" required>
      </div>
      <div class="modal-actions">
        <button class="btn btn-primary btn-small" type="submit">${icon('plus')} Create &amp; add</button>
      </div>
    </form>
    <p class="modal-note">Playlists live in your browser's local storage on this device.</p>`;
}

function showAddToPlaylist(track) {
  if (!track) return;
  modalTrack = track;
  openModal(addToPlaylistModalHTML(track));
}

function showCreatePlaylist() {
  openModal(`
    <div class="modal-head">
      <div>
        <span class="eyebrow">New playlist</span>
        <h2>Give it a name</h2>
        <p>Collect tracks for any mood.</p>
      </div>
      ${closeModalHTML()}
    </div>
    <form data-form="create-playlist">
      <div class="field">
        <label for="playlist-name">Playlist name</label>
        <input id="playlist-name" name="name" type="text" maxlength="60" placeholder="Sunday morning" autocomplete="off" required>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-small" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary btn-small" type="submit">${icon('plus')} Create playlist</button>
      </div>
    </form>`);
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    openModal(`
      <div class="modal-head">
        <div>
          <span class="eyebrow">Please confirm</span>
          <h2>${escapeHTML(title)}</h2>
        </div>
        ${closeModalHTML()}
      </div>
      <p class="modal-note">${escapeHTML(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-small" type="button" data-action="close-modal">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-small" type="button" data-action="confirm-ok">${escapeHTML(confirmLabel)}</button>
      </div>`);
  });
}

function showTrackMenu(track) {
  if (!track) return;
  const saved = isSaved(track.id);
  openModal(`
    <div class="modal-head">
      <div>
        <span class="eyebrow">Track options</span>
        <h2>${escapeHTML(track.title)}</h2>
        <p>${escapeHTML(track.channel || 'Unknown artist')} · ${formatDuration(track.duration)} · <span class="id-chip">${escapeHTML(track.id)}</span></p>
      </div>
      ${closeModalHTML()}
    </div>
    <div class="modal-list">
      <button class="modal-option" type="button" data-action="play-next" data-track-id="${escapeHTML(track.id)}">
        ${icon('next')}<span>Play next</span>
      </button>
      <button class="modal-option" type="button" data-action="open-add-playlist" data-track-id="${escapeHTML(track.id)}">
        ${icon('list-plus')}<span>Add to playlist</span>
      </button>
      <button class="modal-option" type="button" data-action="save-track" data-track-id="${escapeHTML(track.id)}">
        ${icon(saved ? 'heart-fill' : 'heart')}<span>${saved ? 'Remove from library' : 'Save to library'}</span>
      </button>
    </div>`);
}

/* ---------------------------------------------------------
   Track lookup / contexts
   --------------------------------------------------------- */

function discoverTracks(sectionIndex) {
  return discover.data?.sections?.[sectionIndex]?.tracks || [];
}

function contextTracks(ctx) {
  if (!ctx || typeof ctx !== 'string') return [];
  if (ctx === 'search') return search.results;
  if (ctx === 'library') return state.library;
  if (ctx === 'history') return state.history;
  if (ctx === 'queue') return state.queue;
  if (ctx.startsWith('discover:')) return discoverTracks(Number(ctx.split(':')[1]));
  if (ctx.startsWith('playlist:')) return getPlaylist(ctx.slice('playlist:'.length))?.tracks || [];
  return [];
}

function findTrack(id) {
  if (!id) return null;
  const direct = state.queue.find((t) => t.id === id)
    || state.library.find((t) => t.id === id)
    || state.history.find((t) => t.id === id)
    || search.results.find((t) => t.id === id);
  if (direct) return direct;
  for (const playlist of state.playlists) {
    const found = playlist.tracks.find((t) => t.id === id);
    if (found) return found;
  }
  for (const section of discover.data?.sections || []) {
    const found = section.tracks.find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

function handlePlayTrack(el) {
  const id = el.dataset.trackId;
  const ctx = el.dataset.ctx || '';
  const index = Number(el.dataset.index);

  if (state.current?.id === id) {
    togglePlayback();
    return;
  }

  if (ctx === 'queue') {
    playQueueIndex(index);
    return;
  }

  const tracks = contextTracks(ctx);
  if (tracks.length) {
    let start = tracks.findIndex((track) => track.id === id);
    if (start < 0) start = Math.min(Math.max(index, 0), tracks.length - 1);
    playContext(tracks, start);
    return;
  }

  const track = findTrack(id);
  if (track) playContext([track], 0);
}

function handleAddQueue(track) {
  if (!track) return;
  const result = enqueue(track);
  if (!result.added) {
    showToast(result.reason === 'duplicate' ? 'That track is already in the queue.' : 'Could not add that track.', 'info');
    return;
  }
  showToast('Added to queue', 'success', 2200);
}

function handleSaveTrack(track) {
  if (!track) return;
  const saved = toggleSaved(track);
  showToast(saved ? 'Saved to your library' : 'Removed from library', saved ? 'success' : 'info', 2200);
  updateLikeStates();
  if (route.name === 'library') renderLibrary();
}

/* ---------------------------------------------------------
   Events
   --------------------------------------------------------- */

async function onClick(event) {
  const nav = event.target.closest('[data-nav="library"]');
  if (nav) openPlaylistId = null;

  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const track = el.dataset.trackId ? findTrack(el.dataset.trackId) : null;
  const index = Number(el.dataset.index);

  switch (action) {
    case 'play-track':
      event.preventDefault();
      handlePlayTrack(el);
      break;
    case 'add-queue':
      handleAddQueue(track);
      break;
    case 'save-track':
      handleSaveTrack(track);
      break;
    case 'track-menu':
      showTrackMenu(track);
      break;
    case 'play-next':
      if (track) {
        const result = enqueue(track, { next: true });
        if (result.added) {
          showToast('Playing next', 'success', 2000);
          if (!state.current || state.current.id === track.id) playQueueIndex(result.index);
        } else {
          showToast('That track is already queued.', 'info');
        }
      }
      closeModal();
      break;
    case 'open-add-playlist':
      if (track) {
        closeModal();
        setTimeout(() => showAddToPlaylist(track), 120);
      }
      break;
    case 'playlist-pick': {
      const playlistID = el.dataset.playlist;
      if (!modalTrack) break;
      if (addToPlaylist(playlistID, modalTrack)) {
        const playlist = getPlaylist(playlistID);
        showToast(`Added to “${playlist?.name || 'playlist'}”`, 'success', 2400);
        closeModal();
      } else {
        showToast('That track is already in this playlist.', 'info');
      }
      break;
    }
    case 'create-playlist':
      showCreatePlaylist();
      break;
    case 'delete-playlist': {
      const playlist = getPlaylist(el.dataset.id);
      if (!playlist) break;
      const confirmed = await confirmDialog({
        title: `Delete “${playlist.name}”?`,
        message: 'This removes the playlist from this device. Your saved songs stay in the library.',
        confirmLabel: 'Delete playlist',
      });
      if (confirmed) {
        deletePlaylist(playlist.id);
        if (openPlaylistId === playlist.id) openPlaylistId = null;
        showToast('Playlist deleted', 'info', 2200);
        if (route.name === 'library') renderLibrary();
      }
      break;
    }
    case 'open-playlist':
      openPlaylistId = el.dataset.id;
      if (route.name === 'library') renderLibrary();
      break;
    case 'play-playlist': {
      event.stopPropagation();
      const playlist = getPlaylist(el.dataset.id);
      if (!playlist) break;
      if (!playlist.tracks.length) {
        showToast('This playlist is empty.', 'info');
        break;
      }
      playContext(playlist.tracks, 0);
      showToast(`Playing “${playlist.name}”`, 'success', 2200);
      break;
    }
    case 'back-library':
      openPlaylistId = null;
      renderLibrary();
      break;
    case 'library-tab':
      libraryTab = el.dataset.tab === 'playlists' ? 'playlists' : 'songs';
      openPlaylistId = null;
      renderLibrary();
      break;
    case 'playlist-remove':
      if (removeFromPlaylist(el.dataset.playlist, el.dataset.trackId)) {
        showToast('Removed from playlist', 'info', 2000);
        renderLibrary();
      }
      break;
    case 'queue-remove': {
      const wasCurrent = index === state.index;
      removeQueueAt(index);
      if (wasCurrent) showToast('Skipped to the next track', 'info', 2000);
      if (route.name === 'queue') renderQueueView();
      break;
    }
    case 'queue-up':
      if (index > 0) {
        moveQueueItem(index, index - 1);
        if (route.name === 'queue') renderQueueView();
      }
      break;
    case 'queue-down':
      if (index < state.queue.length - 1) {
        moveQueueItem(index, index + 1);
        if (route.name === 'queue') renderQueueView();
      }
      break;
    case 'queue-clear': {
      if (!state.queue.length) break;
      const confirmed = await confirmDialog({
        title: 'Clear the queue?',
        message: 'Playback will stop and every queued track will be removed. Your library is untouched.',
        confirmLabel: 'Clear queue',
      });
      if (confirmed) {
        clearQueueAndStop();
        showToast('Queue cleared', 'info', 2200);
        renderQueueView();
      }
      break;
    }
    case 'queue-play-all':
      if (!state.queue.length) break;
      if (state.playing) {
        showToast('Already playing', 'info', 1800);
      } else {
        playQueueIndex(state.index >= 0 ? state.index : 0);
      }
      break;
    case 'queue-play':
      playQueueIndex(index);
      break;
    case 'play-history':
      if (state.history.length) playContext(state.history, 0);
      break;
    case 'play-section':
      if (discover.data) {
        const section = discover.data.sections?.[Number(el.dataset.section)];
        if (section?.tracks?.length) playContext(section.tracks, 0);
      }
      break;
    case 'retry-discover':
      discover.data = null;
      discover.error = null;
      discover.promise = null;
      renderHome();
      break;
    case 'retry-search':
      searchCache.delete(search.query.toLowerCase());
      runSearch(search.query);
      break;
    case 'search-query': {
      const query = el.dataset.query || '';
      navigateToSearch(query);
      break;
    }
    case 'focus-search':
      if (route.name === 'search') {
        document.getElementById('search-input')?.focus();
      } else {
        location.hash = '#/search';
        setTimeout(() => document.getElementById('search-input')?.focus(), 120);
      }
      break;
    case 'toggle-queue':
      toggleQueueDrawer();
      break;
    case 'close-queue':
      closeQueueDrawer();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'confirm-ok':
      closeModal(true);
      break;
    default:
      break;
  }
}

function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const type = form.dataset.form;
  if (!type) return;
  event.preventDefault();

  if (type === 'quick-search') {
    const input = document.getElementById('quick-search-input');
    navigateToSearch(input?.value || '');
    return;
  }
  if (type === 'hero-search') {
    const input = document.getElementById('hero-search-input');
    navigateToSearch(input?.value || '');
    return;
  }
  if (type === 'search') {
    const input = document.getElementById('search-input');
    navigateToSearch(input?.value || '');
    return;
  }
  if (type === 'create-playlist') {
    const input = form.querySelector('input[name="name"]');
    const playlist = createPlaylist(input?.value || '');
    if (!playlist) {
      showToast('Enter a playlist name first.', 'error');
      return;
    }
    closeModal();
    showToast(`Playlist “${playlist.name}” created`, 'success', 2400);
    if (route.name === 'library') {
      libraryTab = 'playlists';
      openPlaylistId = null;
      renderLibrary();
    }
    return;
  }
  if (type === 'create-playlist-inline') {
    const input = form.querySelector('input[name="name"]');
    const playlist = createPlaylist(input?.value || '');
    if (!playlist) {
      showToast('Enter a playlist name first.', 'error');
      return;
    }
    if (modalTrack) addToPlaylist(playlist.id, modalTrack);
    closeModal();
    showToast(`Added to “${playlist.name}”`, 'success', 2400);
    if (route.name === 'library') {
      libraryTab = 'playlists';
      openPlaylistId = null;
      renderLibrary();
    }
  }
}

const scheduleSearch = debounce((raw) => {
  if (route.name !== 'search') return;
  const query = String(raw || '').trim();
  const target = `#/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  history.replaceState(null, '', target);
  runSearch(query);
}, 520);

function onInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.id === 'search-input') {
    scheduleSearch(target.value);
  }
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    if (!modalRoot.hidden) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (drawerOpen) {
      event.preventDefault();
      closeQueueDrawer();
    }
    return;
  }

  if (event.key === 'Tab' && !modalRoot.hidden) {
    const focusables = [...modalRoot.querySelectorAll('button, input, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function onImageError(event) {
  const target = event.target;
  if (target instanceof HTMLImageElement && target.classList.contains('art-img')) {
    target.classList.add('broken');
  }
}

function navigateToSearch(rawQuery) {
  const query = String(rawQuery || '').trim().slice(0, 120);
  const target = `#/search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  if (location.hash === target) {
    if (route.name !== 'search') location.hash = target;
    else runSearch(query);
    return;
  }
  location.hash = target;
}

/* ---------------------------------------------------------
   Routing
   --------------------------------------------------------- */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const name = ['home', 'search', 'library', 'queue'].includes(pathPart) ? pathPart : 'home';
  const params = new URLSearchParams(queryPart);
  return { name, query: params.get('q') || '' };
}

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('active', link.dataset.nav === name);
    if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

const PAGE_META = {
  home: { title: 'Home', eyebrow: 'Your listening space' },
  search: { title: 'Search', eyebrow: 'Find anything' },
  library: { title: 'Library', eyebrow: 'Saved & curated' },
  queue: { title: 'Queue', eyebrow: 'Up next' },
};

function renderRoute() {
  route = parseRoute();
  renderToken += 1;
  if (search.controller) {
    search.controller.abort();
    search.controller = null;
  }
  if (!modalRoot.hidden) closeModal();
  closeQueueDrawer();

  const meta = PAGE_META[route.name];
  pageTitle.textContent = meta.title;
  pageEyebrow.textContent = meta.eyebrow;
  setActiveNav(route.name);
  updateCounters();

  view.classList.remove('view-in');
  void view.offsetWidth;
  view.classList.add('view-in');
  window.scrollTo({ top: 0, behavior: 'auto' });

  if (route.name === 'home') {
    renderHome();
    return;
  }
  if (route.name === 'search') {
    view.innerHTML = searchViewHTML(route.query);
    search.query = route.query;
    if (route.query.trim().length >= 2) {
      runSearch(route.query);
    } else {
      search.loading = false;
      search.error = null;
      search.results = [];
      renderSearchResults();
    }
    return;
  }
  if (route.name === 'library') {
    renderLibrary();
    return;
  }
  renderQueueView();
}

/* ---------------------------------------------------------
   Public init
   --------------------------------------------------------- */

export function initUI() {
  document.addEventListener('click', (event) => {
    onClick(event).catch((error) => {
      console.error(error);
      showToast('Something went wrong. Please try again.', 'error');
    });
  });
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('error', onImageError, true);

  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ')
      && event.target instanceof HTMLElement
      && event.target.matches('[role="button"][data-action]')) {
      event.preventDefault();
      event.target.click();
    }
  });

  window.addEventListener('aichan:resolve-start', (event) => {
    abortPrefetch(event.detail?.id);
  });

  document.addEventListener('pointerover', (event) => {
    const el = event.target.closest?.('[data-action="play-track"]');
    if (el?.dataset.trackId) warmTrack(el.dataset.trackId);
  });
  document.addEventListener('focusin', (event) => {
    const el = event.target.closest?.('[data-action="play-track"]');
    if (el?.dataset.trackId) warmTrack(el.dataset.trackId);
  });

  drawerBackdrop.addEventListener('click', closeQueueDrawer);
  modalRoot.addEventListener('click', (event) => {
    if (event.target === modalRoot) closeModal();
  });

  // Drag to reorder queue items.
  document.addEventListener('dragstart', (event) => {
    const item = event.target.closest?.('.queue-item');
    if (!item) return;
    dragIndex = Number(item.dataset.index);
    item.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragIndex));
    }
  });
  document.addEventListener('dragend', () => {
    dragIndex = null;
    document.querySelectorAll('.queue-item.dragging, .queue-item.drag-over')
      .forEach((el) => el.classList.remove('dragging', 'drag-over'));
  });
  document.addEventListener('dragover', (event) => {
    const item = event.target.closest?.('.queue-item');
    if (!item || dragIndex === null) return;
    event.preventDefault();
    document.querySelectorAll('.queue-item.drag-over').forEach((el) => el.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });
  document.addEventListener('drop', (event) => {
    const item = event.target.closest?.('.queue-item');
    if (!item || dragIndex === null) return;
    event.preventDefault();
    const targetIndex = Number(item.dataset.index);
    item.classList.remove('drag-over');
    if (Number.isInteger(dragIndex) && Number.isInteger(targetIndex) && dragIndex !== targetIndex) {
      moveQueueItem(dragIndex, targetIndex);
      if (route.name === 'queue') renderQueueView();
    }
    dragIndex = null;
  });

  subscribe((type, detail) => {
    if (type === 'queue') {
      updateCounters();
      syncCurrentRows();
      renderQueueDrawer();
      if (route.name === 'queue') {
        const list = document.getElementById('queue-list');
        const countText = view.querySelector('.queue-count');
        if (list) list.innerHTML = queueListHTML();
        if (countText) {
          const count = state.queue.length;
          countText.textContent = `${count} ${count === 1 ? 'track' : 'tracks'}${state.current ? ` · playing “${state.current.title}”` : ''}`;
        }
      }
    }
    if (type === 'library') {
      updateCounters();
      updateLikeStates();
      if (route.name === 'library') renderLibrary();
    }
    if (type === 'playlists') {
      if (route.name === 'library') renderLibrary();
    }
    if (type === 'history') {
      const slot = document.getElementById('recent-slot');
      if (route.name === 'home' && slot) slot.innerHTML = recentHTML();
      else if (route.name === 'library' && !openPlaylistId) renderLibrary();
    }
    if (type === 'track' || type === 'player') {
      syncCurrentRows();
      updateLikeStates();
      renderQueueDrawer();
    }
    if (type === 'request-like') {
      if (detail.track) handleSaveTrack(detail.track);
    }
  });

  window.addEventListener('hashchange', renderRoute);
  updateCounters();
  updateLikeStates();
  renderRoute();
}

export async function initHealth() {
  const dot = document.getElementById('engine-dot');
  const label = document.getElementById('engine-label');
  try {
    const health = await api.health();
    const ready = Boolean(health.ytdlp?.available);
    dot?.classList.toggle('offline', !ready);
    if (label) {
      label.textContent = ready
        ? `yt-dlp ${health.ytdlp.version || ''} · ready`.replace('  ', ' ')
        : 'Music engine unavailable';
    }
  } catch {
    dot?.classList.add('offline');
    if (label) label.textContent = 'Engine unreachable';
  }
}
