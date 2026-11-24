"""Procedural Blender 5.3+ generator for all three swappable Gubba caretaker models:
  - gubba_moss.glb    (Concept A — Moss Yabba)
  - gubba_kasa.glb    (Concept B — Kasa Yabba)
  - gubba_lantern.glb (Concept C — Lantern Yabba)

Ported faithfully from the proportions in `docs/mockups/gubba-concepts.html`
and DESIGN.md Section 5.4 / 5.5, with rigid named node hierarchies so code
animates breathing, head turns, lopsided blinks, tea sips, tail flicks, and
prop bobbing deterministically on the breath clock.
"""

from __future__ import annotations

from typing import Any

import bpy

from rm_common import (
    MODELS_OUT_DIR,
    build_mesh_obj,
    clear_rm_objects,
    export_objects_glb,
    make_empty,
)


def _add_eye_assembly(
    scene: bpy.types.Scene,
    parent: bpy.types.Object,
    side: str,
    local_center: tuple[float, float, float],
    radius: float,
    droop: float,
    variant: str,
    objs: list[bpy.types.Object],
) -> None:
    cx, cy, cz = local_center
    eye_obj = build_mesh_obj(
        scene,
        f"Eye{side}",
        [{"kind": "ell", "radii": (radius, radius, radius), "center": (0, 0, 0), "seg": 8, "rings": 6, "mat": 0}],
        ["cloth"],
        smooth=True,
        parent=parent,
        location=(cx, cy, cz),
        extras={"part": f"gubba_eye_{side.lower()}"},
        gubba_variant=variant,
    )
    pupil_obj = build_mesh_obj(
        scene,
        f"Pupil{side}",
        [
            {
                "kind": "ell",
                "radii": (radius * 0.5, radius * 0.5, radius * 0.32),
                "center": (0, -0.12 * radius, radius * 0.84),
                "seg": 6,
                "rings": 4,
                "mat": 0,
            }
        ],
        ["ink"],
        smooth=False,
        parent=eye_obj,
        location=(0, 0, 0),
        extras={"part": f"gubba_pupil_{side.lower()}", "cast": False, "line": False},
        gubba_variant=variant,
    )
    lid_obj = build_mesh_obj(
        scene,
        f"Lid{side}",
        [
            {
                "kind": "ell",
                "radii": (radius * 1.1, radius * 1.04, radius * 1.1),
                "center": (0, droop * radius, -radius * 0.02),
                "seg": 8,
                "rings": 6,
                "mat": 0,
            }
        ],
        ["gubba"],
        smooth=True,
        parent=eye_obj,
        location=(0, 0, 0),
        extras={"part": f"gubba_lid_{side.lower()}"},
        gubba_variant=variant,
    )
    objs.extend([eye_obj, pupil_obj, lid_obj])


def build_gubba_moss(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    """Concept A — Moss Yabba: sprawling mound on undersized cushion + crooked head bonsai."""
    variant = "moss"
    objs: list[bpy.types.Object] = []
    root = make_empty(scene, "Root", (0, 0, 0), extras={"part": "gubba"})
    objs.append(root)

    # Body node (pivot at floor centre)
    body_parts: list[dict[str, Any]] = [
        # Undersized zabuton cushion + tassel
        {"kind": "box", "size": (30, 3, 25), "center": (1, 1.5, 0), "rot": (0, 0.22, 0), "mat": 3},
        {"kind": "ell", "radii": (1.2, 1.2, 1.2), "center": (-15.5, 1.2, 14.5), "seg": 5, "rings": 3, "mat": 3},
        # Sprawling lower mound & shoulders
        {"kind": "ell", "radii": (20.0, 11.0, 16.0), "center": (0, 9.5, 0), "seg": 12, "rings": 7, "mat": 0},
        {"kind": "ell", "radii": (17.5, 8.0, 14.0), "center": (0, 17.0, 0.5), "seg": 10, "rings": 6, "mat": 0},
        # Pale belly
        {"kind": "ell", "radii": (13.2, 9.5, 6.0), "center": (-1, 9.0, 11.2), "seg": 10, "rings": 6, "mat": 1},
        # Mossy warts on body
        {"kind": "ell", "radii": (1.3, 1.3, 1.3), "center": (-16, 17, 6), "seg": 5, "rings": 3, "mat": 2},
        {"kind": "ell", "radii": (1.2, 1.2, 1.2), "center": (17.5, 15, 4), "seg": 5, "rings": 3, "mat": 2},
        {"kind": "ell", "radii": (1.1, 1.1, 1.1), "center": (-18.5, 10, 5), "seg": 5, "rings": 3, "mat": 2},
        {"kind": "ell", "radii": (1.1, 1.1, 1.1), "center": (15, 21, 2), "seg": 5, "rings": 3, "mat": 2},
        {"kind": "ell", "radii": (1.2, 1.2, 1.2), "center": (18, 8, 7), "seg": 5, "rings": 3, "mat": 2},
    ]
    body = build_mesh_obj(
        scene,
        "Body",
        body_parts,
        ["gubba", "belly", "leaf", "warm"],
        smooth=True,
        parent=root,
        location=(0, 0, 0),
        extras={"part": "gubba_body"},
        gubba_variant=variant,
    )
    objs.append(body)

    # Curled tail hierarchy (Tail1 -> Tail2 -> Tail3)
    tail1 = build_mesh_obj(
        scene,
        "Tail1",
        [{"kind": "ell", "radii": (6.2, 5.2, 6.2), "center": (0, 0, 0), "seg": 8, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(20.0, 5.0, -3.0),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    tail2 = build_mesh_obj(
        scene,
        "Tail2",
        [{"kind": "ell", "radii": (4.2, 3.6, 4.2), "center": (0, 0, 0), "seg": 8, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=tail1,
        location=(5.5, 1.5, -3.5),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    tail3 = build_mesh_obj(
        scene,
        "Tail3",
        [
            {"kind": "ell", "radii": (2.9, 2.5, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (2.0, 1.8, 2.0), "center": (-1.5, 3.4, -1.5), "seg": 6, "rings": 4, "mat": 0},
        ],
        ["gubba"],
        smooth=True,
        parent=tail2,
        location=(2.0, 3.5, -2.5),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    objs.extend([tail1, tail2, tail3])

    # Head node (pivot at y = 25.5)
    head_parts: list[dict[str, Any]] = [
        {"kind": "ell", "radii": (15.5, 10.2, 13.0), "center": (0, 0, 1.5), "seg": 12, "rings": 7, "mat": 0},
        # Rosy cheeks
        {"kind": "ell", "radii": (1.8, 1.1, 0.9), "center": (-12.4, -0.6, 8.6), "seg": 6, "rings": 4, "mat": 2},
        {"kind": "ell", "radii": (1.8, 1.1, 0.9), "center": (12.4, -0.6, 8.6), "seg": 6, "rings": 4, "mat": 2},
        # Dot nostrils
        {"kind": "ell", "radii": (0.6, 0.6, 0.5), "center": (-1.5, 1.2, 14.3), "seg": 5, "rings": 3, "mat": 3},
        {"kind": "ell", "radii": (0.6, 0.6, 0.5), "center": (1.5, 1.2, 14.3), "seg": 5, "rings": 3, "mat": 3},
        # Head warts
        {"kind": "ell", "radii": (1.2, 1.2, 1.2), "center": (-13, 5, 3), "seg": 5, "rings": 3, "mat": 1},
        {"kind": "ell", "radii": (1.1, 1.1, 1.1), "center": (13.5, 4, 2), "seg": 5, "rings": 3, "mat": 1},
        {"kind": "ell", "radii": (1.2, 1.2, 1.2), "center": (4, 9.6, 3), "seg": 5, "rings": 3, "mat": 1},
        {"kind": "ell", "radii": (1.1, 1.1, 1.1), "center": (-3, 9, -5), "seg": 5, "rings": 3, "mat": 1},
    ]
    head = build_mesh_obj(
        scene,
        "Head",
        head_parts,
        ["gubba", "leaf", "blush", "ink"],
        smooth=True,
        parent=body,
        location=(0, 25.5, 0),
        extras={"part": "gubba_head"},
        gubba_variant=variant,
    )
    objs.append(head)

    # Wide grin + cheeky tongue tip
    mouth = build_mesh_obj(
        scene,
        "Mouth",
        [
            {"kind": "ell", "radii": (16.2, 0.65, 12.5), "center": (0, -3.0, 2.5), "seg": 12, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (1.5, 1.0, 1.3), "center": (8.0, -3.9, 13.4), "seg": 6, "rings": 4, "mat": 1},
        ],
        ["ink", "blush"],
        smooth=False,
        parent=head,
        location=(0, 0, 0),
        extras={"part": "gubba_mouth", "cast": False, "line": False},
        gubba_variant=variant,
    )
    objs.append(mouth)

    # Lopsided eyes
    _add_eye_assembly(scene, head, "L", (-8.6, 5.2, 9.2), 3.7, 1.2, variant, objs)
    _add_eye_assembly(scene, head, "R", (8.2, 4.6, 9.8), 2.9, 0.72, variant, objs)

    # Crooked head bonsai
    bonsai = build_mesh_obj(
        scene,
        "Prop_Bonsai",
        [
            {"kind": "box", "size": (1.3, 6.0, 1.3), "center": (0, 2.6, 0), "rot": (0, 0, 0.35), "mat": 0},
            {"kind": "ell", "radii": (3.6, 2.6, 3.4), "center": (-3.1, 6.2, 0.5), "seg": 6, "rings": 4, "mat": 1},
            {"kind": "ell", "radii": (2.6, 2.0, 2.6), "center": (2.1, 5.0, -1.0), "seg": 6, "rings": 4, "mat": 1},
        ],
        ["wood", "leaf"],
        smooth=False,
        parent=head,
        location=(-5.5, 9.4, 0.0),
        extras={"part": "gubba_prop"},
        gubba_variant=variant,
    )
    objs.append(bonsai)

    # Tiny stubby arms + thimble teacup
    arm_l = build_mesh_obj(
        scene,
        "ArmL",
        [{"kind": "ell", "radii": (2.9, 2.3, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(-8.6, 15.4, 14.6),
        extras={"part": "gubba_arm_l"},
        gubba_variant=variant,
    )
    arm_r = build_mesh_obj(
        scene,
        "ArmR",
        [{"kind": "ell", "radii": (2.9, 2.3, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(8.6, 15.4, 14.6),
        extras={"part": "gubba_arm_r"},
        gubba_variant=variant,
    )
    cup = build_mesh_obj(
        scene,
        "Cup",
        [
            {"kind": "prism", "r0": 1.5, "r1": 1.9, "h": 2.8, "seg": 7, "base": (0, 0, 0), "mat": 0},
            {"kind": "prism", "r0": 1.7, "r1": 1.7, "h": 0.5, "seg": 7, "base": (0, 2.8, 0), "mat": 1},
        ],
        ["wood", "warm"],
        smooth=False,
        parent=arm_l,
        location=(3.2, -0.2, 1.6),
        extras={"part": "gubba_cup"},
        gubba_variant=variant,
    )
    objs.extend([arm_l, arm_r, cup])
    return objs


def build_gubba_kasa(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    """Concept B — Kasa Yabba: upright jowly pear monk with tiny straw hat, tight sash & whiskers."""
    variant = "kasa"
    objs: list[bpy.types.Object] = []
    root = make_empty(scene, "Root", (0, 0, 0), extras={"part": "gubba"})
    objs.append(root)

    body_parts: list[dict[str, Any]] = [
        {"kind": "box", "size": (26, 3, 22), "center": (0, 1.5, 0), "rot": (0, -0.18, 0), "mat": 3},
        {"kind": "ell", "radii": (16.0, 12.0, 14.0), "center": (0, 11.5, 0), "seg": 12, "rings": 7, "mat": 0},
        {"kind": "ell", "radii": (11.0, 8.6, 5.0), "center": (0, 9.2, 10.2), "seg": 10, "rings": 6, "mat": 1},
        # Tight indigo sash + knot
        {"kind": "ell", "radii": (16.6, 1.7, 14.6), "center": (0, 10.4, 0.2), "seg": 12, "rings": 4, "mat": 2},
        {"kind": "box", "size": (3.0, 3.0, 2.0), "center": (8.5, 10.2, 13.2), "mat": 2},
        {"kind": "box", "size": (1.6, 4.5, 1.0), "center": (9.2, 6.6, 13.6), "mat": 2},
    ]
    body = build_mesh_obj(
        scene,
        "Body",
        body_parts,
        ["gubba", "belly", "water", "warm"],
        smooth=True,
        parent=root,
        location=(0, 0, 0),
        extras={"part": "gubba_body"},
        gubba_variant=variant,
    )
    objs.append(body)

    tail1 = build_mesh_obj(
        scene,
        "Tail1",
        [{"kind": "ell", "radii": (5.8, 4.9, 5.8), "center": (0, 0, 0), "seg": 8, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(-16.0, 4.6, 8.0),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    tail2 = build_mesh_obj(
        scene,
        "Tail2",
        [{"kind": "ell", "radii": (3.8, 3.2, 3.8), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=tail1,
        location=(-5.5, 1.0, 4.0),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    tail3 = build_mesh_obj(
        scene,
        "Tail3",
        [
            {"kind": "ell", "radii": (2.6, 2.2, 2.6), "center": (0, 0, 0), "seg": 6, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (1.8, 1.5, 1.8), "center": (1.5, 3.0, 1.0), "seg": 6, "rings": 4, "mat": 0},
        ],
        ["gubba"],
        smooth=True,
        parent=tail2,
        location=(-1.0, 3.4, 2.5),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    objs.extend([tail1, tail2, tail3])

    head_parts: list[dict[str, Any]] = [
        {"kind": "ell", "radii": (12.5, 11.0, 11.5), "center": (0, 0, 1.0), "seg": 12, "rings": 7, "mat": 0},
        # Heavy jowls
        {"kind": "ell", "radii": (5.8, 5.2, 5.6), "center": (-10, -5, 3.6), "seg": 8, "rings": 5, "mat": 0},
        {"kind": "ell", "radii": (5.8, 5.2, 5.6), "center": (10, -5, 3.6), "seg": 8, "rings": 5, "mat": 0},
        # Cheeks & nostrils
        {"kind": "ell", "radii": (1.7, 1.1, 0.9), "center": (-13.2, -2.8, 7.6), "seg": 6, "rings": 4, "mat": 1},
        {"kind": "ell", "radii": (1.7, 1.1, 0.9), "center": (13.2, -2.8, 7.6), "seg": 6, "rings": 4, "mat": 1},
        {"kind": "ell", "radii": (0.6, 0.6, 0.5), "center": (-1.4, -1.2, 12.3), "seg": 5, "rings": 3, "mat": 2},
        {"kind": "ell", "radii": (0.6, 0.6, 0.5), "center": (1.4, -1.2, 12.3), "seg": 5, "rings": 3, "mat": 2},
        # Catfish whiskers
        {"kind": "box", "size": (5.0, 0.8, 0.8), "center": (-17.5, -4.6, 6.5), "mat": 2},
        {"kind": "box", "size": (0.8, 4.0, 0.8), "center": (-19.8, -2.6, 6.5), "mat": 2},
        {"kind": "box", "size": (5.0, 0.8, 0.8), "center": (17.5, -4.6, 6.5), "mat": 2},
        {"kind": "box", "size": (0.8, 4.0, 0.8), "center": (19.8, -2.6, 6.5), "mat": 2},
        # Tiny bamboo pipe
        {"kind": "box", "size": (7.5, 0.9, 0.9), "center": (11.5, -6.6, 11.0), "rot": (0, -0.5, -0.35), "mat": 3},
        {"kind": "prism", "r0": 1.2, "r1": 1.4, "h": 2.0, "seg": 6, "base": (14.4, -8.8, 12.6), "mat": 3},
    ]
    head = build_mesh_obj(
        scene,
        "Head",
        head_parts,
        ["gubba", "blush", "ink", "wood"],
        smooth=True,
        parent=body,
        location=(0, 26.5, 0),
        extras={"part": "gubba_head"},
        gubba_variant=variant,
    )
    objs.append(head)

    mouth = build_mesh_obj(
        scene,
        "Mouth",
        [{"kind": "ell", "radii": (16.3, 0.65, 10.4), "center": (0, -5.2, 1.9), "seg": 12, "rings": 4, "mat": 0}],
        ["ink"],
        smooth=False,
        parent=head,
        location=(0, 0, 0),
        extras={"part": "gubba_mouth", "cast": False, "line": False},
        gubba_variant=variant,
    )
    objs.append(mouth)

    _add_eye_assembly(scene, head, "L", (-5.4, 3.4, 9.2), 2.8, 0.7, variant, objs)
    _add_eye_assembly(scene, head, "R", (5.4, 4.0, 9.0), 3.5, 1.2, variant, objs)

    # Comically tiny straw kasa hat + dangling cord
    hat = build_mesh_obj(
        scene,
        "Prop_Hat",
        [
            {"kind": "prism", "r0": 6.2, "r1": 0.4, "h": 4.4, "seg": 9, "base": (0, 0.4, 0), "rot": (0, 0, 0.2), "mat": 0},
            {"kind": "prism", "r0": 6.8, "r1": 6.8, "h": 0.6, "seg": 9, "base": (0.1, 0.0, 0), "rot": (0, 0, 0.2), "mat": 1},
            {"kind": "box", "size": (0.7, 4.0, 0.7), "center": (-6.2, -2.4, 2.1), "rot": (0, 0, 0.25), "mat": 2},
        ],
        ["wood_light", "wood", "warm"],
        smooth=False,
        parent=head,
        location=(-2.4, 10.0, 0.4),
        extras={"part": "gubba_prop"},
        gubba_variant=variant,
    )
    objs.append(hat)

    arm_l = build_mesh_obj(
        scene,
        "ArmL",
        [{"kind": "ell", "radii": (2.9, 2.3, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(-5.4, 15.8, 12.6),
        extras={"part": "gubba_arm_l"},
        gubba_variant=variant,
    )
    arm_r = build_mesh_obj(
        scene,
        "ArmR",
        [{"kind": "ell", "radii": (2.9, 2.3, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(5.4, 15.8, 12.6),
        extras={"part": "gubba_arm_r"},
        gubba_variant=variant,
    )
    cup = build_mesh_obj(
        scene,
        "Cup",
        [
            {"kind": "prism", "r0": 1.5, "r1": 1.9, "h": 2.6, "seg": 7, "base": (0, 0, 0), "mat": 0},
            {"kind": "prism", "r0": 1.7, "r1": 1.7, "h": 0.5, "seg": 7, "base": (0, 2.6, 0), "mat": 1},
        ],
        ["cloth", "warm"],
        smooth=False,
        parent=arm_l,
        location=(5.4, 0.2, 1.6),
        extras={"part": "gubba_cup"},
        gubba_variant=variant,
    )
    objs.extend([arm_l, arm_r, cup])
    return objs


def build_gubba_lantern(scene: bpy.types.Scene) -> list[bpy.types.Object]:
    """Concept C — Lantern Yabba: sideways sprawl, eye stalks, askew headband & glowing tiny shell."""
    variant = "lantern"
    objs: list[bpy.types.Object] = []
    root = make_empty(scene, "Root", (0, 0, 0), extras={"part": "gubba"})
    objs.append(root)

    body_parts: list[dict[str, Any]] = [
        {"kind": "ell", "radii": (14.5, 8.6, 11.5), "center": (8, 7.8, -1), "seg": 10, "rings": 6, "mat": 0},
        {"kind": "ell", "radii": (13.5, 11.0, 12.2), "center": (-9, 10.2, 0), "seg": 10, "rings": 6, "mat": 0},
        {"kind": "ell", "radii": (12.6, 6.2, 5.0), "center": (-8, 5.8, 9.6), "seg": 9, "rings": 5, "mat": 1},
    ]
    body = build_mesh_obj(
        scene,
        "Body",
        body_parts,
        ["gubba", "belly"],
        smooth=True,
        parent=root,
        location=(0, 0, 0),
        extras={"part": "gubba_body"},
        gubba_variant=variant,
    )
    objs.append(body)

    tail1 = build_mesh_obj(
        scene,
        "Tail1",
        [{"kind": "ell", "radii": (7.6, 5.9, 7.0), "center": (0, 0, 0), "seg": 8, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(19.0, 5.2, -1.0),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    tail2 = build_mesh_obj(
        scene,
        "Tail2",
        [{"kind": "ell", "radii": (4.8, 3.8, 4.4), "center": (0, 0, 0), "seg": 7, "rings": 4, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=tail1,
        location=(7.5, 0.4, 2.0),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    tail3 = build_mesh_obj(
        scene,
        "Tail3",
        [
            {"kind": "ell", "radii": (3.3, 2.6, 3.0), "center": (0, 0, 0), "seg": 6, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (2.2, 1.8, 2.0), "center": (-1.5, 4.4, 0.6), "seg": 6, "rings": 4, "mat": 0},
        ],
        ["gubba"],
        smooth=True,
        parent=tail2,
        location=(3.5, 3.4, 1.0),
        extras={"part": "gubba_tail"},
        gubba_variant=variant,
    )
    objs.extend([tail1, tail2, tail3])

    # Too-small spiral shell on belly hump with firefly window
    shell = build_mesh_obj(
        scene,
        "Prop_Shell",
        [
            {"kind": "ell", "radii": (6.2, 6.2, 5.6), "center": (0, 3.6, -2.0), "seg": 9, "rings": 6, "mat": 0},
            {"kind": "ell", "radii": (4.2, 4.2, 3.8), "center": (1.2, 4.2, 1.4), "seg": 8, "rings": 5, "mat": 0},
            {"kind": "ell", "radii": (2.6, 2.6, 2.4), "center": (2.0, 4.6, 3.8), "seg": 7, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (1.3, 1.5, 0.8), "center": (2.4, 4.7, 6.1), "seg": 6, "rings": 4, "mat": 1},
        ],
        ["sand", "glow"],
        smooth=True,
        parent=body,
        location=(9.0, 17.6, 0.0),
        extras={"part": "gubba_prop"},
        gubba_variant=variant,
    )
    objs.append(shell)

    # Head with two uneven eye stalks & askew headband
    head_parts: list[dict[str, Any]] = [
        {"kind": "ell", "radii": (12.6, 9.6, 11.6), "center": (0, 0, 1.5), "seg": 10, "rings": 6, "mat": 0},
        # Eye stalks
        {"kind": "prism", "r0": 1.5, "r1": 1.2, "h": 5.8, "seg": 6, "base": (-5.0, 8.0, 4.0), "mat": 0},
        {"kind": "prism", "r0": 1.5, "r1": 1.2, "h": 8.8, "seg": 6, "base": (5.0, 8.4, 4.0), "mat": 0},
        # Headband + knot
        {"kind": "ell", "radii": (12.4, 1.4, 11.2), "center": (0, 4.4, 1.6), "rot": (0, 0, 0.12), "seg": 12, "rings": 4, "mat": 1},
        {"kind": "ell", "radii": (1.3, 1.3, 0.6), "center": (-1.0, 4.2, 12.3), "seg": 6, "rings": 4, "mat": 2},
        {"kind": "box", "size": (2.4, 2.4, 2.0), "center": (12.2, 6.0, 2.0), "mat": 1},
        {"kind": "box", "size": (1.0, 5.0, 1.2), "center": (13.6, 3.0, 3.0), "rot": (0, 0, -0.3), "mat": 1},
        # Cheeks & nostrils
        {"kind": "ell", "radii": (1.7, 1.1, 0.9), "center": (-10.2, -0.4, 7.6), "seg": 6, "rings": 4, "mat": 3},
        {"kind": "ell", "radii": (1.7, 1.1, 0.9), "center": (10.2, -0.4, 7.6), "seg": 6, "rings": 4, "mat": 3},
        {"kind": "ell", "radii": (0.6, 0.6, 0.5), "center": (-1.4, 1.0, 12.9), "seg": 5, "rings": 3, "mat": 4},
        {"kind": "ell", "radii": (0.6, 0.6, 0.5), "center": (1.4, 1.0, 12.9), "seg": 5, "rings": 3, "mat": 4},
    ]
    head = build_mesh_obj(
        scene,
        "Head",
        head_parts,
        ["gubba", "cloth", "warm", "blush", "ink"],
        smooth=True,
        parent=body,
        location=(-9.0, 20.5, 0.0),
        extras={"part": "gubba_head"},
        gubba_variant=variant,
    )
    objs.append(head)

    mouth = build_mesh_obj(
        scene,
        "Mouth",
        [
            {"kind": "ell", "radii": (13.3, 0.65, 11.0), "center": (0, -2.6, 2.5), "seg": 12, "rings": 4, "mat": 0},
            {"kind": "ell", "radii": (1.5, 1.0, 1.3), "center": (6.5, -3.5, 12.0), "seg": 6, "rings": 4, "mat": 1},
        ],
        ["ink", "blush"],
        smooth=False,
        parent=head,
        location=(0, 0, 0),
        extras={"part": "gubba_mouth", "cast": False, "line": False},
        gubba_variant=variant,
    )
    objs.append(mouth)

    _add_eye_assembly(scene, head, "L", (-5.0, 15.2, 4.6), 3.1, 1.2, variant, objs)
    _add_eye_assembly(scene, head, "R", (5.0, 18.8, 4.6), 3.7, 0.7, variant, objs)

    arm_l = build_mesh_obj(
        scene,
        "ArmL",
        [{"kind": "ell", "radii": (2.9, 2.3, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(-19.5, 8.0, 9.6),
        extras={"part": "gubba_arm_l"},
        gubba_variant=variant,
    )
    arm_r = build_mesh_obj(
        scene,
        "ArmR",
        [{"kind": "ell", "radii": (2.9, 2.3, 2.9), "center": (0, 0, 0), "seg": 7, "rings": 5, "mat": 0}],
        ["gubba"],
        smooth=True,
        parent=body,
        location=(-1.5, 7.4, 11.6),
        extras={"part": "gubba_arm_r"},
        gubba_variant=variant,
    )
    # Incense stick in Cup node slot
    cup = build_mesh_obj(
        scene,
        "Cup",
        [
            {"kind": "box", "size": (0.8, 11.0, 0.8), "center": (-2.0, 5.0, 1.0), "rot": (0, 0, 0.18), "mat": 0},
            {"kind": "ell", "radii": (0.95, 0.95, 0.95), "center": (-3.0, 10.6, 1.0), "seg": 5, "rings": 3, "mat": 1},
        ],
        ["wood", "glow"],
        smooth=False,
        parent=arm_l,
        location=(0, 0, 0),
        extras={"part": "gubba_cup"},
        gubba_variant=variant,
    )
    objs.extend([arm_l, arm_r, cup])
    return objs


GUBBA_BUILDERS = [
    ("moss", "gubba_moss.glb", build_gubba_moss),
    ("kasa", "gubba_kasa.glb", build_gubba_kasa),
    ("lantern", "gubba_lantern.glb", build_gubba_lantern),
]


def build_all_gubbas(scene: bpy.types.Scene, only_variant: str | None = None) -> list[str]:
    exported: list[str] = []
    for variant, rel_file, builder in GUBBA_BUILDERS:
        if only_variant and variant != only_variant:
            continue
        clear_rm_objects(scene)
        objs = builder(scene)
        out_path = MODELS_OUT_DIR / rel_file
        export_objects_glb(scene, objs, out_path)
        exported.append(rel_file)
    return exported
