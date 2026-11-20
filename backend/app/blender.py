"""Open a model in Blender with its colours showing.

A GLB from Forma carries one colour per vertex (``COLOR_0``) and Blender imports it into the
material, but a new Blender shows it badly: the Solid view paints every material one grey, and
the startup cube (2 m) hides a print of a few centimetres (the GLB is in metres). So Forma opens
Blender itself, on this computer, with a script: the scene emptied, the GLB imported, every 3D
view in Material Preview (and Solid set to the colour attribute), the model framed.

Blender is looked for in ``BLENDER_PATH``, on the PATH, in the usual install folders and as the
Microsoft Store app (whose ``blender-launcher.exe`` alias is the only way to start it).
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import trimesh

from .config import Settings
from .exporters import write_export

KEEP = 3  # GLBs kept for Blender (each up to ~200 MB): the latest few, never one just written
FRESH_S = 600.0

SCRIPT = r'''
import sys, traceback
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]
report = argv[1] if len(argv) > 1 else ""


def show():
    lines = []
    try:
        for ob in list(bpy.data.objects):  # a new Blender: the startup cube, camera and light
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.ops.import_scene.gltf(filepath=path)
        model = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        for o in model:
            o.select_set(True)
        if model:
            bpy.context.view_layer.objects.active = model[0]
            me = model[0].data
            lines.append(f"mesh {len(me.vertices)} {[a.name for a in me.color_attributes]}")
        try:  # the colours as Forma shows them: AgX, Blender's default, pales strong colours
            bpy.context.scene.view_settings.view_transform = "Standard"
            bpy.context.scene.view_settings.look = "None"
        except TypeError:
            pass
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type != "VIEW_3D":
                    continue
                space = area.spaces.active
                space.shading.type = "MATERIAL"  # Material Preview: the colours, lit
                try:  # and in the Solid view too: "Attribute" in the menu, VERTEX inside
                    space.shading.color_type = "VERTEX"
                except TypeError:
                    pass
                space.clip_start = 0.0005  # a print of a few centimetres, seen from close
                region = next(r for r in area.regions if r.type == "WINDOW")
                with bpy.context.temp_override(window=window, area=area, region=region):
                    bpy.ops.view3d.view_selected()
                lines.append(f"view {space.shading.type} {space.shading.color_type}")
    except Exception:
        lines.append("error " + traceback.format_exc())
    if report:
        with open(report, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        bpy.ops.wm.quit_blender()
    return None


bpy.app.timers.register(show, first_interval=0.3)  # once the windows are up
'''


class BlenderError(RuntimeError):
    pass


def find_blender(settings: Settings) -> str | None:
    """The Blender to start, or None."""
    if settings.blender_path:
        return settings.blender_path if Path(settings.blender_path).is_file() else None
    found = shutil.which("blender")
    if found:
        return found
    candidates: list[str] = []
    if sys.platform == "win32":
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                     os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")):
            candidates += sorted(glob.glob(os.path.join(root, "Blender Foundation", "*", "blender.exe")),
                                 reverse=True)
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            candidates += sorted(glob.glob(os.path.join(local, "Programs", "Blender*", "blender.exe")),
                                 reverse=True)
            candidates += glob.glob(os.path.join(local, "Microsoft", "WindowsApps",
                                                 "BlenderFoundation.Blender_*", "blender-launcher.exe"))
    elif sys.platform == "darwin":
        candidates.append("/Applications/Blender.app/Contents/MacOS/Blender")
    # os.path.exists, not is_file: the Store alias is a reparse point that is_file may refuse
    return next((c for c in candidates if os.path.exists(c)), None)


def _tidy(folder: Path) -> None:
    """Keep the latest few GLBs, and any written in the last minutes (Blender may still read it)."""
    files = sorted(folder.glob("*.glb"), key=lambda p: p.stat().st_mtime, reverse=True)
    now = time.time()
    for old in files[KEEP:]:
        if now - old.stat().st_mtime > FRESH_S:
            old.unlink(missing_ok=True)


def open_in_blender(mesh: trimesh.Trimesh, name: str, settings: Settings, report: str = "") -> Path:
    """Write ``mesh`` as a checked GLB and start Blender on it (not waiting for it)."""
    exe = find_blender(settings)
    if exe is None:
        raise BlenderError("Blender non trovato: installalo (blender.org o Microsoft Store) "
                           "o indica il percorso in BLENDER_PATH nel file .env.")
    folder = settings.data_dir / "blender"
    folder.mkdir(parents=True, exist_ok=True)
    _tidy(folder)
    stem = Path(name).stem or "modello"
    path = folder / f"{stem}-{uuid.uuid4().hex[:6]}.glb"
    write_export(mesh, "glb", path)  # the same checked GLB as the download
    script = folder / "forma_open.py"
    script.write_text(SCRIPT, encoding="utf-8")
    args = [exe, "--python", str(script), "--", str(path)] + ([report] if report else [])
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, close_fds=True, creationflags=flags)
    except OSError as exc:
        raise BlenderError(f"Blender non si avvia ({exe}): {exc}") from exc
    return path
