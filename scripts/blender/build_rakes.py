"""Procedural Blender 5.3+ generator for all 10 Wall of Rakes tools.

Each rake's tines are generated directly from its canonical 1-D sand profile array
(DESIGN.md 4.1 & 8.2), guaranteeing that every `.glb` model's `tine_0..tine_N`
geometry matches its sand stamp width, count, spacing, and depth.

Local rake frame (Y-up on export):
- Origin `(0, 0, 0)` at the centre of the tine tips (`minY = 0`).
- Head beam along X, tines down `-Y` with tips at `y = 0`.
- Handle extends straight back along `+Z`.
"""

from __future__ import annotations

import math
from typing import Any

import bpy

from rm_common import MODELS_OUT_DIR, build_mesh_obj, clear_rm_objects, export_objects_glb

KEEP = 127


def make_profile(
    tines: int,
    tw: int,
    gap: int,
    depth: int,
    ridge: int,
    berm: int,
    gap_val: int | None = None,
) -> list[int]:
    p = [berm]
    for i in range(tines):
        p.extend([-depth] * tw)
        if i < tines - 1:
            p.extend([ridge if gap_val is None else gap_val] * gap)
    p.append(berm)
    return p


def make_hisui_profile() -> list[int]:
    # 4 deep x 2 and 3 shallow x 1, alternating, ridges +1 between each, outer berm +1 -> 19 cells
    p = [1]
    for i in range(7):
        if i % 2 == 0:
            p.extend([-2, -2])
        else:
            p.append(-1)
        if i < 6:
            p.append(1)
    p.append(1)
    return p


def extract_tine_runs(profile: list[int]) -> list[tuple[float, float, int]]:
    """Return [(center_x, width, abs_depth)] for every contiguous negative run in profile."""
    half = len(profile) / 2.0
    runs: list[tuple[float, float, int]] = []
    i = 0
    n = len(profile)
    while i < n:
        v = profile[i]
        if v < 0:
            j = i
            min_v = v
            while j < n and profile[j] < 0:
                if profile[j] < min_v:
                    min_v = profile[j]
                j += 1
            width = float(j - i)
            cx = (i + j) / 2.0 - half
            runs.append((cx, width, abs(min_v)))
            i = j
        else:
            i += 1
    return runs


RAKE_DEFS: list[dict[str, Any]] = [
    {
        "id": "sugi",
        "file": "rakes/sugi.glb",
        "profile": make_profile(5, 2, 2, 2, 1, 1),
        "handle_len": 46.5,
        "head_h": 2.4,
        "head_d": 2.4,
        "tine_h": 4.1,
        "head_ramp": "wood",
        "handle_ramp": "wood",
        "tine_ramp": "wood",
        "wrap_ramp": "wood_light",
        "style": "classic",
    },
    {
        "id": "onami",
        "file": "rakes/onami.glb",
        "profile": make_profile(9, 2, 2, 2, 1, 1),
        "handle_len": 48.5,
        "head_h": 2.4,
        "head_d": 2.6,
        "tine_h": 4.1,
        "head_ramp": "wood_light",
        "handle_ramp": "wood_light",
        "tine_ramp": "stone",
        "wrap_ramp": "wood",
        "style": "wide",
    },
    {
        "id": "kinu",
        "file": "rakes/kinu.glb",
        "profile": make_profile(11, 1, 1, 1, 1, 1),
        "handle_len": 44.5,
        "head_h": 2.0,
        "head_d": 2.0,
        "tine_h": 4.0,
        "head_ramp": "wood_light",
        "handle_ramp": "wood_light",
        "tine_ramp": "leaf",
        "wrap_ramp": "leaf",
        "style": "fine",
    },
    {
        "id": "hisui",
        "file": "rakes/hisui.glb",
        "profile": make_hisui_profile(),
        "handle_len": 44.5,
        "head_h": 2.4,
        "head_d": 2.4,
        "tine_h": 4.1,
        "head_ramp": "stone",
        "handle_ramp": "stone",
        "tine_ramp": "leaf",
        "wrap_ramp": "warm",
        "style": "jade",
    },
    {
        "id": "mikazuki",
        "file": "rakes/mikazuki.glb",
        "profile": make_profile(6, 2, 2, 2, 1, 1),
        "handle_len": 46.5,
        "head_h": 2.4,
        "head_d": 2.4,
        "tine_h": 4.1,
        "head_ramp": "wood_light",
        "handle_ramp": "wood",
        "tine_ramp": "wood_light",
        "wrap_ramp": "water",
        "style": "crescent",
    },
    {
        "id": "tetsu",
        "file": "rakes/tetsu.glb",
        "profile": make_profile(3, 3, 3, 3, 2, 2),
        "handle_len": 48.5,
        "head_h": 2.6,
        "head_d": 3.0,
        "tine_h": 4.9,
        "head_ramp": "stone",
        "handle_ramp": "wood",
        "tine_ramp": "stone",
        "wrap_ramp": "stone",
        "style": "iron",
    },
    {
        "id": "wa",
        "file": "rakes/wa.glb",
        "profile": make_profile(2, 2, 6, 2, 1, 1, gap_val=KEEP),
        "handle_len": 42.5,
        "head_h": 2.2,
        "head_d": 2.2,
        "tine_h": 4.3,
        "head_ramp": "wood",
        "handle_ramp": "wood",
        "tine_ramp": "wood",
        "wrap_ramp": "warm",
        "style": "fork",
    },
    {
        "id": "take",
        "file": "rakes/take.glb",
        "profile": make_profile(1, 1, 0, 2, 1, 1),
        "handle_len": 40.5,
        "head_h": 2.0,
        "head_d": 2.2,
        "tine_h": 4.0,
        "head_ramp": "leaf",
        "handle_ramp": "leaf",
        "tine_ramp": "wood_light",
        "wrap_ramp": "wood_light",
        "style": "stylus",
    },
    {
        "id": "nagi",
        "file": "rakes/nagi.glb",
        "profile": [0] * 16,
        "handle_len": 42.5,
        "head_h": 6.0,
        "head_d": 2.0,
        "tine_h": 0.0,
        "head_ramp": "wood_light",
        "handle_ramp": "wood",
        "tine_ramp": "wood_light",
        "wrap_ramp": "wood",
        "style": "board",
    },
    {
        "id": "hoki",
        "file": "rakes/hoki.glb",
        "profile": [0] * 12,
        "handle_len": 44.5,
        "head_h": 7.0,
        "head_d": 3.0,
        "tine_h": 0.0,
        "head_ramp": "leaf",
        "handle_ramp": "wood",
        "tine_ramp": "leaf",
        "wrap_ramp": "warm",
        "style": "broom",
    },
]


def build_single_rake(scene: bpy.types.Scene, rdef: dict[str, Any]) -> list[bpy.types.Object]:
    rid = rdef["id"]
    profile: list[int] = rdef["profile"]
    head_w = float(len(profile))
    head_h = float(rdef["head_h"])
    head_d = float(rdef["head_d"])
    tine_h = float(rdef["tine_h"])
    handle_len = float(rdef["handle_len"])
    style = rdef["style"]
    part_tag = f"rake_{rid}"

    objs: list[bpy.types.Object] = []

    # 1. Head node
    head_parts: list[dict[str, Any]] = []
    head_ramps = [rdef["head_ramp"]]
    if rdef["wrap_ramp"] not in head_ramps:
        head_ramps.append(rdef["wrap_ramp"])
    wrap_mat_idx = head_ramps.index(rdef["wrap_ramp"])

    if style == "board":
        # Wide paulownia smoothing board resting cleanly at y = 0..6
        head_parts.append({"kind": "box", "size": (head_w, head_h, head_d), "center": (0, head_h * 0.5, 0), "mat": 0})
        head_parts.append({"kind": "box", "size": (head_w * 0.7, 1.2, 1.8), "center": (0, 3.6, 1.4), "mat": wrap_mat_idx})
    elif style == "broom":
        # Bundled bamboo twigs tapering up to the handle collar, y = 0..7
        for k in range(5):
            bx = (k - 2) * 2.1
            head_parts.append({
                "kind": "box",
                "size": (2.2, 5.2, 2.2),
                "center": (bx, 2.6, 0.0),
                "rot": (0.0, 0.0, (2 - k) * 0.14),
                "mat": 0,
            })
        head_parts.append({"kind": "box", "size": (5.2, 1.8, 2.8), "center": (0, 6.1, 0.0), "mat": wrap_mat_idx})
    elif style == "crescent":
        # Curved maple head in 3 angled segments
        seg_w = head_w / 3.0
        beam_y = tine_h + head_h * 0.5
        head_parts.append({"kind": "box", "size": (seg_w + 0.6, head_h, head_d), "center": (0, beam_y, 0.0), "mat": 0})
        head_parts.append({"kind": "box", "size": (seg_w + 0.4, head_h, head_d), "center": (-seg_w, beam_y, -1.2), "rot": (0, 0.25, 0), "mat": 0})
        head_parts.append({"kind": "box", "size": (seg_w + 0.4, head_h, head_d), "center": (seg_w, beam_y, -1.2), "rot": (0, -0.25, 0), "mat": 0})
        head_parts.append({"kind": "box", "size": (3.2, head_h + 0.5, head_d + 0.6), "center": (0, beam_y, 0.6), "mat": wrap_mat_idx})
    elif style == "fork":
        # Forked walnut branch with brass ring
        beam_y = tine_h + head_h * 0.5
        head_parts.append({"kind": "box", "size": (head_w, head_h, head_d), "center": (0, beam_y, 0.0), "mat": 0})
        head_parts.append({"kind": "prism", "r0": 1.6, "r1": 1.6, "h": 1.4, "seg": 8, "base": (0, beam_y - 0.7, 3.0), "rot": (math.pi * 0.5, 0, 0), "mat": wrap_mat_idx})
    else:
        beam_y = tine_h + head_h * 0.5
        head_parts.append({"kind": "box", "size": (head_w, head_h, head_d), "center": (0, beam_y, 0.0), "mat": 0})
        # Joint collar / cord wrap
        head_parts.append({"kind": "box", "size": (min(head_w, 3.0), head_h + 0.5, head_d + 0.6), "center": (0, beam_y, 0.6), "mat": wrap_mat_idx})
        if style == "wide":
            # Extra rope bindings on Onami
            for rx in (-9.0, 9.0):
                head_parts.append({"kind": "box", "size": (1.6, head_h + 0.3, head_d + 0.4), "center": (rx, beam_y, 0), "mat": wrap_mat_idx})
        elif style == "iron":
            # Iron rivets on Tetsu
            for rx in (-6.0, 0.0, 6.0):
                head_parts.append({"kind": "box", "size": (1.2, 0.7, 1.2), "center": (rx, beam_y + head_h * 0.5 + 0.25, 0), "mat": 0})

    head_obj = build_mesh_obj(
        scene,
        "Head",
        head_parts,
        head_ramps,
        smooth=False,
        extras={"part": part_tag},
    )
    objs.append(head_obj)

    # 2. Handle node (extends back along +Z from z = 1.0 to handle_len)
    handle_y = (head_h * 0.65) if style in ("board", "broom") else (tine_h + head_h * 0.5)
    handle_r = 0.85 if style == "stylus" else 1.05
    handle_parts: list[dict[str, Any]] = [
        {
            "kind": "prism",
            "r0": handle_r,
            "r1": handle_r * 0.88,
            "h": handle_len - 1.0,
            "seg": 6,
            "base": (0.0, handle_y, 1.0),
            "rot": (math.pi * 0.5, 0.0, 0.0),
            "mat": 0,
        }
    ]
    handle_ramps = [rdef["handle_ramp"]]
    if style == "stylus":
        # Bamboo nodes along Take shaft
        handle_ramps.append("wood_light")
        for nz in (12.0, 24.0, 35.0):
            handle_parts.append({
                "kind": "prism",
                "r0": handle_r * 1.18,
                "r1": handle_r * 1.18,
                "h": 0.9,
                "seg": 6,
                "base": (0.0, handle_y, nz),
                "rot": (math.pi * 0.5, 0.0, 0.0),
                "mat": 1,
            })

    handle_obj = build_mesh_obj(
        scene,
        "Handle",
        handle_parts,
        handle_ramps,
        smooth=False,
        extras={"part": part_tag},
    )
    objs.append(handle_obj)

    # 3. Tines generated strictly from profile groove runs (instancing shared mesh per unique size to stay tiny)
    runs = extract_tine_runs(profile)
    tine_mesh_cache: dict[tuple[float, float, float, str], bpy.types.Mesh] = {}
    for idx, (cx, tw, depth) in enumerate(runs):
        actual_h = tine_h if depth >= 2 else max(3.2, tine_h - 0.6)
        y_bottom = 0.0 if (depth >= 2 or idx == 0) else 0.6
        tine_depth_z = 1.8 if style == "iron" else (1.1 if tw <= 1.0 else 1.5)
        z_off = 0.0
        if style == "crescent":
            z_off = -1.1 * (abs(cx) / max(1.0, head_w * 0.5))

        box_w = round(max(0.85, tw * 0.92), 3)
        box_h = round(actual_h, 3)
        box_d = round(tine_depth_z, 3)
        cache_key = (box_w, box_h, box_d, rdef["tine_ramp"])

        if cache_key not in tine_mesh_cache:
            proto = build_mesh_obj(
                scene,
                f"tine_{idx}",
                [
                    {
                        "kind": "box",
                        "size": (box_w, box_h, box_d),
                        "center": (0.0, box_h * 0.5, 0.0),
                        "mat": 0,
                    }
                ],
                [rdef["tine_ramp"]],
                smooth=False,
                location=(cx, y_bottom, z_off),
                extras={"part": part_tag},
            )
            tine_mesh_cache[cache_key] = proto.data
            objs.append(proto)
        else:
            from rm_common import register_owned_object, to_blender_pos
            inst = register_owned_object(bpy.data.objects.new(f"tine_{idx}", tine_mesh_cache[cache_key]))
            scene.collection.objects.link(inst)
            inst.location = to_blender_pos(cx, y_bottom, z_off)
            inst["part"] = part_tag
            objs.append(inst)

    return objs


def build_all_rakes(scene: bpy.types.Scene, only_id: str | None = None) -> list[str]:
    exported: list[str] = []
    for rdef in RAKE_DEFS:
        if only_id and rdef["id"] != only_id:
            continue
        clear_rm_objects(scene)
        objs = build_single_rake(scene, rdef)
        out_path = MODELS_OUT_DIR / rdef["file"]
        export_objects_glb(scene, objs, out_path)
        exported.append(rdef["file"])
    return exported
