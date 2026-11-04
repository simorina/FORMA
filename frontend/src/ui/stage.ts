/**
 * Overlays inside the viewport: the honest first run, the preview image to approve, the
 * generation stages with the intermediate image and Retry, the view tools (fit, auto-rotate,
 * overhang map, section, wireframe) and quick views, the sculpt hint, and fatal states.
 *
 * They move like the rest of the house (lib/motion, styles/overlays.css): the first run plays
 * like a title card, "La prova" rises and its picture is uncovered like a curtain, the stages
 * light up one by one, the dock drops in and the quick views' ink slides between them. Cards
 * leave on a ghost copy: the real one is hidden at once, like everything the state says.
 */
import '../styles/overlays.css';
import type { App, AppState } from '../app';
import type { View } from '../viewer/viewer';
import type { Job, Stage } from '../lib/api';
import { attr, h, memo, prop, render } from '../lib/dom';
import { mm, num } from '../lib/format';
import { icon } from '../lib/icons';
import { DUR, EASE, canAnimate, enter, ghostOut, play, stagger } from '../lib/motion';

const STAGE_ICON: Record<Stage['status'], string> = {
  pending: '', active: 'spinner', done: 'check', skipped: 'check', error: 'alert',
};

// the cards' exits, played on their ghosts: "La prova" sinks into the 3D step when approved
const DRAFT_TO_3D: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(24px) scale(0.98)' }];
const DRAFT_AWAY: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) scale(0.985)' }];
const PROGRESS_OUT: Keyframe[] = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(18px)' }];

/** When the page's own opening (app.css: the viewport rises) is far enough along. */
const afterOpening = (at: number) => Math.max(0, at - performance.now());

/** A chip that slides out from the left edge of the viewport. */
const slideIn = (el: Element, delay = 0) =>
  play(el, [
    { opacity: 0, transform: 'translateX(-16px)', clipPath: 'inset(0 100% 0 0)' },
    { opacity: 1, transform: 'none', clipPath: 'inset(0 0% 0 0)' },
  ], { delay, duration: DUR.base, easing: EASE.out, fill: 'backwards' });

/**
 * A picture uncovered like a curtain going up, once it has loaded and can be seen: arm() right
 * after changing its src (it stays covered meanwhile, so the old picture never flashes),
 * check() after showing it. Without motion, nothing is covered.
 */
function curtain(img: HTMLImageElement) {
  let pending = false;
  const check = () => {
    if (!pending || !img.complete || img.getClientRects().length === 0) return;
    pending = false;
    img.style.clipPath = '';
    void enter.wipe(img, 0, 'bottom', DUR.slow);
    void play(img, [{ transform: 'scale(1.06)' }, { transform: 'none' }], { duration: DUR.hero, easing: EASE.out });
  };
  img.addEventListener('load', check);
  img.addEventListener('error', () => { pending = false; img.style.clipPath = ''; });
  return {
    arm() {
      if (!canAnimate()) return;
      pending = true;
      img.style.clipPath = 'inset(100% 0 0 0)';
    },
    check,
  };
}

export function mountStage(root: HTMLElement, app: App): void {
  const progress = h('div', { class: 'progress', role: 'status', 'aria-live': 'polite', hidden: true });
  const fatal = h('div', { class: 'stage-fatal', role: 'alert', hidden: true });
  const hint = h('p', { class: 'sculpt-hint', hidden: true },
    'Trascina sul modello per scolpire · sul vuoto, o con Alt, per ruotare');

  // the first run, a title card: built once, only the note changes
  const coverLetters = h('span', { class: 'cover-letters', 'aria-hidden': 'true' },
    Array.from('Atelier di stampa 3D', (ch) => (ch === ' ' ? ' ' : h('span', null, ch))));
  const word = (w: string) => h('span', { class: 'cover-word' }, h('span', null, w));
  const coverTitle = h('h2', { class: 'stage-title stage-hero' },
    word('Il'), ' ', word('piatto'), ' ', h('em', null, word('è'), ' ', word('vuoto')));
  const coverText = h('p', null, 'Descrivi un oggetto, carica una foto o una mesh da riparare. Forma lo modella in 3D, lo ripara e lo prepara in millimetri per la tua stampante.');
  const coverNote = h('p', { class: 'meta' });
  const coverTour = h('button', { class: 'btn btn-secondary btn-small stage-tour', type: 'button', onclick: () => app.startTour() }, icon('guide'), 'Scopri come funziona');
  const empty = h('div', { class: 'stage-empty', hidden: true },
    h('p', { class: 'kicker' }, coverLetters, h('span', { class: 'visually-hidden' }, 'Atelier di stampa 3D')),
    coverTitle, coverText, coverNote, coverTour);

  const fitBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Inquadra il modello (F)', title: 'Inquadra · F', onclick: () => app.viewer?.fit() }, icon('fit'));
  const rotateBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Rotazione automatica (Spazio)', title: 'Rotazione automatica · Spazio', onclick: () => app.toggleAutoRotate() }, icon('rotate'));
  const overBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Mostra gli sbalzi (O)', title: 'Mostra gli sbalzi · O', onclick: () => app.toggleOverhang() }, icon('overhang'));
  const sectionBtn = h('button', {
    class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Vista in sezione (C)', title: 'Sezione · C',
    onclick: () => app.setSection(app.state.section === null ? 0.5 : null),
  }, icon('section'));
  const wireBtn = h('button', { class: 'icon-btn tool-btn', type: 'button', 'aria-label': 'Mostra i triangoli (W)', title: 'Triangoli · W', onclick: () => app.toggleWireframe() }, icon('wire'));
  const toolBtns = [fitBtn, rotateBtn, overBtn, sectionBtn, wireBtn];
  const tools = h('div', { class: 'view-tools' }, toolBtns);
  const VIEWS: { key: View; label: string; name: string; keyHint: string }[] = [
    { key: 'front', label: 'Fronte', name: 'Vista frontale', keyHint: '1' },
    { key: 'side', label: 'Lato', name: 'Vista laterale', keyHint: '2' },
    { key: 'top', label: 'Alto', name: 'Vista dall’alto', keyHint: '3' },
    { key: 'iso', label: '3/4', name: 'Vista di tre quarti', keyHint: '4' },
  ];
  const viewBtns = VIEWS.map((v) => h('button', {
    class: 'preset', type: 'button', 'aria-pressed': 'false', 'data-view': v.key,
    'aria-label': `${v.name} (${v.keyHint})`, title: `${v.name} · ${v.keyHint}`,
    onclick: () => app.viewer?.setView(v.key),
  }, v.label));
  // the pressed view's ink, drawn over the buttons (it lets the clicks through)
  const presetInk = h('span', { class: 'preset-ink', 'aria-hidden': 'true' }, VIEWS.map((v) => h('span', null, v.label)));
  const presets = h('div', { class: 'view-presets', role: 'group', 'aria-label': 'Viste rapide', hidden: true }, viewBtns, presetInk);
  const dock = h('div', { class: 'view-dock', hidden: true }, tools, presets);

  // bottom-left: the overhang legend and the section slider
  const legend = h('p', { class: 'chip legend', hidden: true });
  const sectionRange = h('input', { type: 'range', class: 'range', min: 2, max: 100, step: 1, 'aria-label': 'Altezza del taglio' }) as HTMLInputElement;
  const sectionValue = h('output', { class: 'num value' });
  sectionRange.addEventListener('input', () => app.setSection(Number(sectionRange.value) / 100));
  const sectionPanel = h('div', { class: 'chip section-panel', hidden: true },
    h('span', { class: 'label' }, 'Sezione'), sectionRange, sectionValue);
  const corner = h('div', { class: 'stage-corner', hidden: true }, legend, sectionPanel);

  // the preview image to approve before the 3D step
  const draftImg = h('img', { class: 'draft-image', alt: 'Immagine di anteprima generata dal prompt', width: 280, height: 280 });
  const draftWait = h('div', { class: 'draft-wait', 'aria-hidden': 'true' }, icon('spinner', 20));
  // the picture before the 3D step is a fitting before the tailoring: "la prova"
  const draftKicker = h('p', { class: 'kicker' }, 'La prova');
  const draftTitle = h('h2', { class: 'stage-title' });
  const draftText = h('p', { class: 'draft-text' });
  const draftMeta = h('p', { class: 'draft-quote' });
  const draftEn = h('p', { class: 'meta draft-en' });
  // (how the card leaves: into the 3D step when approved, away otherwise)
  let approving = false;
  const approve = h('button', {
    class: 'btn btn-primary', type: 'button',
    onclick: () => { approving = true; try { void app.approveDraft(); } finally { approving = false; } },
  }, 'Crea il modello 3D');
  const another = h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => app.preview() }, 'Un’altra immagine');
  const dismiss = h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.cancelDraft() }, 'Annulla');
  const draftMedia = h('div', { class: 'draft-media' }, draftImg, draftWait);
  const draftCard = h('div', { class: 'draft', role: 'dialog', 'aria-label': 'Anteprima dell’immagine', hidden: true },
    draftMedia,
    h('div', { class: 'draft-body' }, draftKicker, draftTitle, draftText, draftMeta, draftEn, h('div', { class: 'draft-actions' }, approve, another, dismiss)));

  root.append(empty, progress, draftCard, fatal, hint, dock, corner);

  const card = {
    figure: h('figure', { class: 'progress-image' }),
    img: h('img', { alt: 'Immagine di partenza generata dal prompt', width: 104, height: 104 }),
    stages: h('ol', { class: 'stages' }),
    message: h('p', { class: 'progress-message' }),
    bar: h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Avanzamento', 'aria-valuemin': 0, 'aria-valuemax': 100 }),
    fill: h('span', { class: 'bar-fill' }),
    value: h('span', { class: 'bar-value num' }),
    actions: h('div', { class: 'progress-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => app.retry() }, 'Riprova'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => app.dismissJob() }, 'Chiudi')),
  };
  card.figure.append(card.img, h('figcaption', { class: 'meta' }, 'Immagine di partenza'));
  card.bar.append(card.fill, card.value);
  progress.append(card.figure, h('div', { class: 'progress-body' }, card.stages, card.message, card.bar, card.actions));

  const draftPicture = curtain(draftImg);
  const startPicture = curtain(card.img);

  // -- motion ------------------------------------------------------------------------------------
  /** The first run as a title card: the kicker tracks in, the words rise, «è vuoto» lands last. */
  let coverIntroUntil = 0;
  const playCover = () => {
    if (!canAnimate()) return;
    const t = afterOpening(520);
    const letters = Array.from(coverLetters.children);
    const mid = (letters.length - 1) / 2;
    letters.forEach((l, i) => void play(l, [
      { opacity: 0, transform: `translateX(${((i - mid) * 0.42).toFixed(2)}em)` },
      { opacity: 1, transform: 'none' },
    ], { delay: t, duration: DUR.hero, easing: EASE.out, fill: 'backwards' }));
    coverTitle.querySelectorAll('.cover-word').forEach((mask, i) => {
      const last = i >= 2; // the italic «è vuoto»
      const delay = t + 160 + i * 90 + (last ? 150 : 0);
      const duration = last ? DUR.hero : 900;
      // the mask holds only while its word rises (then the glyphs are free again)
      void play(mask, [{ clipPath: 'inset(0)' }, { clipPath: 'inset(0)' }], { delay, duration, fill: 'backwards' });
      void play(mask.firstElementChild!, [{ transform: 'translateY(calc(100% + 0.5em))' }, { transform: 'none' }], {
        delay, duration, easing: last ? EASE.spring : EASE.out, fill: 'backwards',
      });
    });
    void enter.rise(coverText, t + 700, 12, DUR.slow);
    void enter.rise(coverNote, t + 800, 10, DUR.slow);
    void enter.rise(coverTour, t + 880, 10, DUR.base);
    coverIntroUntil = performance.now() + t + 1300;
  };

  /** "La prova" comes in: the card rises, then its lines one after the other. */
  let draftSettled = 0;
  const playDraftIn = () => {
    if (!canAnimate()) return;
    draftSettled = performance.now() + 560;
    void play(draftCard, [{ opacity: 0, translate: '0 22px' }, { opacity: 1, translate: '0 0' }], { duration: DUR.base, easing: EASE.out });
    void enter.fade(draftMedia, 60, DUR.base);
    void stagger([draftKicker, draftTitle, draftText, draftMeta, draftEn], (el, d) => enter.rise(el, d, 10), 45, 10, 80);
    void stagger([approve, another, dismiss], (el, d) => enter.rise(el, d, 8, DUR.short), 40, 10, 170);
  };

  /** The dock's boxes drop in, their buttons one after the other. */
  const dropIn = (box: HTMLElement, items: HTMLElement[], delay: number) => {
    void enter.wipe(box, delay, 'top', DUR.base);
    void stagger(items, (el, d) => play(el, [{ opacity: 0, transform: 'translateY(-7px)' }, { opacity: 1, transform: 'none' }], {
      delay: d, duration: DUR.base, easing: EASE.out, fill: 'backwards',
    }), 40, 10, delay + 60);
  };

  /** The quick views' ink, clipped to the pressed button; it slides there, or grows from its middle. */
  type Span = { l: number; r: number }; // the visible part, from the left and the right edges
  let inkAt: Span | null = null;
  const placeInk = (animate: boolean) => {
    const w = presets.clientWidth;
    if (!w) return; // not on screen: placed when it shows (see the ResizeObserver)
    const x0 = presets.getBoundingClientRect().left + presets.clientLeft;
    let to: Span | null = null;
    for (const [k, b] of viewBtns.entries()) {
      const r = b.getBoundingClientRect();
      const label = presetInk.children[k] as HTMLElement;
      label.style.left = `${r.left - x0}px`;
      label.style.width = `${r.width}px`;
      if (b.getAttribute('aria-pressed') === 'true') to = { l: r.left - x0, r: w - (r.left - x0 + r.width) };
    }
    const at = inkAt;
    const line = (s: Span): Span => { const c = (s.l + w - s.r) / 2; return { l: c, r: w - c }; };
    const clip = (s: Span) => `inset(0 ${s.r.toFixed(2)}px 0 ${s.l.toFixed(2)}px)`;
    // nothing pressed (orbiting by hand): the ink closes to a line in the middle of its button
    const end: Span = to ?? (at ? line(at) : { l: 0, r: w });
    if (animate && at && to) {
      const closed = at.l + at.r >= w - 0.5; // (then it grows from the middle of the new button)
      void play(presetInk, [{ clipPath: clip(closed ? line(to) : at) }, { clipPath: clip(to) }], {
        duration: DUR.base, easing: closed ? EASE.out : EASE.inOut,
      });
    } else if (animate && at) {
      void play(presetInk, [{ clipPath: clip(at) }, { clipPath: clip(end) }], { duration: DUR.short, easing: EASE.inOut });
    }
    presetInk.style.clipPath = clip(end);
    inkAt = end;
    presets.classList.add('has-ink');
  };
  // the buttons change width when the web font arrives, or the layout when the window does
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => placeInk(false)).observe(presets);

  /** The stages light up: the active numeral glows, a check mark draws itself, an error lands. */
  const light = (li: HTMLElement, status: Stage['status'], delay = 0) => {
    if (status === 'active') {
      const glow = li.querySelector('.stage-glow');
      if (glow) {
        void play(glow, [
          { opacity: 0, transform: 'scale(0.2)' },
          { opacity: 1, transform: 'scale(1.3)', offset: 0.4 },
          { opacity: 1, transform: 'none' },
        ], { delay, duration: DUR.hero, easing: EASE.out, fill: 'backwards' });
      }
      void play(li, [{ opacity: 0.3, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
        pseudoElement: '::before', delay, duration: DUR.slow, easing: EASE.out, fill: 'backwards',
      });
    } else if (status === 'done' || status === 'skipped') {
      const path = li.querySelector('.stage-mark path');
      if (path) {
        path.setAttribute('pathLength', '1');
        void play(path, [{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], {
          delay, duration: DUR.slow, easing: EASE.out, fill: 'backwards',
        });
      }
    } else if (status === 'error') {
      const mark = li.querySelector('.stage-mark');
      if (mark) void enter.pop(mark, delay);
    }
  };
  let shownJob: string | null = null;
  let stageWas = new Map<string, Stage['status']>();
  const drawStages = (job: Job) => {
    const fresh = job.id !== shownJob;
    shownJob = job.id;
    const items = job.stages.map((st) => h('li', { class: `stage is-${st.status}` },
      h('span', { class: 'stage-glow', 'aria-hidden': 'true' }),
      h('span', { class: 'stage-mark' }, STAGE_ICON[st.status] ? icon(STAGE_ICON[st.status], 12) : ''),
      h('span', null, st.label)));
    render(card.stages, items);
    if (canAnimate()) {
      job.stages.forEach((st, k) => {
        if (fresh) {
          // a new job: the numbers come in one after the other, then the first one at work lights up
          void enter.rise(items[k], 90 + k * 55, 6, DUR.base);
          if (st.status !== 'pending') light(items[k], st.status, 300 + k * 55);
        } else if (stageWas.get(st.key) !== st.status) {
          light(items[k], st.status);
        }
      });
    }
    stageWas = new Map(job.stages.map((st) => [st.key, st.status]));
  };

  // each overlay redraws only when what it shows changes (see memo in lib/dom)
  const fatalView = memo(), legendView = memo(), fillView = memo(), inkView = memo();
  let prev: AppState | null = null;
  const update = (s: AppState) => {
    const busyStage = app.generating(s) || s.busy === 'upload';
    root.classList.toggle('is-generating', busyStage);
    root.classList.toggle('is-editing', s.edit);
    attr(rotateBtn, 'aria-pressed', String(s.autoRotate));
    attr(overBtn, 'aria-pressed', String(s.overhang));
    attr(sectionBtn, 'aria-pressed', String(s.section !== null));
    attr(wireBtn, 'aria-pressed', String(s.wireframe));
    for (const b of [overBtn, sectionBtn, wireBtn]) prop(b, 'disabled', !s.current);
    const hintAppears = s.edit && hint.hidden;
    prop(hint, 'hidden', !s.edit);
    if (hintAppears) void slideIn(hint);
    // the dock drops in when it first shows (after the page's opening), the quick views with the first model
    const dockAppears = !s.viewerError && dock.hidden;
    prop(dock, 'hidden', !!s.viewerError);
    if (dockAppears && canAnimate()) dropIn(tools, toolBtns, afterOpening(760));
    const presetsAppear = !!s.current && presets.hidden;
    prop(presets, 'hidden', !s.current);
    for (const b of viewBtns) attr(b, 'aria-pressed', String(b.dataset.view === s.view));
    if (presetsAppear && canAnimate()) dropIn(presets, viewBtns, afterOpening(860));
    if (!presets.hidden) inkView([s.view], () => placeInk(!presetsAppear));

    // fatal: the backend is down, or WebGL is missing
    const fatalText = s.offline ?? s.viewerError;
    const fatalAppears = !!fatalText && fatal.hidden;
    prop(fatal, 'hidden', !fatalText);
    if (fatalText) {
      fatalView([fatalText, !!s.offline], () => render(fatal,
        h('h2', { class: 'stage-title' }, s.offline ? 'Il server non risponde' : 'Vista 3D non disponibile'),
        h('p', null, fatalText),
        s.offline ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => location.reload() }, 'Riprova') : null));
      if (fatalAppears) void play(fatal, [{ opacity: 0, translate: '0 16px' }, { opacity: 1, translate: '0 0' }], { delay: afterOpening(600), duration: DUR.slow, easing: EASE.out, fill: 'backwards' });
    }

    // the preview image: while it is made, then waiting for approval
    const showDraft = s.drafting || !!s.draft;
    if (!showDraft && !draftCard.hidden) ghostOut(draftCard, approving ? DRAFT_TO_3D : DRAFT_AWAY, { duration: DUR.short + 40 });
    const draftAppears = showDraft && draftCard.hidden;
    prop(draftCard, 'hidden', !showDraft);
    if (showDraft) {
      const phaseChanged = !draftAppears && !!prev && prev.drafting !== s.drafting;
      prop(draftWait, 'hidden', !s.drafting);
      prop(draftImg, 'hidden', s.drafting || !s.draft);
      if (s.draft && draftImg.getAttribute('src') !== s.draft.url) {
        draftImg.src = s.draft.url;
        draftPicture.arm();
      }
      prop(draftTitle, 'textContent', s.drafting ? 'Creo l’immagine di partenza…' : 'Ti convince questa forma?');
      prop(draftText, 'textContent', s.drafting
        ? 'Prima un’immagine, veloce; il modello 3D, che usa la GPU, parte solo quando la approvi.'
        : 'Il modello 3D seguirà questa immagine. Se non è l’oggetto che volevi, chiedine un’altra: costa poco.');
      prop(draftMeta, 'textContent', s.draft && !s.drafting ? `“${s.draft.prompt}”` : '');
      // the image model reads English: show what it was really asked
      const en = !s.drafting && s.draft?.prompt_en;
      prop(draftEn, 'hidden', !en);
      prop(draftEn, 'textContent', en ? `In inglese per il modello d’immagine: “${en}”` : '');
      prop(approve, 'disabled', s.drafting || !s.draft);
      prop(another, 'disabled', s.drafting);
      if (draftAppears) playDraftIn();
      // the words change with the phase (the buttons stay still: they may be clicked right away)
      else if (phaseChanged && performance.now() > draftSettled) {
        void stagger([draftTitle, draftText, draftMeta, draftEn], (el, d) => enter.rise(el, d, 8, DUR.base), 50);
        if (s.drafting) void enter.fade(draftWait, 0, DUR.base);
      }
      draftPicture.check();
    }

    // first run: nothing on the bed and nothing cooking
    const showEmpty = !s.current && !s.job && !fatalText && s.historyLoaded && !showDraft && s.busy !== 'upload';
    const emptyAppears = showEmpty && empty.hidden;
    prop(empty, 'hidden', !showEmpty);
    if (showEmpty) {
      const note = honestNote(s);
      const noteChanged = coverNote.textContent !== note;
      prop(coverNote, 'textContent', note);
      if (emptyAppears) playCover();
      else if (noteChanged && performance.now() > coverIntroUntil) void enter.rise(coverNote, 0, 8, DUR.slow);
    }

    // overhang legend and section slider
    const over = s.current?.report.overhang_pct ?? 0;
    const legendHidden = !s.overhang || !s.current || s.edit;
    const legendAppears = !legendHidden && legend.hidden;
    prop(legend, 'hidden', legendHidden);
    if (!legendHidden) {
      const color = app.viewer?.overhangColor() ?? '#ff4d5e';
      const said = over > 0.5
        ? `Sbalzi oltre 45° sul ${num(over)}% della superficie: lì servono supporti`
        : 'Nessuno sbalzo oltre 45°: si stampa senza supporti';
      legendView([color, said], () => legend.replaceChildren(h('span', { class: 'legend-dot', style: { background: color } }), said));
      if (legendAppears) void slideIn(legend);
    }
    const sectionHidden = s.section === null || !s.current;
    const sectionAppears = !sectionHidden && sectionPanel.hidden;
    prop(sectionPanel, 'hidden', sectionHidden);
    if (!sectionHidden && s.section !== null) {
      const z = (app.size(s)?.[2] ?? 0) * s.section;
      if (document.activeElement !== sectionRange) prop(sectionRange, 'value', String(Math.round(s.section * 100)));
      prop(sectionValue, 'textContent', `${mm(z)} mm`);
      if (sectionAppears) void slideIn(sectionPanel, legendAppears ? 60 : 0);
    }
    prop(corner, 'hidden', legendHidden && sectionHidden);

    // generation stages: built once, updated in place (polling must not recreate the image)
    const job = s.job;
    if (!job && !progress.hidden) ghostOut(progress, PROGRESS_OUT, { duration: DUR.short });
    prop(progress, 'hidden', !job);
    if (job && (!prev || prev.job !== job)) {
      const failed = job.status === 'error';
      progress.classList.toggle('is-running', job.status === 'queued' || job.status === 'running');
      prop(card.figure, 'hidden', !job.image_url);
      if (job.image_url && card.img.getAttribute('src') !== job.image_url) {
        card.img.src = job.image_url;
        startPicture.arm();
      }
      const stagesKey = job.stages.map((st) => `${st.key}:${st.status}`).join('|');
      if (card.stages.dataset.key !== stagesKey) {
        card.stages.dataset.key = stagesKey;
        drawStages(job);
      }
      prop(card.message, 'className', failed ? 'progress-message is-error' : 'progress-message');
      prop(card.message, 'textContent', failed ? (job.error ?? 'Generazione non riuscita.') : job.message);
      prop(card.bar, 'hidden', failed);
      prop(card.actions, 'hidden', !failed);
      const pct = Math.round(job.progress * 100);
      attr(card.bar, 'aria-valuenow', String(pct));
      // the fill scales (a transform: no layout while it moves)
      const fill = Math.min(1, Math.max(0, job.progress)).toFixed(4);
      fillView([fill], () => card.fill.style.setProperty('--fill', fill));
      prop(card.value, 'textContent', `${num(pct)}%`);
    }
    if (job) startPicture.check();
    prev = s;
  };
  app.store.subscribe(update);
  update(app.state);
}

/** What the first generation will really be like with this provider and token. */
function honestNote(s: AppState): string {
  const info = s.providers?.providers.find((p) => p.name === s.provider);
  if (!s.providers || !info) return '';
  if (info.name === 'procedural') {
    return 'Modalità offline: forme parametriche scelte dalle parole del prompt (vaso, tazza, pedone, ingranaggio…). Utile per provare tutto senza rete.';
  }
  if (info.name === 'local') return 'Sulla tua GPU: il primo avvio scarica i pesi del modello e può richiedere qualche minuto.';
  return s.providers.hf_token
    ? 'Con il tuo token Hugging Face: di solito un modello è pronto in uno o due minuti, code permettendo.'
    : 'Senza HF_TOKEN si usa la quota gratuita degli Space di Hugging Face: può esserci coda, e la quota può finire. Aggiungi il token nel file .env.';
}
