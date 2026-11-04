/** Keyboard shortcuts, the "?" overlay that lists them, and their echo on screen (keys.ts). */
import type { App, AppState } from '../app';
import { h, isMac, typingTarget } from '../lib/dom';
import { icon } from '../lib/icons';
import { describe, mountKeys, type CueFacts, type KeyAction } from './keys';

export function mountShortcuts(host: HTMLElement, app: App, focusPrompt: () => void): void {
  const mac = isMac();
  const mod = mac ? '⌘' : 'Ctrl';
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
    [['1', '2', '3', '4'], 'Vista frontale, laterale, dall’alto, di tre quarti'],
    [['W'], 'Mostra i triangoli della mesh'],
    [['O'], 'Mostra gli sbalzi da sostenere'],
    [['C'], 'Vista in sezione'],
    [['Spazio'], 'Rotazione automatica'],
    [['H'], 'Cronologia'],
    [['?'], 'Questo elenco'],
    [['Esc'], 'Chiudi, esci dalla modifica'],
    [['←', '→'], 'Nella guida: passo precedente e successivo'],
  ];
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Chiudi' }, icon('close'));
  const guide = h('button', { class: 'btn btn-secondary btn-small', type: 'button', onclick: () => app.startTour() }, icon('guide'), 'Avvia la guida');
  const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-title', tabindex: -1 },
    h('div', { class: 'dialog-head' }, h('h2', { id: 'shortcuts-title', class: 'section-title' }, 'Scorciatoie da tastiera'), close),
    h('dl', { class: 'shortcut-list' }, list.map(([keys, what]) =>
      h('div', { class: 'shortcut' }, h('dt', null, keys.map((k) => h('kbd', null, k))), h('dd', null, what)))),
    h('div', { class: 'dialog-foot' }, h('p', { class: 'meta' }, 'Prima volta qui? Un giro dell’interfaccia in nove passi.'), guide));
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

  // What each key did, shown at the foot of the viewport (keys.ts). It compares the state as the
  // key went down (before any handler: the prompt's own Enter may already have generated) with
  // the state once the action has run. Only reads: the shortcuts work exactly as without it.
  const hud = mountKeys(document.querySelector<HTMLElement>('.viewport') ?? host);
  app.store.subscribe(() => hud.refresh());
  let down: { e: KeyboardEvent; s: AppState } | null = null;
  document.addEventListener('keydown', (e) => { down = { e, s: app.state }; }, { capture: true });

  document.addEventListener('keydown', (e) => {
    const s = app.state;
    const k = e.key;
    const cmd = e.metaKey || e.ctrlKey;
    const sculpt = app.viewer?.sculpt;
    const before = down?.e === e ? down.s : s;
    const cue = (action: KeyAction, facts?: CueFacts) => hud.show(describe(action, k, before, app.state, facts, mac), e.repeat);

    if (s.tour !== null) return; // the guided tour has its own keys
    if (s.shortcuts) {
      if (k === 'Escape' || k === '?') { e.preventDefault(); setOpen(false); cue('help'); }
      if (k === 'Tab') { e.preventDefault(); (document.activeElement === close ? guide : close).focus(); } // keep focus in the dialog
      return;
    }
    if (cmd && k === 'Enter') {
      e.preventDefault();
      const can = app.canGenerate(before);
      void app.generate();
      cue('generate', { done: can });
      return;
    }
    if (cmd && (k === 'z' || k === 'Z' || k === 'y') && !typingTarget(e.target)) {
      if (!s.edit && s.sculpt.steps === 0) return;
      e.preventDefault();
      const redo = k === 'y' || e.shiftKey;
      const done = redo ? sculpt?.redo() : sculpt?.undo();
      if (sculpt) cue(redo ? 'redo' : 'undo', { done });
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
      if (sculpt) cue('radius');
      return;
    }
    if (cmd || e.altKey) return;
    switch (k) {
      case '/':
        e.preventDefault();
        app.store.set({ sheet: window.innerWidth < 1024 ? 'create' : null });
        focusPrompt();
        cue('prompt');
        break;
      case 'e': case 'E':
        app.setEdit();
        cue('edit');
        break;
      case 'g': case 'G':
        if (s.edit && sculpt) { sculpt.set({ tool: 'grab' }); cue('tool'); }
        break;
      case 's': case 'S':
        if (s.edit && sculpt) { sculpt.set({ tool: 'smooth' }); cue('tool'); }
        break;
      case 'i': case 'I':
        if (s.edit && sculpt) { sculpt.set({ tool: 'inflate' }); cue('tool'); }
        break;
      case 'x': case 'X':
        if (s.edit && sculpt) { sculpt.set({ symmetry: !s.sculpt.symmetry }); cue('symmetry'); }
        break;
      case 'f': case 'F':
        if (app.viewer) { app.viewer.fit(); cue('fit'); }
        break;
      case '1': case '2': case '3': case '4':
        if (app.viewer) { app.viewer.setView((['front', 'side', 'top', 'iso'] as const)[Number(k) - 1]); cue('view'); }
        break;
      case 'w': case 'W':
        if (s.current) { app.toggleWireframe(); cue('wireframe'); }
        break;
      case 'o': case 'O':
        if (s.current) { app.toggleOverhang(); cue('overhang'); }
        break;
      case 'c': case 'C':
        if (s.current) { app.setSection(s.section === null ? 0.5 : null); cue('section', { height: app.size()?.[2] }); }
        break;
      case ' ':
        if ((e.target as HTMLElement)?.closest?.('button, a, [role="button"], summary')) return;
        e.preventDefault();
        app.toggleAutoRotate();
        cue('rotate');
        break;
      case 'h': case 'H':
        app.setPanel(s.panel === 'history' ? 'create' : 'history');
        if (window.innerWidth < 1024) app.store.set({ sheet: 'create' });
        cue('history');
        break;
      case '?':
        e.preventDefault();
        setOpen(true);
        cue('help');
        break;
      case 'Escape':
        if (s.sheet) app.store.set({ sheet: null });
        else if (s.draft) app.cancelDraft();
        else if (s.edit) app.setEdit(false);
        else if (s.section !== null) app.setSection(null);
        cue('escape');
        break;
    }
  });
}
