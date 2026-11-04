Repo: github.com/EmanueleCavaliero/pjsr (private). Build the most beautiful AI 3D-modelling app that
exists: text prompt (or uploaded image) → 3D model → print on the user's home 3D printer.
The user is Italian: all UI text and the README in Italian; code and comments in English.
The user will add HF_TOKEN at the end: everything must work and be testable without it.

## 0. Before anything else
- RESUME, don't restart. Inspect `main` first (git log, tree, run the existing tests). Work already
  done on main must be kept and extended, not rewritten. At the time of writing, main has: the complete
  FastAPI backend (providers, print pipeline, exports, async jobs, 63 passing pytest tests) and a
  frontend scaffold (package.json with pinned versions, lockfile, .npmrc).
- Git workflow: work ONLY on `main`. No feature branches, no pull requests. Commit in small logical
  steps and `git push origin main` after each one, so progress is never lost. If a stale remote branch
  `feature/ai-3d-modeler` still exists, leave it alone (the sandbox proxy cannot delete branches) and
  remind the user to delete it from GitHub.
- Install the design skill: `git clone --depth 1 https://github.com/leonxlnx/taste-skill` and copy
  `skills/taste-skill` into `~/.claude/skills/taste-skill`. Read SKILL.md and, since this is an
  app screen (a builder/editor), read `references/app-screens.md` in full and follow ITS run, not
  the landing-page run. Deal the style with:
  `node ~/.claude/skills/taste-skill/scripts/draw.mjs --app --kind builder --theme dark --style true-black-flat --screens builder --brief "Forma: AI text-to-3D modeller for home 3D printing" --out .taste-skill/app`
  (style already chosen: true-black-flat; keep `.taste-skill/` gitignored).

## 1. Model quality first
Do a web check of the current state of the art, judged on GEOMETRY quality for printing (not textures).
Current choice: TRELLIS.2-4B (microsoft/TRELLIS.2-4B, MIT) as default; keep selectable alternatives:
Hunyuan3D-2.1 (Tencent community license: NOT valid in the EU, UK, South Korea — the user is in Italy,
say so clearly in UI and README), Step1X-3D (Apache-2.0), Hunyuan3D-2mv, TRELLIS v1.
Revise the choice only if a clearly better open-weight model exists now, and document why.
Text→3D = FLUX.1-schnell (Apache-2.0) text→image with a "single object, centered, plain background,
solid, printable" template, then image→3D. Image upload → 3D also supported.
Providers via env GEN_PROVIDER, interface generate(prompt, image, params) -> mesh:
- hf_remote (default, Mac without GPU): HF Spaces via gradio_client, FLUX via Inference Providers
  when HF_TOKEN is set; Space ids configurable via env; endpoint-specific code isolated in
  providers/endpoints/ and documented (arguments mirror each Space's upstream app.py).
- local: CUDA GPU, lazy-loaded weights, optional extra [gpu].
- procedural: offline parametric shapes from Italian/English keywords (tests, no-token use).
API: POST /api/generate, GET /api/jobs/{id} (stages), GET /api/providers, POST /api/process,
GET /api/export/{id}?format=, GET/DELETE /api/models (history).
NOTE: huggingface.co may be blocked by the cloud sandbox network. Then test hf_remote only with a
mocked Gradio client, say so in the final report, and tell the user to allow huggingface.co in the
environment's network settings for a real end-to-end test.

## 2. Print-ready pipeline (trimesh + manifold3d; pymeshlab optional)
Watertight & manifold repair (cleanup → hole filling → pymeshlab if available → voxel remesh
fallback, validated with manifold3d), debris removal, fix normals, Y-up→Z-up, orient flat/upright,
center and drop to Z=0, scale to real mm (target max dimension, default 100 mm), optional hollowing
with wall thickness, optional base plate, decimation that never breaks watertightness.
Printability report: watertight, volume cm³, bbox mm, triangles, PLA grams solid (1.24 g/cm³) and
typical (shell + 15% infill), overhang % with warning, repairs applied. Must stay fast (< ~10 s at
default settings on a laptop CPU).

## 3. Export
STL (binary), 3MF (unit="millimeter"), OBJ, GLB (metres, Y-up per glTF spec); one-click download
with a meaningful file name (prompt slug + size).

## 4. UI: the most beautiful AI 3D-modelling app that exists
Vite + TypeScript + three.js (exact pinned versions, each at least two weeks old), no UI framework.
Follow the taste-skill app-screen rules and the dealt true-black-flat sheet:
- Shell: 44px top bar (wordmark + product mark drawn for "Forma", model name with status pill, icon
  buttons, a white inverted primary pill), then three panels: left = prompt, example prompts, image
  upload, model selector, history; center = 3D viewport; right = print settings, printability report,
  export. Elevation by lightness only, no shadows on UI chrome, no gradients/glass/glows, no emoji,
  no tracked-uppercase labels, Inter self-hosted (@fontsource-variable/inter), tabular figures.
- Face of the product: the one data hue is the selected FILAMENT colour (swatches: PLA colours);
  it tints the model in the viewport and the report's key figures. Signature element: a filament
  spool gauge ("34 g of a 1 kg spool") plus bed-fit check against the chosen printer
  (Bambu A1 256×256×256, Prusa MK4 250×210×220, Ender 3 220×220×250, custom).
- Empty state: big prompt, example prompts in Italian, honest first-run.
- Progress stages: immagine → forma 3D → riparazione → pronto, showing the intermediate FLUX image
  as soon as it exists, queue position/ETA from the Space, errors inside the panel with a Retry.
- Viewport (the skill's no-shadow rules apply to UI chrome, NOT to the 3D scene): studio lighting,
  PMREM RoomEnvironment, ACES filmic tone mapping, soft shadows, subtle bed reflection, virtual print
  bed with mm grid (10/50 mm), XYZ dimension labels in mm, animated reveal, idle auto-rotate,
  OrbitControls, fit-to-view.
- Mouse editing (secondary mode): vertex grab with soft selection (radius + falloff curves),
  smooth/inflate brushes, X symmetry, undo/redo; welded vertices; live normals; "Ripara e aggiorna"
  re-runs the backend pipeline on the edited mesh (new model in history).
- Keyboard shortcuts with a "?" overlay: Enter/⌘Enter generate, / focus prompt, E edit mode,
  G/S/I tools, X symmetry, [ ] radius, ⌘Z/⌘⇧Z undo/redo, F fit view, Space auto-rotate, H history.
- Responsive (on phone: viewport first, panels as bottom sheets), visible focus, accessible names,
  polished toasts, reduced-motion support.
- Polish pass: run the skill's `lint.mjs --app` and `inspect.mjs --app` on the PRODUCTION build
  (`vite build && vite preview`) with the backend running on the procedural provider; fix every
  FAIL; take Playwright screenshots (1440, 768, 390) of empty state, generating, ready, edit mode;
  critique with the app-screen checklist and iterate (max 3 rounds). Commit the final screenshots in
  docs/screenshots/.

## 5. Dev & ops
Makefile (install, dev = backend + frontend together, test, build, serve), docker-compose.yml with an
optional `gpu` profile, .env.example, .gitignore.
Known pitfalls: pymeshlab needs libOpenGL on Linux (keep it an optional extra, install libopengl0 in
Docker); npm 10 crashes on vitest's optional peers ("edgesOut") → keep frontend/.npmrc with
legacy-peer-deps=true; Chromium + Playwright are preinstalled in the sandbox (do not reinstall).

## Quality
- pytest: procedural provider, pipeline, exports, API with mocked remote. vitest: falloff, welding,
  brushes, undo/redo, STL writer.
- Actually run `uv run pytest`, `npm test`, `npm run build`: all must pass before the final push.
- Italian README: what it is, screenshots, setup on Mac (hf_remote) and Linux GPU (local), HF_TOKEN,
  usage, shortcuts, architecture, model choice and licenses (incl. the Hunyuan EU exclusion).
- Commit messages end with the attribution lines the session provides.

## Done when
All tests and the build pass, inspect.mjs shows 0 FAIL, screenshots are in the repo, everything is
pushed to main. Then send a push notification and write the final summary in Italian: what was built,
chosen model and why, test/build results, how to run, limitations (e.g. hf_remote not tested live),
anything the user must do (HF_TOKEN, allow huggingface.co, delete the stale remote branch).
