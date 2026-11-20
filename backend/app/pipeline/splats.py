"""3D Gaussians (a splat, what Idol makes) -> a closed, coloured surface to print.

A splat has no surface: only Gaussians that, seen together, look like one. Their density
(opacity times each Gaussian's bell) is summed on a grid. Gaussians sit on the object's skin,
so the dense part is a thin shell: everything it encloses is filled (the same flood fill the
repair uses), and the surface is the shell's outer side, where the density crosses ``level``
(marching cubes on the smooth field, not on blocks of voxels). Every vertex takes the colour
of the Gaussians around it.

Only numpy, scipy and scikit-image: the conversion runs (and is tested) without a GPU.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import trimesh
from scipy.spatial import cKDTree

from .colors import with_colors
from .repair import fill_surface

SH_C0 = 0.28209479177387814  # degree-0 spherical harmonic: colour = 0.5 + C0 * f_dc


@dataclass
class Splats:
    xyz: np.ndarray  # (n, 3) centres
    scales: np.ndarray  # (n, 3) standard deviation along each of the Gaussian's own axes
    rotations: np.ndarray  # (n, 4) quaternions (w, x, y, z)
    opacity: np.ndarray  # (n,) 0..1
    colors: np.ndarray  # (n, 3) uint8 RGB

    def __len__(self) -> int:
        return len(self.xyz)


def sh_to_rgb(features_dc: np.ndarray) -> np.ndarray:
    """(n, 3) degree-0 spherical harmonics -> (n, 3) uint8 RGB."""
    rgb = 0.5 + SH_C0 * np.asarray(features_dc, dtype=np.float32).reshape(-1, 3)
    return (np.clip(rgb, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _rotations(q: np.ndarray) -> np.ndarray:
    """(n, 4) quaternions (w, x, y, z), not necessarily unit -> (n, 3, 3) rotation matrices."""
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    w, x, y, z = q.T
    return np.stack([
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ], axis=1).reshape(-1, 3, 3)


def density_grid(
    s: Splats, resolution: int, min_opacity: float = 0.02, max_radius: int = 6,
    chunk_samples: int = 4_000_000, gpu: bool = True,
) -> tuple[np.ndarray, np.ndarray, float]:
    """The summed density on a grid with ``resolution`` cells along the longest side:
    (float32 grid, origin, cell size); sample (i, j, k) is at ``origin + (i, j, k) * cell``.

    Each Gaussian is widened by half a cell (as a 3D anti-aliasing filter does): a flat
    Gaussian thinner than a cell would otherwise fall between the samples and leave holes."""
    keep = s.opacity >= min_opacity
    xyz = s.xyz[keep].astype(np.float64)
    opacity = s.opacity[keep].astype(np.float32)
    scales = s.scales[keep].astype(np.float64)
    lo, hi = xyz.min(axis=0), xyz.max(axis=0)
    cell = float((hi - lo).max()) / resolution or 1.0
    pad = max_radius + 2
    origin = lo - pad * cell
    shape = np.ceil((hi - lo) / cell).astype(int) + 2 * pad + 1

    widen = (0.5 * cell) ** 2
    rot = _rotations(s.rotations[keep].astype(np.float64))
    cov = np.einsum("nij,nj,nkj->nik", rot, scales**2, rot) + widen * np.eye(3)
    precision = np.linalg.inv(cov).astype(np.float32)
    reach = 3.0 * np.sqrt(scales.max(axis=1) ** 2 + widen)  # 3 sigma along the widest axis
    radius = np.clip(np.ceil(reach / cell), 1, max_radius).astype(int)
    centre = np.round((xyz - origin) / cell).astype(np.int64)

    groups = []  # (offsets, members): Gaussians reaching the same number of cells
    for r in np.unique(radius):
        span = np.arange(-r, r + 1)
        offsets = np.stack(np.meshgrid(span, span, span, indexing="ij"), axis=-1).reshape(-1, 3)
        groups.append((offsets, np.nonzero(radius == r)[0]))
    args = (groups, centre, xyz, precision, opacity, origin, cell, shape, chunk_samples)
    flat = _accumulate_gpu(*args) if gpu else None
    if flat is None:
        flat = _accumulate(*args)
    return flat.reshape(shape), origin, cell


def _accumulate(groups, centre, xyz, precision, opacity, origin, cell, shape, chunk_samples):
    flat = np.zeros(int(np.prod(shape)), dtype=np.float32)
    strides = np.array([shape[1] * shape[2], shape[2], 1], dtype=np.int64)
    for offsets, members in groups:
        step = max(1, chunk_samples // len(offsets))
        for start in range(0, len(members), step):
            g = members[start:start + step]
            cells = centre[g][:, None, :] + offsets[None, :, :]  # (c, K, 3)
            d = (origin + cells * cell - xyz[g][:, None, :]).astype(np.float32)
            w = opacity[g][:, None] * np.exp(-0.5 * ((d @ precision[g]) * d).sum(axis=-1))
            hit = w > 1e-3
            np.add.at(flat, cells[hit] @ strides, w[hit])
    return flat


def _accumulate_gpu(groups, centre, xyz, precision, opacity, origin, cell, shape, chunk_samples):
    """The same sums on a CUDA GPU with PyTorch (~50x faster); None when there is none."""
    try:
        import torch
    except ImportError:
        return None
    if not torch.cuda.is_available():
        return None
    dev = torch.device("cuda")
    flat = torch.zeros(int(np.prod(shape)), dtype=torch.float32, device=dev)
    strides = torch.tensor([shape[1] * shape[2], shape[2], 1], dtype=torch.int64, device=dev)
    centre_t = torch.from_numpy(centre).to(dev)
    xyz_t = torch.from_numpy((xyz - origin).astype(np.float32)).to(dev)  # small numbers: float32 is exact enough
    prec_t, op_t = torch.from_numpy(precision).to(dev), torch.from_numpy(opacity).to(dev)
    with torch.no_grad():
        for offsets, members in groups:
            off = torch.from_numpy(offsets).to(dev)
            step = max(1, chunk_samples // len(offsets))
            for start in range(0, len(members), step):
                g = torch.from_numpy(members[start:start + step]).to(dev)
                cells = centre_t[g][:, None, :] + off[None, :, :]
                d = cells.to(torch.float32) * cell - xyz_t[g][:, None, :]
                w = op_t[g][:, None] * torch.exp(-0.5 * ((d @ prec_t[g]) * d).sum(dim=-1))
                hit = w > 1e-3
                flat.index_add_(0, (cells[hit] * strides).sum(dim=-1), w[hit])
        out = flat.cpu().numpy()
    del flat
    torch.cuda.empty_cache()
    return out


def _vertex_colors(s: Splats, vertices: np.ndarray, cell: float, k: int = 8) -> np.ndarray:
    """RGBA per vertex: the colours of the k nearest visible Gaussians, weighted by opacity
    and by how close they are (on the scale of a cell)."""
    seen = s.opacity >= 0.1
    if seen.sum() < k:
        seen = np.ones(len(s), dtype=bool)
    tree = cKDTree(s.xyz[seen])
    dist, idx = tree.query(vertices, k=min(k, int(seen.sum())), workers=-1)
    dist, idx = dist.reshape(len(vertices), -1), idx.reshape(len(vertices), -1)
    weight = s.opacity[seen][idx] * np.exp(-0.5 * (dist / (2.0 * cell)) ** 2) + 1e-6
    rgb = (s.colors[seen][idx].astype(np.float32) * weight[..., None]).sum(axis=1) / weight.sum(axis=1)[:, None]
    out = np.full((len(vertices), 4), 255, dtype=np.uint8)
    out[:, :3] = np.clip(rgb + 0.5, 0, 255).astype(np.uint8)
    return out


def splats_to_mesh(s: Splats, resolution: int = 512, level: float = 0.5,
                   smooth: int = 10) -> trimesh.Trimesh:
    """A closed surface around the splat, in the splat's own frame and units, with vertex
    colours. ``level``: the density taken as the object's skin; ``smooth``: Taubin passes."""
    from skimage import measure

    if len(s) == 0:
        raise ValueError("Lo splat è vuoto.")
    density, origin, cell = density_grid(s, resolution)
    skin = density >= level
    if not skin.any():
        raise ValueError("Lo splat è troppo rado per farne un solido.")
    inside = fill_surface(skin) & ~skin
    # 0.5 where the density crosses ``level``, 1 at twice it and in everything the skin encloses
    field = np.minimum(density / (2.0 * level), 1.0)
    field[inside] = 1.0
    del density, skin, inside
    verts, faces, _, _ = measure.marching_cubes(np.pad(field, 1), level=0.5)
    del field
    verts = (verts - 1.0) * cell + origin
    # As marching cubes gives it: closed and consistently wound. Merging vertices (process=True)
    # would fuse the few that land on the same point from different edges and open it.
    mesh = trimesh.Trimesh(verts, faces, process=False)
    if mesh.volume < 0:
        mesh.invert()
    # Each Gaussian leaves a dimple and the grid leaves ripples: Taubin smoothing takes them
    # off without shrinking the object (checked on Idol's splats: rims and 1 mm rods stay).
    trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=-0.53, iterations=smooth)
    return with_colors(mesh, _vertex_colors(s, np.asarray(mesh.vertices), cell))


def sphere_splats(n: int = 20_000, radius: float = 0.4, seed: int = 0) -> Splats:
    """Flat Gaussians tangent to a sphere, red on top and blue below: a known splat for tests."""
    rng = np.random.default_rng(seed)
    normal = rng.normal(size=(n, 3))
    normal /= np.linalg.norm(normal, axis=1, keepdims=True)
    spacing = math.sqrt(4 * math.pi * radius**2 / n)
    # a rotation taking z to the normal: the Gaussian's thin axis (z) faces outwards
    z = np.array([0.0, 0.0, 1.0])
    axis = np.cross(z, normal)
    sin = np.linalg.norm(axis, axis=1)
    angle = np.arctan2(sin, normal @ z)
    axis = np.where(sin[:, None] > 1e-9, axis / np.maximum(sin, 1e-12)[:, None], [1.0, 0.0, 0.0])
    quat = np.column_stack([np.cos(angle / 2), axis * np.sin(angle / 2)[:, None]])
    colors = np.where(normal[:, 2:3] > 0, [[220, 30, 30]], [[30, 30, 220]]).astype(np.uint8)
    return Splats(
        xyz=normal * radius,
        scales=np.column_stack([np.full(n, spacing), np.full(n, spacing), np.full(n, 0.0009)]),
        rotations=quat,
        opacity=np.full(n, 0.9),
        colors=colors,
    )
