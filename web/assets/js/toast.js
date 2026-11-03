import { escapeHTML } from './util.js';

const root = document.getElementById('toasts');
const MAX_TOASTS = 3;

export function showToast(message, type = 'info', duration = 4200) {
  if (!root || !message) return;

  while (root.children.length >= MAX_TOASTS) {
    root.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${escapeHTML(message)}</span>`;
  root.appendChild(el);

  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 320);
  };

  const timer = setTimeout(remove, duration);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}
