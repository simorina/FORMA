/** Keyboard shortcuts and the "?" overlay that lists them. */
import type { App, AppState } from '../app';
import { h, isMac, typingTarget } from '../lib/dom';
import { icon } from '../lib/icons';

export function mountShortcuts(host: HTMLElement, app: App, focusPrompt: () => void): void {
  const mod = isMac() ? '⌘' : 'Ctrl';
  const list: [string[], string][] = [
    [['Invio'], 'Genera dal prompt'],
    [[mod, 'Invio'], 'Genera, da qualunque punto'],
    [['/'], 'Scrivi il prompt'],
    [['E'], 'Modifica la forma'],
    [['G', 'S', 'I'], 'Sposta, leviga, gonfia'],
    [['X'], 'Simmetria sull’asse X'],
    [['[', ']'], 'Raggio del pennello (anche − e +)'],
    [[mod, 'Z'], 'Annulla'],
    [[mod, '⇧', 'Z'], 'Ripeti'],
    [['F'], 'Inquadra il modello'],
    [['Spazio'], 'Rotazione automatica'],
    [['H'], 'Cronologia'],
    [['?'], 'Questo elenco'],
    [['Esc'], 'Chiudi, esci dalla modifica'],
  ];
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Chiudi' }, icon('close'));
  const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-title', tabindex: -1 },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'shortcuts-title', class: 'section-title' }, 'Scorciatoie da tastiera'), close),
    h('dl', { class: 'shortcut-list' }, list.map(([keys, what]) =>
      h('div', { class: 'shortcut' }, h('dt', null, keys.map((k) => h('kbd', null, k))), h('dd', null, what)))));
  const scrim = h('div', { class: 'scrim' }, dialog);
  scrim.hidden = true;
  host.appendChild(scrim);

  let lastFocus: Element | null = null;
  const setOpen = (open: boolean) => app.store.set({ shortcuts: open });
  close.addEventListener('click', () => setOpen(false));
  scrim.addEventListener('click', (e) => { if (e.target === scrim) setOpen(false); });
  app.store.subscribe((s: AppState, prev: AppState) => {
    if (s.shortcuts === prev.shortcuts) return;
    scrim.hidden = !s.shortcuts;
    if (s.shortcuts) {
      lastFocus = document.activeElement;
      dialog.focus();
    } else if (lastFocus instanceof HTMLElement) {
      lastFocus.focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    const s = app.state;
    const k = e.key;
    const cmd = e.metaKey || e.ctrlKey;
    const sculpt = app.viewer?.sculpt;

    if (s.shortcuts) {
      if (k === 'Escape' || k === '?') { e.preventDefault(); setOpen(false); }
      if (k === 'Tab') { e.preventDefault(); close.focus(); } // keep focus in the dialog
      return;
    }
    if (cmd && k === 'Enter') {
      e.preventDefault();
      void app.generate();
      return;
    }
    if (cmd && (k === 'z' || k === 'Z' || k === 'y') && !typingTarget(e.target)) {
      if (!s.edit && s.sculpt.steps === 0) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) sculpt?.redo();
      else sculpt?.undo();
      return;
    }
    if (typingTarget(e.target)) {
      if (k === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    // [ and ] need AltGr on Italian keyboards: accept them whatever the modifiers
    if (s.edit && (k === '[' || k === ']' || k === '-' || k === '+')) {
      e.preventDefault();
      sculpt?.scaleRadius(k === '[' || k === '-' ? 1 / 1.15 : 1.15);
      return;
    }
    if (cmd || e.altKey) return;
    switch (k) {
      case '/':
        e.preventDefault();
        app.store.set({ sheet: window.innerWidth < 1024 ? 'create' : null });
        focusPrompt();
        break;
      case 'e': case 'E':
        app.setEdit();
        break;
      case 'g': case 'G':
        if (s.edit) sculpt?.set({ tool: 'grab' });
        break;
      case 's': case 'S':
        if (s.edit) sculpt?.set({ tool: 'smooth' });
        break;
      case 'i': case 'I':
        if (s.edit) sculpt?.set({ tool: 'inflate' });
        break;
      case 'x': case 'X':
        if (s.edit) sculpt?.set({ symmetry: !s.sculpt.symmetry });
        break;
      case 'f': case 'F':
        app.viewer?.fit();
        break;
      case ' ':
        if ((e.target as HTMLElement)?.closest?.('button, a, [role="button"], summary')) return;
        e.preventDefault();
        app.toggleAutoRotate();
        break;
      case 'h': case 'H':
        app.setPanel(s.panel === 'history' ? 'create' : 'history');
        if (window.innerWidth < 1024) app.store.set({ sheet: 'create' });
        break;
      case '?':
        e.preventDefault();
        setOpen(true);
        break;
      case 'Escape':
        if (s.sheet) app.store.set({ sheet: null });
        else if (s.edit) app.setEdit(false);
        break;
    }
  });
}
