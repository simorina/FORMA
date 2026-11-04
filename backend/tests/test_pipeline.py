import numpy as np
import pytest
import trimesh

from app.pipeline import PLA_DENSITY, PrintSettings, process_mesh
from app.pipeline.process import Y_UP_TO_Z_UP, orient_flat, to_z_up
from app.pipeline.repair import make_watertight, voxel_remesh
from app.pipeline.report import overhang_fraction, printability_report


def test_scale_to_target_and_drop_to_bed():
    box = trimesh.creation.box((2, 1, 0.5))
    box.apply_translation([5, 5, 5])
    res = process_mesh(box, PrintSettings(target_size_mm=80))
    lo, hi = res.mesh.bounds
    assert pytest.approx(res.mesh.extents.max(), rel=1e-6) == 80
    assert pytest.approx(lo[2], abs=1e-6) == 0
    assert pytest.approx((lo[0] + hi[0]) / 2, abs=1e-6) == 0
    assert pytest.approx((lo[1] + hi[1]) / 2, abs=1e-6) == 0


def test_report_volume_and_grams():
    cube = trimesh.creation.box((1, 1, 1))
    res = process_mesh(cube, PrintSettings(target_size_mm=20))
    r = res.report
    assert r["watertight"] and r["manifold"]
    assert r["volume_cm3"] == pytest.approx(8.0, rel=1e-3)
    assert r["pla_grams"] == pytest.approx(8.0 * PLA_DENSITY, rel=1e-2)
    assert r["bbox_mm"] == [20.0, 20.0, 20.0]
    assert r["triangles"] == 12
    assert r["pla_grams_typical"] < r["pla_grams"]


def test_repairs_holes_and_debris():
    s = trimesh.creation.icosphere(subdivisions=3)
    s.update_faces(np.arange(len(s.faces)) != 7)  # punch a hole
    assert not s.is_watertight
    debris = trimesh.creation.box((0.01, 0.01, 0.01))
    debris.apply_translation([3, 0, 0])
    res = process_mesh(trimesh.util.concatenate([s, debris]), PrintSettings(target_size_mm=50))
    assert res.mesh.is_watertight
    assert res.report["components"] == 1
    assert any("frammento" in step for step in res.report["repairs"])


def test_voxel_remesh_closes_large_gap():
    s = trimesh.creation.icosphere(subdivisions=3)
    s.apply_scale(10)
    s.update_faces(np.arange(len(s.faces)) % 97 != 0)  # many small holes
    out = voxel_remesh(s, 64)
    assert out.is_watertight
    assert out.volume == pytest.approx(s.convex_hull.volume, rel=0.15)


def test_non_manifold_edge_is_fixed():
    a = trimesh.creation.box()
    b = trimesh.creation.box()
    b.apply_translation([1, 1, 0])
    fixed, steps = make_watertight(trimesh.util.concatenate([a, b]))
    assert fixed.is_watertight
    assert steps


def test_fix_inverted_normals():
    box = trimesh.creation.box()
    box.invert()
    res = process_mesh(box, PrintSettings(target_size_mm=10))
    assert res.mesh.volume > 0


def test_hollow_keeps_wall_thickness():
    sphere = trimesh.creation.icosphere(subdivisions=4)
    res = process_mesh(sphere, PrintSettings(target_size_mm=60, hollow=True, wall_mm=3))
    solid = 4 / 3 * np.pi * 30**3 / 1000
    shell = (4 / 3 * np.pi * (30**3 - 27**3)) / 1000
    assert res.report["hollowed"]
    assert res.mesh.is_watertight
    assert res.report["volume_cm3"] < solid * 0.5
    assert res.report["volume_cm3"] == pytest.approx(shell, rel=0.3)


def test_base_plate_widens_footprint():
    cone = trimesh.creation.cone(radius=0.5, height=2)
    cone.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))  # tip down
    res = process_mesh(cone, PrintSettings(target_size_mm=40, base_plate=True,
                                           base_thickness_mm=2, base_margin_mm=4))
    assert res.mesh.is_watertight
    z0 = res.mesh.vertices[:, 2]
    footprint = res.mesh.vertices[z0 < 0.01]
    assert np.ptp(footprint[:, 0]) >= 7.9  # tip widened by 2 x 4 mm margin
    assert res.report["base_plate"]


def test_decimation_respects_target():
    sphere = trimesh.creation.icosphere(subdivisions=6)  # 81920 faces
    res = process_mesh(sphere, PrintSettings(target_faces=10_000))
    assert res.report["triangles"] <= 10_500
    assert res.mesh.is_watertight


def test_orient_flat_puts_largest_face_down():
    slab = trimesh.creation.box((10, 1, 5))  # largest faces have normal ±Y
    out = orient_flat(slab)
    assert out.extents[2] == pytest.approx(1, abs=1e-6)


def test_y_up_conversion():
    m = trimesh.Trimesh([[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, 1, 2]], process=False)
    z = to_z_up(m, "y")
    assert np.allclose(z.vertices[0], [0, 0, 1])
    assert np.allclose(Y_UP_TO_Z_UP[:3, :3] @ [0, 0, 1], [0, -1, 0])


def test_overhang_detection():
    # Mushroom: wide cap on a thin stem -> big downward-facing area.
    stem = trimesh.creation.cylinder(radius=2, height=10)
    stem.apply_translation([0, 0, 5])
    cap = trimesh.creation.cylinder(radius=10, height=2)
    cap.apply_translation([0, 0, 11])
    mush = trimesh.util.concatenate([stem, cap])
    assert overhang_fraction(mush) > 0.1
    report = printability_report(mush)
    assert report["overhang_warning"]
    assert overhang_fraction(trimesh.creation.box((10, 10, 10))) == 0


def test_settings_from_dict_coerces_and_clamps():
    s = PrintSettings.from_dict({"target_size_mm": "1000", "hollow": "true", "wall_mm": 0.1,
                                 "orientation": "weird", "unknown": 1})
    assert s.target_size_mm == 500
    assert s.hollow is True
    assert s.wall_mm == 0.8
    assert s.orientation == "upright"


def test_empty_mesh_rejected():
    with pytest.raises(ValueError):
        process_mesh(trimesh.Trimesh())
