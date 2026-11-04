import math

import numpy as np
import pytest
import trimesh

from app.pipeline import PLA_DENSITY, PrintSettings, process_mesh
from app.pipeline.process import Y_UP_TO_Z_UP, level_upright, orient_flat, to_z_up
from app.pipeline.repair import (
    analyze_shells,
    count_bodies,
    make_watertight,
    voxel_remesh,
    winding_number,
)
from app.pipeline.report import overhang_fraction, printability_report


def hollow_box(outer=40.0, wall=4.0):
    """Closed box with an inward-facing cavity, like a hollowed print."""
    box = trimesh.creation.box((outer,) * 3)
    cavity = trimesh.creation.box((outer - 2 * wall,) * 3)
    cavity.invert()
    return trimesh.util.concatenate([box, cavity])


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


@pytest.mark.parametrize("bad", [{"target_faces": "abc"}, {"target_size_mm": float("nan")},
                                 {"wall_mm": float("inf")}, {"target_size_mm": True}])
def test_settings_from_dict_rejects_garbage(bad):
    with pytest.raises(ValueError, match="Impostazione non valida"):
        PrintSettings.from_dict(bad)


def test_settings_accept_numeric_strings():
    s = PrintSettings.from_dict({"target_faces": "12000.0", "base_plate": "on"})
    assert s.target_faces == 12000 and s.base_plate is True


def test_winding_number_inside_outside():
    tris = trimesh.creation.box((2, 2, 2)).triangles
    assert winding_number(np.zeros(3), tris) == pytest.approx(1.0, abs=1e-6)
    assert winding_number(np.array([5.0, 0, 0]), tris) == pytest.approx(0.0, abs=1e-6)


def test_shell_nesting_and_bodies():
    hb = hollow_box()
    shells = sorted(analyze_shells(hb), key=lambda s: s.depth)
    assert [s.depth for s in shells] == [0, 1]
    assert shells[0].volume > 0 > shells[1].volume
    assert count_bodies(hb) == 1
    other = trimesh.creation.box()
    other.apply_translation([3, 0, 0])
    two = trimesh.util.concatenate([trimesh.creation.box(), other])
    assert count_bodies(two) == 2


def test_cleanup_keeps_cavity_and_fixes_inverted_hollow():
    hb = hollow_box()
    res = process_mesh(hb, PrintSettings(target_size_mm=40))
    expected = (40**3 - 32**3) / 1000
    assert res.report["volume_cm3"] == pytest.approx(expected, rel=1e-3)
    assert res.report["components"] == 1
    hb.invert()  # both shells flipped: outer inward, cavity outward
    res = process_mesh(hb, PrintSettings(target_size_mm=40))
    assert res.report["volume_cm3"] == pytest.approx(expected, rel=1e-3)


def test_reprocessing_a_hollowed_model_keeps_it_hollow():
    sphere = trimesh.creation.icosphere(subdivisions=4)
    hollowed = process_mesh(sphere, PrintSettings(target_size_mm=60, hollow=True, wall_mm=3))
    assert hollowed.report["components"] == 1
    again = process_mesh(hollowed.mesh.copy(), PrintSettings(target_size_mm=60))
    assert again.report["volume_cm3"] == pytest.approx(hollowed.report["volume_cm3"], rel=0.03)


def test_hollow_does_not_breach_narrow_crevices():
    """A 0.5 mm slot, 25 mm deep: the cavity must keep its wall around the slot too
    (sizing it on the voxel-closed solid used to cut straight into the slot)."""
    from app.pipeline.process import hollow
    from app.pipeline.repair import from_manifold, to_manifold

    block = trimesh.creation.box((60, 60, 60))
    slot = trimesh.creation.box((0.5, 40, 25))
    slot.apply_translation([0, 0, 30 - 12.5 + 0.01])
    slotted = from_manifold(to_manifold(block) - to_manifold(slot))
    out = hollow(slotted, 2.0)
    assert out is not None and out.is_watertight
    shells = analyze_shells(out)
    assert len(shells) == 2  # outer skin + one sealed cavity
    assert sorted(s.depth for s in shells) == [0, 1]


def test_base_plate_stays_within_target_size():
    cyl = trimesh.creation.cylinder(radius=10, height=100)
    res = process_mesh(cyl, PrintSettings(target_size_mm=100, base_plate=True))
    assert max(res.report["bbox_mm"]) == pytest.approx(100, abs=0.05)


def test_upright_levels_a_tilted_base():
    box = trimesh.creation.box((30, 20, 50))
    box.apply_transform(trimesh.transformations.rotation_matrix(math.radians(18), [1, 0, 0]))
    levelled, tilt = level_upright(box)
    assert tilt == pytest.approx(18, abs=0.5)
    # minimal rotation: back to the original axes, heading preserved (no spin around Z)
    assert np.allclose(levelled.extents, [30, 20, 50], atol=1e-6)
    res = process_mesh(box, PrintSettings(target_size_mm=50))
    assert res.report["bbox_mm"][2] == pytest.approx(50, abs=1e-3)
    assert any("livellata" in step for step in res.report["repairs"])


def mushroom():
    stem = trimesh.creation.cylinder(radius=2, height=10)
    stem.apply_translation([0, 0, 5])
    cap = trimesh.creation.cylinder(radius=10, height=2)
    cap.apply_translation([0, 0, 11])
    return trimesh.util.concatenate([stem, cap])


def test_min_supports_turns_a_mushroom_onto_its_cap():
    from app.pipeline.process import orient_min_supports

    turned, before, after = orient_min_supports(mushroom())
    assert before > 0.1 and after < 0.02
    # the cap now rests on the bed: the lowest point is the cap's flat top, wide as the cap
    low = turned.vertices[turned.vertices[:, 2] < turned.bounds[0, 2] + 1e-6]
    assert np.ptp(low[:, 0]) == pytest.approx(20, rel=0.05)
    res = process_mesh(mushroom(), PrintSettings(target_size_mm=40, orientation="supports"))
    assert res.report["overhang_pct"] < 2
    assert any("supporti" in step for step in res.report["repairs"])


def test_min_supports_never_turns_a_model_for_nothing():
    from app.pipeline.process import orient_min_supports

    box = trimesh.creation.box((30, 20, 50))  # no overhang standing up
    turned, before, after = orient_min_supports(box)
    assert before == after == 0
    assert np.allclose(turned.extents, [30, 20, 50])


def test_upright_leaves_round_and_steep_shapes_alone():
    _, tilt = level_upright(trimesh.creation.icosphere(subdivisions=3))
    assert tilt == 0
    box = trimesh.creation.box((30, 20, 50))
    box.apply_transform(trimesh.transformations.rotation_matrix(math.radians(45), [1, 0, 0]))
    _, tilt = level_upright(box)  # every face is 45° off: a pose, not a tilt, keep it
    assert tilt == 0
    keep = process_mesh(box, PrintSettings(orientation="keep"))
    assert not any("livellata" in step for step in keep.report["repairs"])
