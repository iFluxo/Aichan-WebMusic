export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

export function icon(name, cls = 'ico') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? formatTime(seconds) : '—';
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait = 400) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();
}

export function thumbURL(track) {
  if (track?.thumbnail) return track.thumbnail;
  if (track?.id) return `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
  return '';
}

export function artHTML(track, className = '') {
  const url = thumbURL(track);
  if (!url) return '';
  return `<img class="art-img ${className}" src="${escapeHTML(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

export function normalizeTrack(raw) {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    title: String(raw.title || 'Unknown track'),
    channel: String(raw.channel || 'Unknown artist'),
    duration: Number.isFinite(raw.duration) ? raw.duration : 0,
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : '',
  };
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function todayLabel() {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
}
