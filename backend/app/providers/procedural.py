"""Offline provider: parametric printable shapes chosen from prompt keywords.

It needs no network, no GPU and no token, so it powers the tests and lets the
whole app be tried end-to-end before an HF_TOKEN is configured.
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Callable

import manifold3d as mf
import numpy as np
import trimesh
from PIL import Image

from ..render import render_preview
from .base import GenerationResult, GenParams, ModelInfo, ProgressFn, Provider

Shape = Callable[[np.random.Generator], mf.Manifold]


def _to_trimesh(m: mf.Manifold) -> trimesh.Trimesh:
    mesh = m.to_mesh()
    verts = np.asarray(mesh.vert_properties)[:, :3]
    faces = np.asarray(mesh.tri_verts)
    return trimesh.Trimesh(vertices=verts, faces=faces, process=False)


def _lathe(profile: list[tuple[float, float]], segments: int = 96) -> mf.Manifold:
    """Revolve a closed (r, z) polygon around Z."""
    return mf.Manifold.revolve(mf.CrossSection([profile]), circular_segments=segments)


def _smooth_curve(points: list[tuple[float, float]], n: int = 48) -> list[tuple[float, float]]:
    """Catmull-Rom through control points -> dense list."""
    pts = np.asarray(points, dtype=float)
    pts = np.vstack([pts[0], pts, pts[-1]])
    out: list[tuple[float, float]] = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for t in np.linspace(0, 1, n, endpoint=False):
            t2, t3 = t * t, t * t * t
            p = 0.5 * (
                2 * p1
                + (-p0 + p2) * t
                + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
            )
            out.append((float(p[0]), float(p[1])))
    out.append((float(pts[-2][0]), float(pts[-2][1])))
    return out


def vase(rng: np.random.Generator) -> mf.Manifold:
    h = 120.0
    belly = rng.uniform(30, 40)
    neck = rng.uniform(14, 20)
    lip = neck + rng.uniform(4, 9)
    ctrl = [(22, 0), (belly, h * 0.32), (neck, h * 0.78), (lip, h)]
    outer = _smooth_curve(ctrl)
    wall, base = 2.4, 3.0
    inner = [(max(r - wall, 1.0), z) for r, z in outer if z >= base]
    profile = [(0.0, 0.0)] + outer + list(reversed(inner)) + [(0.0, base)]
    return _lathe(profile, 128)


def cup(rng: np.random.Generator) -> mf.Manifold:
    r, h, wall = rng.uniform(36, 42), 90.0, 3.0
    body = mf.Manifold.cylinder(h, r, r, 128) - mf.Manifold.cylinder(h, r - wall, r - wall, 128).translate(
        [0, 0, 4.0]
    )
    handle = mf.Manifold.revolve(
        mf.CrossSection.circle(5.5, 32).translate([24, 0]), circular_segments=64
    )
    handle = handle.rotate([90, 0, 0]).translate([r + 6, 0, h * 0.5])
    handle = handle - mf.Manifold.cylinder(h, r - 1, r - 1, 128)
    return body + handle


def pawn(rng: np.random.Generator) -> mf.Manifold:
    ctrl = [(0.01, 0), (16, 0), (16, 4), (12, 7), (8, 20), (6, 34), (10, 37), (5.5, 40)]
    body = _smooth_curve(ctrl, 16) + [(0.01, 40.0)]
    head = mf.Manifold.sphere(9.5, 64).translate([0, 0, 48])
    return _lathe(body, 96) + head


def sphere(rng: np.random.Generator) -> mf.Manifold:
    return mf.Manifold.sphere(40, 128).translate([0, 0, 40]) + mf.Manifold.cylinder(
        6, 18, 22, 96
    )


def rounded_box(rng: np.random.Generator) -> mf.Manifold:
    s, r = 30.0, rng.uniform(5, 9)
    corners = [
        mf.Manifold.sphere(r, 32).translate([x * (s - r), y * (s - r), z * (s - r)])
        for x in (-1, 1)
        for y in (-1, 1)
        for z in (-1, 1)
    ]
    return mf.Manifold.batch_hull(corners)


def cylinder(rng: np.random.Generator) -> mf.Manifold:
    return mf.Manifold.cylinder(80, 25, 25, 128)


def cone(rng: np.random.Generator) -> mf.Manifold:
    return mf.Manifold.cylinder(90, 35, 0.0, 128)


def pyramid(rng: np.random.Generator) -> mf.Manifold:
    return mf.Manifold.cylinder(70, 55, 0.0, 4).rotate([0, 0, 45])


def torus(rng: np.random.Generator) -> mf.Manifold:
    R, r = 32.0, rng.uniform(10, 14)
    return mf.Manifold.revolve(mf.CrossSection.circle(r, 64).translate([R, 0]), circular_segments=128)


def _star_polygon(points: int, r_out: float, r_in: float) -> list[tuple[float, float]]:
    out = []
    for i in range(points * 2):
        a = math.pi / 2 + i * math.pi / points
        r = r_out if i % 2 == 0 else r_in
        out.append((r * math.cos(a), r * math.sin(a)))
    return out


def star(rng: np.random.Generator) -> mf.Manifold:
    cs = mf.CrossSection([_star_polygon(5, 45, 19)]).offset(2.0, mf.JoinType.Round)
    return mf.Manifold.extrude(cs, 12.0, scale_top=[0.82, 0.82])


def heart(rng: np.random.Generator) -> mf.Manifold:
    t = np.linspace(0, 2 * math.pi, 200, endpoint=False)
    x = 16 * np.sin(t) ** 3
    y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
    pts = list(zip((x * 2.6).tolist(), (y * 2.6).tolist(), strict=False))[::-1]
    cs = mf.CrossSection([pts])
    return mf.Manifold.extrude(cs, 14.0, scale_top=[0.9, 0.9])


def gear(rng: np.random.Generator) -> mf.Manifold:
    teeth = int(rng.integers(14, 22))
    r_root, r_tip = 36.0, 42.0
    pts = []
    for i in range(teeth):
        for f, r in ((0.0, r_root), (0.18, r_tip), (0.5, r_tip), (0.68, r_root)):
            a = 2 * math.pi * (i + f) / teeth
            pts.append((r * math.cos(a), r * math.sin(a)))
    cs = mf.CrossSection([pts]) - mf.CrossSection.circle(8, 64)
    body = mf.Manifold.extrude(cs, 10.0)
    hub = mf.Manifold.cylinder(16, 14, 14, 96) - mf.Manifold.cylinder(16, 8, 8, 64)
    return body + hub


def tower(rng: np.random.Generator) -> mf.Manifold:
    r, h = 24.0, 90.0
    body = mf.Manifold.cylinder(h, r + 2, r, 96)
    top = mf.Manifold.cylinder(14, r + 6, r + 6, 96).translate([0, 0, h])
    top = top - mf.Manifold.cylinder(14, r + 1, r + 1, 96).translate([0, 0, h + 4])
    for i in range(8):
        a = i * 45.0
        notch = mf.Manifold.cube([10, 2 * r + 20, 8], center=True).rotate([0, 0, a]).translate(
            [0, 0, h + 12]
        )
        top = top - notch
    door = mf.Manifold.cube([12, 10, 22], center=True).translate([0, -r, 11])
    return (body + top) - door


def house(rng: np.random.Generator) -> mf.Manifold:
    w, d, h = 60.0, 45.0, 40.0
    walls = mf.Manifold.cube([w, d, h], center=False).translate([-w / 2, -d / 2, 0])
    roof_cs = mf.CrossSection([[(-d / 2 - 4, 0), (d / 2 + 4, 0), (0, 28)]])
    roof = mf.Manifold.extrude(roof_cs, w + 6).rotate([90, 0, 90]).translate([-(w + 6) / 2, 0, h])
    chimney = mf.Manifold.cube([8, 8, 22]).translate([w / 4, d / 8, h + 6])
    door = mf.Manifold.cube([12, 6, 22]).translate([-6, -d / 2 - 1, 0])
    return (walls + roof + chimney) - door


def rocket(rng: np.random.Generator) -> mf.Manifold:
    ctrl = [(0.01, 6), (14, 6), (16, 30), (15, 70), (9, 95), (0.01, 112)]
    body = _lathe(_smooth_curve(ctrl, 20), 96)
    fin_cs = mf.CrossSection([[(0, 0), (30, 0), (14, 34), (0, 40)]])
    fins = [
        mf.Manifold.extrude(fin_cs, 3.0).translate([0, 0, -1.5]).rotate([90, 0, 0]).rotate([0, 0, a])
        for a in (0, 120, 240)
    ]
    nozzle = mf.Manifold.cylinder(8, 8, 11, 64)
    return mf.Manifold.batch_boolean([body, nozzle, *fins], mf.OpType.Add)


def pen_holder(rng: np.random.Generator) -> mf.Manifold:
    outer = mf.Manifold.cylinder(95, 38, 34, 6)
    inner = mf.Manifold.cylinder(95, 34.5, 30.5, 6).translate([0, 0, 4])
    return (outer - inner).rotate([0, 0, 30])


def keychain(rng: np.random.Generator) -> mf.Manifold:
    plate = mf.CrossSection.square([60, 30], center=True).offset(6, mf.JoinType.Round)
    plate = plate - mf.CrossSection.circle(4, 48).translate([-28, 0])
    return mf.Manifold.extrude(plate, 4.0)


def organic(rng: np.random.Generator) -> mf.Manifold:
    """Smooth abstract sculpture: a sphere with seeded low-frequency displacement."""
    phases = rng.uniform(0, 2 * math.pi, size=6)
    freqs = rng.integers(2, 5, size=6)

    def warp(v: np.ndarray) -> np.ndarray:
        v = np.asarray(v, dtype=float)
        n = v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)
        d = (
            0.18 * np.sin(freqs[0] * n[:, 0] + phases[0]) * np.cos(freqs[1] * n[:, 1] + phases[1])
            + 0.14 * np.sin(freqs[2] * n[:, 2] + phases[2])
            + 0.08 * np.sin(freqs[3] * (n[:, 0] + n[:, 2]) + phases[3])
        )
        return v * (1.0 + d)[:, None]

    base = mf.Manifold.sphere(40, 160).warp_batch(warp)
    stand = mf.Manifold.cylinder(8, 20, 24, 96).translate([0, 0, -44])
    return base.translate([0, 0, 0]) + stand


# Keyword -> shape (Italian + English). First match wins.
SHAPES: list[tuple[tuple[str, ...], str, Shape]] = [
    (("vaso", "vase", "anfora"), "vaso", vase),
    (("tazza", "mug", "cup", "tazzina"), "tazza", cup),
    (("pedone", "pawn", "scacch", "chess"), "pedone", pawn),
    (("ingranagg", "gear", "cog"), "ingranaggio", gear),
    (("stella", "star"), "stella", star),
    (("cuore", "heart"), "cuore", heart),
    (("torre", "tower", "castell", "castle"), "torre", tower),
    (("casa", "house", "casetta", "home"), "casetta", house),
    (("razzo", "rocket", "missile"), "razzo", rocket),
    (("portapenne", "pen holder", "pencil", "matite"), "portapenne", pen_holder),
    (("portachiavi", "keychain", "key chain", "targhetta"), "portachiavi", keychain),
    (("ciambella", "donut", "doughnut", "toro", "torus", "anello", "ring"), "toro", torus),
    (("piramide", "pyramid"), "piramide", pyramid),
    (("cono", "cone"), "cono", cone),
    (("cilindro", "cylinder", "tubo"), "cilindro", cylinder),
    (("cubo", "cube", "scatola", "box", "dado", "dice"), "cubo", rounded_box),
    (("sfera", "sphere", "palla", "ball", "globo", "orb"), "sfera", sphere),
]


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def pick_shape(prompt: str) -> tuple[str, Shape]:
    text = _normalize(prompt or "")
    for keywords, label, fn in SHAPES:
        for kw in keywords:
            if re.search(r"\b" + re.escape(kw), text):
                return label, fn
    return "scultura organica", organic


def _seed_for(prompt: str, seed: int) -> int:
    digest = hashlib.sha256(f"{prompt}|{seed}".encode()).digest()
    return int.from_bytes(digest[:8], "little")


class ProceduralProvider(Provider):
    name = "procedural"
    label = "Procedurale (offline)"
    description = (
        "Forme parametriche dalle parole chiave del prompt. Funziona senza rete, GPU o token: "
        "ideale per provare l'app e per i test."
    )

    def models(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                key="parametric",
                label="Parametrico",
                description="Vaso, tazza, pedone, ingranaggio, stella, cuore, torre, razzo…",
                license="MIT (codice di questo progetto)",
                default=True,
            )
        ]

    def generate(self, prompt, image, params: GenParams, progress: ProgressFn = lambda *a: None):
        text = prompt or ""
        if not text and image is not None:
            text = "scultura"
        label, fn = pick_shape(text)
        rng = np.random.default_rng(_seed_for(text, params.seed))
        progress("image", 0.5, "Anteprima procedurale")
        progress("shape", 0.2, f"Costruisco: {label}")
        solid = fn(rng)
        mesh = _to_trimesh(solid)
        progress("shape", 1.0, f"Forma: {label}")
        preview: Image.Image = render_preview(mesh, up="z")
        return GenerationResult(
            mesh=mesh, image=preview, model="parametric", meta={"shape": label, "up": "z"}
        )
