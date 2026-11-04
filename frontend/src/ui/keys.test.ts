import { describe as group, expect, it } from 'vitest';
import type { AppState } from '../app';
import { describe, keyCaps, stackPlan } from './keys';

// only the fields the cues read; the rest of the state does not matter to them
const state = (patch: Partial<AppState> = {}): AppState => ({
  edit: false, drafting: false, draft: null, sheet: null, section: null, view: 'iso', current: null,
  wireframe: false, overhang: false, autoRotate: true, panel: 'create', shortcuts: false,
  sculpt: { tool: 'grab', radius: 8, strength: 0.5, falloff: 'smooth', symmetry: true, canUndo: false, canRedo: false, steps: 0 },
  ...patch,
} as AppState);
const model = { id: 'm' } as AppState['current'];
const label = (...args: Parameters<typeof describe>) => describe(...args)?.label ?? null;

group('keyCaps', () => {
  it('writes the modifiers as the platform does, the key last', () => {
    expect(keyCaps('undo', 'z', true)).toEqual(['⌘', 'Z']);
    expect(keyCaps('redo', 'Z', true)).toEqual(['⌘', '⇧', 'Z']);
    expect(keyCaps('redo', 'y', false)).toEqual(['Ctrl', 'Y']);
    expect(keyCaps('generate', 'Enter', false)).toEqual(['Ctrl', 'Invio']);
  });

  it('names the keys in Italian and leaves the layout modifiers out', () => {
    expect(keyCaps('rotate', ' ', true)).toEqual(['Spazio']);
    expect(keyCaps('escape', 'Escape', true)).toEqual(['Esc']);
    expect(keyCaps('radius', '-', true)).toEqual(['−']);
    expect(keyCaps('radius', ']', false)).toEqual([']']); // AltGr on Italian keyboards: not shown
    expect(keyCaps('help', '?', false)).toEqual(['?']);
    expect(keyCaps('edit', 'e', false)).toEqual(['E']);
    expect(keyCaps('view', '3', false)).toEqual(['3']);
  });
});

group('describe', () => {
  it('reads toggles from the state after the key', () => {
    const before = state({ current: model });
    expect(label('overhang', 'o', before, state({ current: model, overhang: true }))).toBe('Sbalzi accesi');
    expect(label('overhang', 'o', before, state({ current: model, overhang: false }))).toBe('Sbalzi spenti');
    expect(label('rotate', ' ', before, state({ autoRotate: false }))).toBe('Rotazione spenta');
    expect(label('wireframe', 'w', before, state({ wireframe: true }))).toBe('Triangoli accesi');
    expect(label('history', 'h', before, state({ panel: 'history' }))).toBe('Cronologia aperta');
  });

  it('names the views and the tools, and gives the radius in millimetres', () => {
    expect(label('view', '3', state(), state({ view: 'top' }))).toBe('Vista dall’alto');
    expect(label('fit', 'f', state(), state({ current: model }))).toBe('Modello inquadrato');
    expect(label('fit', 'f', state(), state())).toBe('Piatto inquadrato');
    const sculpt = { ...state().sculpt, tool: 'smooth' as const, radius: 9.2 };
    expect(label('tool', 's', state({ edit: true }), state({ edit: true, sculpt }))).toBe('Leviga');
    expect(label('radius', ']', state({ edit: true }), state({ edit: true, sculpt }))).toBe('Raggio 9,2 mm');
  });

  it('cuts the section at a height in millimetres when the model has one', () => {
    expect(label('section', 'c', state(), state({ section: 0.5 }), { height: 84 })).toBe('Sezione a 42,0 mm');
    expect(label('section', 'c', state(), state({ section: 0.5 }))).toBe('Vista in sezione');
    expect(label('section', 'c', state({ section: 0.5 }), state())).toBe('Modello intero');
  });

  it('says nothing when the key changed nothing', () => {
    expect(describe('edit', 'e', state(), state())).toBeNull(); // no model: the toast explains
    expect(describe('escape', 'Escape', state(), state())).toBeNull();
    expect(describe('generate', 'Enter', state(), state(), { done: false })).toBeNull();
    expect(describe('help', '?', state({ shortcuts: true }), state({ shortcuts: true }))).toBeNull();
  });

  it('tells what Esc closed or left, first things first', () => {
    expect(label('escape', 'Escape', state({ sheet: 'create', edit: true }), state({ edit: true }))).toBe('Pannello chiuso');
    expect(label('escape', 'Escape', state({ edit: true }), state())).toBe('Fine modifica');
    expect(label('escape', 'Escape', state({ section: 0.3 }), state())).toBe('Modello intero');
    expect(label('help', 'Escape', state({ shortcuts: true }), state())).toBe('Scorciatoie chiuse');
  });

  it('tells undo from an empty history, and the preview from the 3D step', () => {
    expect(label('undo', 'z', state(), state(), { done: true })).toBe('Annullato');
    expect(label('redo', 'Z', state(), state(), { done: false })).toBe('Niente da ripetere');
    expect(label('generate', 'Enter', state(), state({ drafting: true }), { done: true })).toBe('Creo l’immagine');
    expect(label('generate', 'Enter', state(), state(), { done: true })).toBe('Genero il modello');
  });

  it('groups the cues by what they talk about, and points at the matching control', () => {
    const view = describe('view', '1', state(), state({ view: 'front' }))!;
    expect(view.group).toBe(describe('fit', 'f', state(), state())!.group); // both move the camera
    expect(view.controls).toEqual(['.view-presets .preset[data-view="front"]']);
    expect(describe('edit', 'e', state({ current: model }), state({ current: model, edit: true }))!.group)
      .toBe(describe('escape', 'Escape', state({ edit: true }), state())!.group);
    expect(describe('undo', 'z', state(), state(), { done: false })!.controls).toEqual([]); // nothing to press
  });
});

group('stackPlan', () => {
  it('changes the newest chip in place when it is of the same group', () => {
    expect(stackPlan(['radius', 'camera'], 'radius')).toEqual({ inPlace: true, leave: [] });
  });

  it('puts a new chip in front: its group leaves, and so does what passes three', () => {
    expect(stackPlan([], 'camera')).toEqual({ inPlace: false, leave: [] });
    expect(stackPlan(['overhang', 'camera', 'section'], 'camera')).toEqual({ inPlace: false, leave: [1] });
    expect(stackPlan(['overhang', 'section', 'camera'], 'wireframe')).toEqual({ inPlace: false, leave: [2] });
    expect(stackPlan(['a', 'b'], 'c', 2)).toEqual({ inPlace: false, leave: [1] });
  });
});
