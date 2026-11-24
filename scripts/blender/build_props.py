"""Procedural Blender 5.3+ generator for all 17 Zen garden environment & element props.

All coordinates are local to each prop's `ground-center` origin (`minY = 0`),
matching DESIGN.md Sections 2.3, 3.8, and `assets/models.spec.json`.
"""

from __future__ import annotations

import math
from typing import Any

import bpy

from rm_common import MODELS_OUT_DIR, build_mesh_obj, clear_rm_objects, export_objects_glb

# Rack slot centers from DESIGN.md 4.2 (for placing 2 wooden pegs per rake on UpperRail)
RACK_PEGS_X = [-98.8, -67.4, -34.5, -10.1, 14.8, 38.7, 56.6, 70.0, 85.4, 102.8]


def _build_frame(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    # Four beams 6 wide, top at y = 6, around 192x112 bed -> outer 204x6x124
    parts: list[dict[str, Any]] = [
        {"kind": "box", "size": (204, 6, 6), "center": (0, 3, -59), "mat": 0},
        {"kind": "box", "size": (204, 6, 6), "center": (0, 3, 59), "mat": 0},
        {"kind": "box", "size": (6, 6, 112), "center": (-99, 3, 0), "mat": 0},
        {"kind": "box", "size": (6, 6, 112), "center": (99, 3, 0), "mat": 0},
    ]
    # Bamboo lashings every 32 units along the frame beams
    for lx in (-96, -64, -32, 0, 32, 64, 96):
        parts.append({"kind": "box", "size": (2.0, 6.4, 6.5), "center": (lx, 3.1, -59), "mat": 1})
        parts.append({"kind": "box", "size": (2.0, 6.4, 6.5), "center": (lx, 3.1, 59), "mat": 1})
    for lz in (-32, 0, 32):
        parts.append({"kind": "box", "size": (6.5, 6.4, 2.0), "center": (-99, 3.1, lz), "mat": 1})
        parts.append({"kind": "box", "size": (6.5, 6.4, 2.0), "center": (99, 3.1, lz), "mat": 1})
    return [
        build_mesh_obj(
            scene,
            "Frame",
            parts,
            ["wood", "leaf"],
            smooth=False,
            extras={"part": "frame"},
        )
    ]


def _build_engawa(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    # 380 x 4 x 250 deck centered locally (scene places at x=25, y=-4, z=10 so top is at y=0)
    parts: list[dict[str, Any]] = [
        {"kind": "box", "size": (380, 4, 250), "center": (0, 2, 0), "mat": 0},
    ]
    return [
        build_mesh_obj(
            scene,
            "Engawa",
            parts,
            ["wood"],
            smooth=False,
            extras={"part": "engawa", "cast": False, "line": False},
        )
    ]


def _build_rack(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    # Timber wall (300 wide, 72 high with cap beam), rails, 20 pegs, shelf
    # Origin at ground-center of wall front face; scene places at (20, 0, -74)
    objs: list[bpy.types.Object] = []

    wall_parts: list[dict[str, Any]] = [
        {"kind": "box", "size": (300, 68, 6), "center": (0, 34, -3), "mat": 0},
        {"kind": "box", "size": (300, 4, 10), "center": (0, 70, -2), "mat": 1},
    ]
    # Vertical timber ribs for subtle 3D plank depth
    for px in range(-143, 145, 26):
        wall_parts.append({"kind": "box", "size": (1.0, 67, 0.8), "center": (px, 34, 0.2), "mat": 0})
    objs.append(
        build_mesh_obj(
            scene,
            "Wall",
            wall_parts,
            ["wood", "wood_light"],
            smooth=False,
            extras={"part": "wall", "line": True},
        )
    )

    # Upper rail at y = 49.6 (232 long, offset -20 in local X because wall centers at x=+20)
    upper_parts: list[dict[str, Any]] = [
        {"kind": "box", "size": (232, 3.6, 3.0), "center": (-20, 49.6, 1.5), "mat": 0}
    ]
    for rx in RACK_PEGS_X:
        lx = rx - 20.0
        for dx in (-2.4, 2.4):
            upper_parts.append({"kind": "box", "size": (1.4, 1.4, 9.0), "center": (lx + dx, 48.2, 4.8), "mat": 1})
    objs.append(
        build_mesh_obj(
            scene,
            "UpperRail",
            upper_parts,
            ["wood", "wood_light"],
            smooth=False,
            extras={"part": "rack_upper"},
        )
    )

    objs.append(
        build_mesh_obj(
            scene,
            "LowerRail",
            [{"kind": "box", "size": (232, 3.2, 2.6), "center": (-20, 16.0, 1.3), "mat": 0}],
            ["wood"],
            smooth=False,
            extras={"part": "rack_lower"},
        )
    )

    # Bonsai shelf at world (142, 40) -> local x = 122
    shelf_parts: list[dict[str, Any]] = [
        {"kind": "box", "size": (26, 2.2, 11.0), "center": (122, 40.0, 5.5), "mat": 1},
        {"kind": "box", "size": (2.2, 5.0, 8.0), "center": (113, 36.4, 4.0), "mat": 0},
        {"kind": "box", "size": (2.2, 5.0, 8.0), "center": (131, 36.4, 4.0), "mat": 0},
    ]
    objs.append(
        build_mesh_obj(
            scene,
            "Shelf",
            shelf_parts,
            ["wood", "wood_light"],
            smooth=False,
            extras={"part": "shelf"},
        )
    )

    return objs


def _build_stone(
    scene: bpy.types.Scene,
    rx: float,
    h: float,
    rz: float,
    seed: int,
    moss: bool,
    tag: str,
) -> list[bpy.types.Object]:
    parts: list[dict[str, Any]] = [
        {
            "kind": "ell",
            "radii": (rx, h * 0.56, rz),
            "center": (0, h * 0.44, 0),
            "seg": 8,
            "rings": 5,
            "seed": seed,
            "jxz": 0.14,
            "jy": 0.10,
            "mat": 0,
        },
        # Grounded base skirt so minY sits solidly at 0
        {
            "kind": "prism",
            "r0": min(rx, rz) * 0.85,
            "r1": min(rx, rz) * 0.72,
            "h": h * 0.35,
            "seg": 7,
            "base": (0, 0, 0),
            "mat": 0,
        },
    ]
    ramps = ["stone"]
    if moss:
        ramps.append("leaf")
        parts.append({
            "kind": "ell",
            "radii": (rx * 0.45, h * 0.18, rz * 0.42),
            "center": (-rx * 0.25, h * 0.78, -rz * 0.12),
            "seg": 6,
            "rings": 4,
            "mat": 1,
        })
    return [
        build_mesh_obj(
            scene,
            "Stone",
            parts,
            ramps,
            smooth=False,
            extras={"part": tag},
        )
    ]


def _build_moss(scene: bpy.types.Scene, rx: float, rz: float, seed: int, tag: str) -> list[bpy.types.Object]:
    parts: list[dict[str, Any]] = [
        {
            "kind": "ell",
            "radii": (rx, 1.25, rz),
            "center": (0, 1.25, 0),
            "seg": 10,
            "rings": 5,
            "seed": seed,
            "jxz": 0.08,
            "jy": 0.06,
            "mat": 0,
        },
        {
            "kind": "ell",
            "radii": (rx * 0.55, 1.1, rz * 0.52),
            "center": (rx * 0.26, 1.35, rz * 0.14),
            "seg": 7,
            "rings": 4,
            "mat": 0,
        },
    ]
    return [
        build_mesh_obj(
            scene,
            "Moss",
            parts,
            ["leaf"],
            smooth=False,
            extras={"part": tag, "cast": False},
        )
    ]


def _build_lantern(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    # Traditional stone toro lantern, 10 x 27 x 8
    body_parts: list[dict[str, Any]] = [
        # Base pedestal
        {"kind": "prism", "r0": 4.2, "r1": 3.0, "h": 3.0, "seg": 6, "base": (0, 0, 0), "mat": 0},
        # Pillar
        {"kind": "prism", "r0": 1.7, "r1": 1.5, "h": 11.0, "seg": 6, "base": (0, 3.0, 0), "mat": 0},
        # Mid platform
        {"kind": "prism", "r0": 3.4, "r1": 4.2, "h": 2.2, "seg": 6, "base": (0, 14.0, 0), "mat": 0},
        # Corner posts of firebox
        {"kind": "box", "size": (0.9, 4.8, 0.9), "center": (-2.1, 18.6, -2.1), "mat": 0},
        {"kind": "box", "size": (0.9, 4.8, 0.9), "center": (2.1, 18.6, -2.1), "mat": 0},
        {"kind": "box", "size": (0.9, 4.8, 0.9), "center": (-2.1, 18.6, 2.1), "mat": 0},
        {"kind": "box", "size": (0.9, 4.8, 0.9), "center": (2.1, 18.6, 2.1), "mat": 0},
        # Pagoda roof
        {"kind": "prism", "r0": 5.0, "r1": 1.2, "h": 4.4, "seg": 6, "base": (0, 21.0, 0), "mat": 0},
        # Finial
        {"kind": "ell", "radii": (1.1, 1.3, 1.1), "center": (0, 25.7, 0), "seg": 6, "rings": 4, "mat": 0},
    ]
    lantern_obj = build_mesh_obj(
        scene,
        "Lantern",
        body_parts,
        ["stone"],
        smooth=False,
        extras={"part": "lantern"},
    )
    window_obj = build_mesh_obj(
        scene,
        "Window",
        [{"kind": "box", "size": (3.2, 4.0, 3.2), "center": (0, 18.4, 0), "mat": 0}],
        ["glow"],
        smooth=False,
        extras={"part": "lantern_window", "cast": False, "line": False},
    )
    return [lantern_obj, window_obj]


def _build_bonsai(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    pot = build_mesh_obj(
        scene,
        "Pot",
        [
            {"kind": "prism", "r0": 4.2, "r1": 5.0, "h": 4.2, "seg": 8, "base": (0, 0, 0), "mat": 0},
            {"kind": "prism", "r0": 5.3, "r1": 5.3, "h": 1.0, "seg": 8, "base": (0, 4.0, 0), "mat": 0},
        ],
        ["water"],
        smooth=False,
        extras={"part": "bonsai_pot"},
    )
    trunk = build_mesh_obj(
        scene,
        "Trunk",
        [
            {"kind": "box", "size": (2.0, 7.0, 2.0), "center": (-0.6, 7.6, 0), "rot": (0, 0, 0.25), "mat": 0},
            {"kind": "box", "size": (1.6, 6.5, 1.6), "center": (0.8, 12.6, 0.3), "rot": (0, 0, -0.35), "mat": 0},
        ],
        ["wood"],
        smooth=False,
        extras={"part": "bonsai_trunk"},
    )
    canopy = build_mesh_obj(
        scene,
        "Canopy",
        [
            {"kind": "ell", "radii": (5.2, 3.4, 4.4), "center": (0.4, 18.6, 0.2), "seg": 8, "rings": 5, "mat": 0},
            {"kind": "ell", "radii": (3.8, 2.6, 3.4), "center": (-2.8, 14.8, 0.6), "seg": 7, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (3.2, 2.4, 3.0), "center": (3.2, 15.6, -0.5), "seg": 7, "rings": 4, "mat": 0},
        ],
        ["leaf"],
        smooth=False,
        extras={"part": "bonsai_canopy"},
    )
    return [pot, trunk, canopy]


def _build_basin(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    # Oval stone water basin 16 x 6 x 12 (elliptical in XZ)
    basin = build_mesh_obj(
        scene,
        "Basin",
        [
            {"kind": "ell", "radii": (7.8, 3.0, 5.8), "center": (0, 3.0, 0), "seg": 10, "rings": 5, "mat": 0},
            {"kind": "prism", "r0": 5.5, "r1": 5.8, "h": 4.2, "seg": 10, "base": (0, 0, 0), "mat": 0},
        ],
        ["stone"],
        smooth=False,
        extras={"part": "basin"},
    )
    water = build_mesh_obj(
        scene,
        "Water",
        [
            {"kind": "ell", "radii": (5.8, 0.3, 4.4), "center": (0, 5.75, 0), "seg": 10, "rings": 3, "mat": 0},
        ],
        ["water"],
        smooth=False,
        extras={"part": "basin_water", "cast": False, "line": False},
    )
    return [basin, water]


def _build_pin(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    return [
        build_mesh_obj(
            scene,
            "Pin",
            [
                {"kind": "prism", "r0": 0.9, "r1": 0.6, "h": 2.2, "seg": 6, "base": (0, 0, 0), "mat": 0},
                {"kind": "ell", "radii": (0.95, 0.75, 0.95), "center": (0, 2.25, 0), "seg": 6, "rings": 4, "mat": 0},
            ],
            ["warm"],
            smooth=False,
            extras={"part": "pin"},
        )
    ]


def _build_basket(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    parts: list[dict[str, Any]] = [
        {"kind": "prism", "r0": 7.5, "r1": 9.8, "h": 8.0, "seg": 10, "base": (0, 0, 0), "mat": 0},
        {"kind": "prism", "r0": 10.0, "r1": 10.0, "h": 1.3, "seg": 10, "base": (0, 7.6, 0), "mat": 1},
        # Three stones peeking out of the woven basket
        {"kind": "ell", "radii": (3.8, 2.8, 3.2), "center": (-2.8, 7.6, 1.2), "seg": 7, "rings": 5, "seed": 11, "mat": 2},
        {"kind": "ell", "radii": (3.4, 3.2, 3.0), "center": (3.2, 7.8, -0.6), "seg": 7, "rings": 5, "seed": 22, "mat": 2},
        {"kind": "ell", "radii": (2.8, 2.2, 2.6), "center": (0.2, 7.4, -3.2), "seg": 6, "rings": 4, "seed": 33, "mat": 2},
    ]
    return [
        build_mesh_obj(
            scene,
            "Basket",
            parts,
            ["wood", "wood_light", "stone"],
            smooth=False,
            extras={"part": "basket"},
        )
    ]


def _build_shishi_odoshi(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    basin = build_mesh_obj(
        scene,
        "Basin",
        [
            {"kind": "prism", "r0": 8.2, "r1": 9.4, "h": 5.0, "seg": 10, "base": (2, 0, 2), "mat": 0},
            {"kind": "prism", "r0": 7.6, "r1": 7.6, "h": 0.5, "seg": 10, "base": (2, 4.7, 2), "mat": 1},
            # Two wooden support posts for the pivot
            {"kind": "box", "size": (1.6, 12.0, 1.6), "center": (-4.5, 6.0, -2.8), "mat": 2},
            {"kind": "box", "size": (1.6, 12.0, 1.6), "center": (-4.5, 6.0, 2.8), "mat": 2},
        ],
        ["stone", "water", "wood"],
        smooth=False,
        extras={"part": "shishi_basin"},
    )
    # Pivoting bamboo arm centered around pivot (-4.5, 11.2, 0)
    arm = build_mesh_obj(
        scene,
        "BambooArm",
        [
            {
                "kind": "prism",
                "r0": 1.35,
                "r1": 1.35,
                "h": 18.0,
                "seg": 6,
                "base": (-7.0, 0.0, 0.0),
                "rot": (0.0, 0.0, -math.pi * 0.5 - 0.18),
                "mat": 0,
            },
        ],
        ["leaf"],
        smooth=False,
        location=(-4.5, 11.2, 0.0),
        extras={"part": "shishi_arm"},
    )
    spout = build_mesh_obj(
        scene,
        "Spout",
        [
            {"kind": "prism", "r0": 1.4, "r1": 1.3, "h": 21.0, "seg": 6, "base": (-9.5, 0, -5.5), "mat": 0},
            {"kind": "prism", "r0": 1.1, "r1": 1.1, "h": 8.0, "seg": 6, "base": (-9.5, 19.5, -5.5), "rot": (0, 0, -math.pi * 0.42), "mat": 0},
        ],
        ["leaf"],
        smooth=False,
        extras={"part": "shishi_spout"},
    )
    return [basin, arm, spout]


def _build_bamboo(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    # Six tall bamboo stalks 112-132 high behind the wall (bounds ~280 x 132 x 16)
    stalks = [
        (-134, 124, 2.0, -2.0),
        (-102, 132, 2.2, 1.5),
        (-42, 118, 1.8, -1.0),
        (36, 128, 2.1, 2.0),
        (98, 115, 1.9, -2.0),
        (134, 130, 2.2, 1.0),
    ]
    parts: list[dict[str, Any]] = []
    for sx, sh, sr, sz in stalks:
        parts.append({"kind": "prism", "r0": sr, "r1": sr * 0.82, "h": sh, "seg": 6, "base": (sx, 0, sz), "mat": 0})
        # Little bamboo leaf tufts near top
        parts.append({"kind": "box", "size": (9.0, 1.8, 3.0), "center": (sx + 4.5, sh - 16, sz), "rot": (0, 0, -0.3), "mat": 0})
        parts.append({"kind": "box", "size": (8.0, 1.6, 3.0), "center": (sx - 4.0, sh - 24, sz), "rot": (0, 0, 0.35), "mat": 0})
    return [
        build_mesh_obj(
            scene,
            "BambooCluster",
            parts,
            ["leaf"],
            smooth=False,
            extras={"part": "bamboo"},
        )
    ]


PROP_BUILDERS: list[tuple[str, str, Any]] = [
    ("frame", "props/frame.glb", _build_frame),
    ("engawa", "props/engawa.glb", _build_engawa),
    ("rack", "props/rack.glb", _build_rack),
    ("stone_s", "props/stone_s.glb", lambda s: _build_stone(s, 4.0, 5.0, 3.0, 101, False, "stone_s")),
    ("stone_m", "props/stone_m.glb", lambda s: _build_stone(s, 7.0, 8.0, 5.0, 202, True, "stone_m")),
    ("stone_l", "props/stone_l.glb", lambda s: _build_stone(s, 10.0, 15.0, 7.0, 303, True, "stone_l")),
    ("stone_tall", "props/stone_tall.glb", lambda s: _build_stone(s, 5.0, 20.0, 4.0, 404, True, "stone_tall")),
    ("stone_flat", "props/stone_flat.glb", lambda s: _build_stone(s, 11.0, 5.0, 5.0, 505, True, "stone_flat")),
    ("moss_a", "props/moss_a.glb", lambda s: _build_moss(s, 13.0, 9.0, 606, "moss_a")),
    ("moss_b", "props/moss_b.glb", lambda s: _build_moss(s, 9.0, 6.0, 707, "moss_b")),
    ("lantern", "props/lantern.glb", _build_lantern),
    ("bonsai", "props/bonsai.glb", _build_bonsai),
    ("basin", "props/basin.glb", _build_basin),
    ("pin", "props/pin.glb", _build_pin),
    ("basket", "props/basket.glb", _build_basket),
    ("shishi_odoshi", "props/shishi_odoshi.glb", _build_shishi_odoshi),
    ("bamboo", "props/bamboo.glb", _build_bamboo),
]


def build_all_props(scene: bpy.types.Scene, only_id: str | None = None) -> list[str]:
    exported: list[str] = []
    for pid, rel_file, builder in PROP_BUILDERS:
        if only_id and pid != only_id:
            continue
        clear_rm_objects(scene)
        objs = builder(scene)
        out_path = MODELS_OUT_DIR / rel_file
        export_objects_glb(scene, objs, out_path)
        exported.append(rel_file)
    return exported
