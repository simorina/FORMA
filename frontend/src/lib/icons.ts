/** Outline icons, 16px, 1.5px stroke in currentColor (one set, grey by default). */
import { svg } from './dom';

const paths: Record<string, string> = {
  sculpt: '<path d="M10.5 2.5l3 3-6.8 6.8-3.4.9.9-3.4z"/><path d="M8.8 4.2l3 3"/>',
  history: '<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>',
  help: '<circle cx="8" cy="8" r="5.75"/><path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.6c0 1.1-1.6 1.4-1.6 2.4"/><path d="M8 11.4v.1"/>',
  download: '<path d="M8 2.75v7.5M5 7.5l3 3 3-3"/><path d="M3 12.75h10"/>',
  fit: '<path d="M2.75 6V3.75a1 1 0 0 1 1-1H6M10 2.75h2.25a1 1 0 0 1 1 1V6M13.25 10v2.25a1 1 0 0 1-1 1H10M6 13.25H3.75a1 1 0 0 1-1-1V10"/>',
  rotate: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.25 2.75v2.75H10.5"/>',
  undo: '<path d="M5.5 4.75L2.75 7.5 5.5 10.25"/><path d="M2.75 7.5h6.5a3.75 3.75 0 0 1 0 7.5H7"/>',
  redo: '<path d="M10.5 4.75l2.75 2.75-2.75 2.75"/><path d="M13.25 7.5h-6.5a3.75 3.75 0 0 0 0 7.5H9"/>',
  mirror: '<path d="M8 2v12" stroke-dasharray="1.5 1.5"/><path d="M6 4.5L2.5 11.5H6zM10 4.5l3.5 7H10z"/>',
  grab: '<path d="M8 2.5v11M2.5 8h11"/><path d="M6.25 4.25L8 2.5l1.75 1.75M6.25 11.75L8 13.5l1.75-1.75M4.25 6.25L2.5 8l1.75 1.75M11.75 6.25L13.5 8l-1.75 1.75"/>',
  smooth: '<path d="M2.5 10c1.5-2.5 2.75-2.5 4 0s2.5 2.5 4 0 2.25-2 3-1"/><path d="M2.5 6c1.5-1 3-1 5.5 0s4 1 5.5 0" opacity=".55"/>',
  inflate: '<circle cx="8" cy="8" r="3"/><path d="M8 2.25v1.5M8 12.25v1.5M2.25 8h1.5M12.25 8h1.5"/>',
  upload: '<path d="M8 10.5V2.75M5 5.5l3-3 3 3"/><path d="M2.75 10v2.25a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  alert: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.25v.1"/>',
  image: '<rect x="2.25" y="3" width="11.5" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="M2.5 11.5l3.5-3 2.5 2 2-1.5 3 2.5"/>',
  chevron: '<path d="M4.5 6.25L8 9.75l3.5-3.5"/>',
  back: '<path d="M9.5 3.5L5 8l4.5 4.5"/>',
  cube: '<path d="M8 2l5.25 3v6L8 14 2.75 11V5z"/><path d="M2.75 5L8 8l5.25-3M8 8v6"/>',
  spinner: '<path d="M8 2.25a5.75 5.75 0 1 0 5.75 5.75"/>',
  printer: '<path d="M3 13.25h10M4.5 13.25V4.5h7v8.75M4.5 6.5h7"/><path d="M8 6.5v2.5"/>',
  sparkle: '<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3"/>',
  overhang: '<path d="M2.75 13.25h10.5"/><path d="M6.25 13.25V8.25"/><path d="M2.5 8.25h11L11.25 5h-6.5z"/>',
  section: '<path d="M8 2l5.25 3v6L8 14 2.75 11V5z"/><path d="M2.75 8.25L8 11.25l5.25-3"/>',
};

export function icon(name: keyof typeof paths | string, size = 16, label?: string): SVGSVGElement {
  const el = svg(
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon icon-${name}">${paths[name] ?? ''}</svg>`,
  );
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  return el;
}

/**
 * The Forma mark: an F built from print layers, drawn in the filament colour
 * (it changes with the filament you pick).
 */
export function mark(size = 20): SVGSVGElement {
  return svg(`<svg width="${size}" height="${size}" viewBox="0 0 20 20" class="mark" aria-hidden="true">
    <rect x="3" y="2.5" width="14" height="3" rx="1.5" fill="var(--data)"/>
    <rect x="3" y="7" width="5" height="3" rx="1.5" fill="var(--data)" opacity=".72"/>
    <rect x="3" y="11.5" width="10.5" height="3" rx="1.5" fill="var(--data)"/>
    <rect x="3" y="16" width="5" height="2.5" rx="1.25" fill="var(--data)" opacity=".72"/>
  </svg>`);
}
