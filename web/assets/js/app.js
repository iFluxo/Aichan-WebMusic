import { hydrate, state } from './store.js';
import { initPlayer, toggle, next, previous, seekBy, setVolumePercent, toggleMute } from './player.js';
import { initUI, initHealth, toggleQueueDrawer, closeModal } from './ui.js';
import { showToast } from './toast.js';

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    return !['range', 'checkbox', 'radio', 'button', 'submit'].includes(type);
  }
  return false;
}

function focusSearch() {
  if (location.hash.startsWith('#/search')) {
    document.getElementById('search-input')?.focus();
    return;
  }
  location.hash = '#/search';
  setTimeout(() => document.getElementById('search-input')?.focus(), 140);
}

function initKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'Escape') return; // handled by the UI module

    if (isTypingTarget(event.target)) return;
    if (!document.getElementById('modal-root')?.hidden) return;

    switch (event.key) {
      case ' ':
        // Let the browser activate focused buttons/links natively.
        if (event.target instanceof HTMLElement
          && event.target.closest('button, a[href], [role="button"]')) break;
        event.preventDefault();
        toggle();
        break;
      case 'k':
      case 'K':
        event.preventDefault();
        toggle();
        break;
      case 'ArrowRight':
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        seekBy(5);
        break;
      case 'ArrowLeft':
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        seekBy(-5);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setVolumePercent(Math.round(state.volume * 100) + 5);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setVolumePercent(Math.round(state.volume * 100) - 5);
        break;
      case 'm':
      case 'M':
        event.preventDefault();
        toggleMute();
        break;
      case 'n':
      case 'N':
        event.preventDefault();
        next();
        break;
      case 'p':
      case 'P':
        event.preventDefault();
        previous();
        break;
      case 'q':
      case 'Q':
        event.preventDefault();
        toggleQueueDrawer();
        break;
      case '/':
        event.preventDefault();
        focusSearch();
        break;
      default:
        break;
    }
  });
}

function initConnectivity() {
  window.addEventListener('offline', () => showToast('You are offline. Streaming will pause.', 'error', 5000));
  window.addEventListener('online', () => showToast('Back online', 'success', 2400));
}

function boot() {
  hydrate();
  initPlayer();
  initUI();
  initKeyboard();
  initConnectivity();
  initHealth();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Exposed for debugging in the console without affecting app behaviour.
window.aichanMusic = { state, closeModal };
