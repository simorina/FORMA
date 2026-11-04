"""Mesh export: STL (binary), 3MF (mm), OBJ, GLB."""

from __future__ import annotations

import io
import zipfile

import numpy as np
import trimesh

FORMATS: dict[str, tuple[str, str]] = {
    "stl": ("model/stl", "stl"),
    "3mf": ("model/3mf", "3mf"),
    "obj": ("model/obj", "obj"),
    "glb": ("model/gltf-binary", "glb"),
}

# glTF is Y-up and in metres: Z-up mm -> Y-up m.
Z_UP_TO_Y_UP = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)


def _plain(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    return trimesh.Trimesh(vertices=mesh.vertices.copy(), faces=mesh.faces.copy(), process=False)


def export_stl(mesh: trimesh.Trimesh) -> bytes:
    return trimesh.exchange.stl.export_stl(_plain(mesh))  # binary STL


def export_3mf(mesh: trimesh.Trimesh, name: str = "forma") -> bytes:
    data = trimesh.exchange.threemf.export_3MF(_plain(mesh))
    # Make units explicit and robust, whatever the trimesh version wrote.
    src = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            content = src.read(item.filename)
            if item.filename.endswith(".model"):
                text = content.decode("utf-8")
                if 'unit="' not in text:
                    text = text.replace("<model ", '<model unit="millimeter" ', 1)
                else:
                    import re

                    text = re.sub(r'unit="[a-z]+"', 'unit="millimeter"', text, count=1)
                content = text.encode("utf-8")
            dst.writestr(item, content)
    return out.getvalue()


def export_obj(mesh: trimesh.Trimesh) -> bytes:
    text = trimesh.exchange.obj.export_obj(_plain(mesh), include_normals=True, include_texture=False)
    return ("# Forma - units: millimetres, Z up\n" + text).encode("utf-8")


def export_glb(mesh: trimesh.Trimesh, metres: bool = True) -> bytes:
    m = _plain(mesh)
    if metres:
        m.apply_transform(Z_UP_TO_Y_UP)
        m.apply_scale(0.001)
    return trimesh.exchange.gltf.export_glb(trimesh.Scene(m))


def export_mesh(mesh: trimesh.Trimesh, fmt: str) -> tuple[bytes, str, str]:
    """Return (bytes, mime type, extension)."""
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise ValueError(f"Formato non supportato: {fmt}")
    mime, ext = FORMATS[fmt]
    if fmt == "stl":
        data = export_stl(mesh)
    elif fmt == "3mf":
        data = export_3mf(mesh)
    elif fmt == "obj":
        data = export_obj(mesh)
    else:
        data = export_glb(mesh)
    return data, mime, ext
