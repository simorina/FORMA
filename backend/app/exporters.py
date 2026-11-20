"""Mesh export: STL (binary), 3MF (mm), OBJ (with vertex colours), GLB.

Each format is written straight to a file in slices, so a 5M-triangle model reports how far it
is (``Progress``) and never sits whole in memory as text. Then ``verify_export`` reads the file
back and checks it against the model: the counts of vertices and triangles, the first and last
of them, and for the 3MF the CRC of every part of the archive. A file that does not pass is
deleted and never served: a truncated or inconsistent file never reaches the slicer.
"""

from __future__ import annotations

import json
import os
import struct
import tempfile
import zipfile
import zlib
from collections.abc import Callable
from pathlib import Path

import numpy as np
import trimesh

from .pipeline.colors import vertex_colors, with_colors

FORMATS: dict[str, tuple[str, str]] = {
    "stl": ("model/stl", "stl"),
    "3mf": ("model/3mf", "3mf"),
    "obj": ("model/obj", "obj"),
    "glb": ("model/gltf-binary", "glb"),
}
LABELS = {"stl": "STL", "3mf": "3MF", "obj": "OBJ", "glb": "GLB"}

# glTF is Y-up and in metres: Z-up mm -> Y-up m.
Z_UP_TO_Y_UP = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)

Progress = Callable[[float], None]
SLICE = 250_000  # vertices or triangles written (and reported) at a time
BLOCK = 16 * 2**20  # bytes read at a time by the checks


class ExportError(RuntimeError):
    """The file written does not match the model (Italian message)."""


def _noop(frac: float) -> None:
    return None


def _slices(n: int) -> list[tuple[int, int]]:
    return [(i, min(i + SLICE, n)) for i in range(0, n, SLICE)] or [(0, 0)]


def _plain(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    return trimesh.Trimesh(vertices=mesh.vertices.copy(), faces=mesh.faces.copy(), process=False)


def _with_colors(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    """Geometry plus per-vertex colours (when the model has them): OBJ and GLB carry them,
    STL and 3MF stay single-colour."""
    return with_colors(_plain(mesh), vertex_colors(mesh))


# -- writers ------------------------------------------------------------------------------------


def write_stl(mesh: trimesh.Trimesh, path: Path, progress: Progress = _noop) -> None:
    """Binary STL: an 80-byte header, the triangle count, 50 bytes per triangle."""
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    record = np.dtype([("normal", "<f4", (3,)), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    with open(path, "wb") as f:
        f.write(b"Forma binary STL, millimetres, Z up".ljust(80, b" "))
        f.write(struct.pack("<I", len(faces)))
        for a, b in _slices(len(faces)):
            tri = verts[faces[a:b]]
            normal = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
            normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-30)
            rec = np.zeros(b - a, dtype=record)
            rec["normal"], rec["v"] = normal, tri
            f.write(rec.tobytes())
            progress(b / max(len(faces), 1))


def write_obj(mesh: trimesh.Trimesh, path: Path, progress: Progress = _noop) -> None:
    """Vertices (``v x y z r g b`` with colours from 0 to 1: Bambu Studio maps them to the AMS
    filaments on import), then triangles (``f a b c``, counted from 1). No normals: slicers
    compute their own, and they would add a fifth to the file."""
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64) + 1
    colors = vertex_colors(mesh)
    rgb = colors[:, :3].astype(np.float64) / 255.0 if colors is not None else None
    line = "v %.4f %.4f %.4f %.4f %.4f %.4f\n" if rgb is not None else "v %.4f %.4f %.4f\n"
    total = len(verts) + len(faces)
    with open(path, "w", encoding="ascii", newline="\n") as f:
        f.write(f"# Forma - units: millimetres, Z up\n# {len(verts)} vertices, {len(faces)} triangles\n")
        for a, b in _slices(len(verts)):
            rows = np.hstack([verts[a:b], rgb[a:b]]) if rgb is not None else verts[a:b]
            f.write((line * (b - a)) % tuple(rows.ravel().tolist()))
            progress(b / total)
        for a, b in _slices(len(faces)):
            f.write(("f %d %d %d\n" * (b - a)) % tuple(faces[a:b].ravel().tolist()))
            progress((len(verts) + b) / total)


_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
    "</Types>"
)
_RELS = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
    "</Relationships>"
)
_MODEL_HEAD = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<model unit="millimeter" xml:lang="en-US" '
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
    '<metadata name="Application">Forma</metadata>\n'
    '<resources>\n<object id="1" type="model">\n<mesh>\n<vertices>\n'
)
_MODEL_MIDDLE = "</vertices>\n<triangles>\n"
_MODEL_TAIL = '</triangles>\n</mesh>\n</object>\n</resources>\n<build>\n<item objectid="1"/>\n</build>\n</model>\n'


def write_3mf(mesh: trimesh.Trimesh, path: Path, progress: Progress = _noop) -> None:
    """3MF core spec: one object in millimetres, streamed into the archive."""
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    total = len(verts) + len(faces)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as z:
        z.writestr("[Content_Types].xml", _CONTENT_TYPES)
        z.writestr("_rels/.rels", _RELS)
        with z.open("3D/3dmodel.model", "w", force_zip64=True) as part:
            part.write(_MODEL_HEAD.encode())
            for a, b in _slices(len(verts)):
                text = ('<vertex x="%.4f" y="%.4f" z="%.4f"/>\n' * (b - a)) % tuple(verts[a:b].ravel().tolist())
                part.write(text.encode())
                progress(b / total)
            part.write(_MODEL_MIDDLE.encode())
            for a, b in _slices(len(faces)):
                text = ('<triangle v1="%d" v2="%d" v3="%d"/>\n' * (b - a)) % tuple(faces[a:b].ravel().tolist())
                part.write(text.encode())
                progress((len(verts) + b) / total)
            part.write(_MODEL_TAIL.encode())


def export_glb(mesh: trimesh.Trimesh, metres: bool = True) -> bytes:
    """The GLB for Forma's own viewer: colours as sRGB bytes (as trimesh reads them), which
    the viewer turns to linear itself. Files for other programs: ``print_glb``."""
    m = _with_colors(mesh)
    if metres:
        m.apply_transform(Z_UP_TO_Y_UP)
        m.apply_scale(0.001)
    return trimesh.exchange.gltf.export_glb(trimesh.Scene(m))


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _pad(data: bytes, fill: bytes = b"\0") -> bytes:
    return data + fill * (-len(data) % 4)


def print_glb(mesh: trimesh.Trimesh) -> bytes:
    """The GLB as glTF 2.0 asks, for Blender and any other program: metres, Y up, the
    colours (``COLOR_0``) in linear light, 16 bits per channel so the darks keep their steps
    (as sRGB bytes Blender showed a red as pale pink), and a plain non-metallic material
    (with none, the glTF default is a metal)."""
    verts = np.asarray(mesh.vertices, dtype=np.float64) @ Z_UP_TO_Y_UP[:3, :3].T * 0.001
    pos = verts.astype("<f4")
    idx = np.asarray(mesh.faces, dtype="<u4").ravel()
    colors = vertex_colors(mesh)
    views, accessors, blob = [], [], bytearray()

    def add(data: np.ndarray, target: int) -> int:
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": data.nbytes, "target": target})
        blob.extend(_pad(data.tobytes()))
        return len(views) - 1

    accessors.append({"bufferView": add(idx, 34963), "componentType": 5125, "count": int(idx.size),
                      "type": "SCALAR"})
    accessors.append({"bufferView": add(pos, 34962), "componentType": 5126, "count": len(pos),
                      "type": "VEC3", "min": pos.min(axis=0).tolist(), "max": pos.max(axis=0).tolist()})
    attributes = {"POSITION": 1}
    if colors is not None:
        lin = _srgb_to_linear(colors[:, :3].astype(np.float64) / 255.0)
        rgba = np.empty((len(lin), 4), dtype="<u2")
        rgba[:, :3] = np.rint(lin * 65535.0)
        rgba[:, 3] = 65535
        accessors.append({"bufferView": add(rgba, 34962), "componentType": 5123, "normalized": True,
                          "count": len(rgba), "type": "VEC4"})
        attributes["COLOR_0"] = 2
    gltf = {
        "asset": {"version": "2.0", "generator": "Forma"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": "Forma", "mesh": 0}],
        "meshes": [{"name": "Forma", "primitives": [
            {"attributes": attributes, "indices": 0, "material": 0, "mode": 4}]}],
        "materials": [{"name": "Forma", "pbrMetallicRoughness": {
            "baseColorFactor": [1.0, 1.0, 1.0, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.5}}],
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(blob)}],
    }
    head = _pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    total = 12 + 8 + len(head) + 8 + len(blob)
    return b"".join([struct.pack("<4sII", b"glTF", 2, total),
                     struct.pack("<I4s", len(head), b"JSON"), head,
                     struct.pack("<I4s", len(blob), b"BIN\0"), bytes(blob)])


def write_glb(mesh: trimesh.Trimesh, path: Path, progress: Progress = _noop) -> None:
    progress(0.1)
    Path(path).write_bytes(print_glb(mesh))
    progress(1.0)


WRITERS = {"stl": write_stl, "3mf": write_3mf, "obj": write_obj, "glb": write_glb}


# -- checks -------------------------------------------------------------------------------------


def _fail(fmt: str, why: str) -> ExportError:
    return ExportError(f"Il file {LABELS[fmt]} non ha superato il controllo ({why}): non te lo do corrotto.")


def _count_prefixed(path: Path, prefixes: tuple[bytes, ...], progress: Progress,
                    reader=None, size: int | None = None) -> dict[bytes, int]:
    """How many lines start with each prefix, reading BLOCK bytes at a time. Every line start is
    counted as "newline + prefix": the newline before the last, unfinished line of a block is
    carried into the next block with it, so a line split between two blocks counts once."""
    counts = dict.fromkeys(prefixes, 0)
    size = size or os.path.getsize(path)
    done, carry = 0, b"\n"  # the file's first line starts a line too
    with (reader or open(path, "rb")) as f:
        while block := f.read(BLOCK):
            done += len(block)
            data = carry + block
            cut = data.rfind(b"\n")
            whole, carry = data[:cut], data[cut:]
            for p in prefixes:
                counts[p] += whole.count(b"\n" + p)
            progress(min(done / size, 1.0))
    for p in prefixes:  # the line after the last newline (the last line, or nothing)
        counts[p] += carry.startswith(b"\n" + p)
    return counts


def _last_line(path: Path) -> bytes:
    with open(path, "rb") as f:
        f.seek(max(0, os.path.getsize(path) - 4096))
        return f.read().rstrip(b"\n").rsplit(b"\n", 1)[-1]


def verify_export(path: Path, fmt: str, mesh: trimesh.Trimesh, progress: Progress = _noop) -> None:
    """Read ``path`` back and check it is ``mesh`` written whole, or raise ExportError."""
    path = Path(path)
    n, nv = len(mesh.faces), len(mesh.vertices)
    if not path.is_file() or path.stat().st_size == 0:
        raise _fail(fmt, "file vuoto")
    faces = np.asarray(mesh.faces)
    if fmt == "stl":
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(80)
            (count,) = struct.unpack("<I", f.read(4))
            if count != n or size != 84 + 50 * n:
                raise _fail(fmt, f"{count:,} triangoli e {size:,} byte, attesi {n:,}")
            for i in (0, n - 1):
                f.seek(84 + 50 * i + 12)
                tri = np.frombuffer(f.read(36), "<f4").reshape(3, 3)
                if not np.allclose(tri, mesh.vertices[faces[i]], atol=1e-3):
                    raise _fail(fmt, f"triangolo {i + 1} diverso dal modello")
        progress(1.0)
    elif fmt == "obj":
        counts = _count_prefixed(path, (b"v ", b"f "), progress)
        if counts[b"v "] != nv or counts[b"f "] != n:
            raise _fail(fmt, f"{counts[b'v ']:,} vertici e {counts[b'f ']:,} triangoli, attesi {nv:,} e {n:,}")
        last = [int(x) for x in _last_line(path).split()[1:4]]
        if last != (faces[-1] + 1).tolist():
            raise _fail(fmt, "l'ultimo triangolo non corrisponde: file troncato")
    elif fmt == "3mf":
        try:
            with zipfile.ZipFile(path) as z:
                bad = z.testzip()  # reads every part and checks its CRC
                if bad is not None:
                    raise _fail(fmt, f"CRC errato in {bad}")
                progress(0.5)
                info = z.getinfo("3D/3dmodel.model")
                counts = _count_prefixed(path, (b"<vertex ", b"<triangle "),
                                         lambda f: progress(0.5 + 0.5 * f), z.open(info), info.file_size)
                with z.open(info) as part:
                    part.seek(max(0, info.file_size - 256))
                    ending = part.read()
        except (zipfile.BadZipFile, KeyError, zlib.error, EOFError) as exc:
            raise _fail(fmt, f"archivio illeggibile: {exc}") from exc
        if counts[b"<vertex "] != nv or counts[b"<triangle "] != n:
            raise _fail(fmt, f"{counts[b'<vertex ']:,} vertici e {counts[b'<triangle ']:,} triangoli, "
                             f"attesi {nv:,} e {n:,}")
        if not ending.rstrip().endswith(b"</model>"):
            raise _fail(fmt, "il modello non si chiude: file troncato")
    elif fmt == "glb":
        data = path.read_bytes()
        if data[:4] != b"glTF" or struct.unpack("<I", data[8:12])[0] != len(data):
            raise _fail(fmt, "intestazione o lunghezza errata")
        progress(0.4)
        try:
            back = trimesh.load(path, file_type="glb", force="mesh", process=False)
        except Exception as exc:  # noqa: BLE001 - whatever stops a reader stops the slicer
            raise _fail(fmt, f"illeggibile: {exc}") from exc
        if len(back.faces) != n:
            raise _fail(fmt, f"{len(back.faces):,} triangoli, attesi {n:,}")
        progress(1.0)
    else:
        raise ValueError(f"Formato non supportato: {fmt}")


def write_export(mesh: trimesh.Trimesh, fmt: str, path: Path,
                 on_write: Progress = _noop, on_check: Progress = _noop) -> None:
    """Write ``mesh`` as ``fmt`` to ``path`` and check it; on any failure no file is left."""
    if fmt not in WRITERS:
        raise ValueError(f"Formato non supportato: {fmt}")
    try:
        WRITERS[fmt](mesh, path, on_write)
        verify_export(path, fmt, mesh, on_check)
    except BaseException:
        Path(path).unlink(missing_ok=True)
        raise


def export_mesh(mesh: trimesh.Trimesh, fmt: str) -> tuple[bytes, str, str]:
    """Return (bytes, mime type, extension): written, checked, read back."""
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise ValueError(f"Formato non supportato: {fmt}")
    mime, ext = FORMATS[fmt]
    with tempfile.TemporaryDirectory(prefix="forma-export-") as tmp:
        path = Path(tmp) / f"model.{ext}"
        write_export(mesh, fmt, path)
        return path.read_bytes(), mime, ext
