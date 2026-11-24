"""Shared Blender 5.3+ procedural builder helpers for Rake Me.

Rules (AGENTS.md / DESIGN.md Section 8):
- Only ever create/modify scene `RM_Build` and datablocks prefixed `RM_`.
- Never call `read_factory_settings` in live Blender; never touch user scenes.
- Look up shader nodes by `node.type` (never localized `name`).
- Inspect glTF exporter enum/property options dynamically.
- Canonical coordinates passed to helpers are Y-up (glTF/DESIGN.md):
    (x = right, y = up, z = forward)
  Mapped cleanly into Blender Z-up as:
    (x, -z, y)
  so glTF export with `export_yup=True` produces exact DESIGN.md coordinates.
"""

from __future__ import annotations

import json
import math
import os
import random
from pathlib import Path
from typing import Any

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "assets" / "models.spec.json"
RAMPS_PATH = REPO_ROOT / "assets" / "ramps.json"
MODELS_OUT_DIR = REPO_ROOT / "public" / "assets" / "models"

SCENE_NAME = "RM_Build"
PREFIX = "RM_"

# Track ONLY datablocks created by the current build run so cleanup never touches user data.
_CREATED_SCENE = False
_OWNED_OBJECTS: set[bpy.types.Object] = set()
_OWNED_MESHES: set[bpy.types.Mesh] = set()
_OWNED_MATERIALS: set[bpy.types.Material] = set()
_MATERIAL_MAP: dict[str, bpy.types.Material] = {}

# Afternoon palette slots (DESIGN.md 2.6) for preview base colors in Blender / viewers
AFTERNOON_PALETTE_HEX = [
    "#8a7350", "#b39a6b", "#d9c492", "#ecdcae", "#f7edcb",
    "#3b3a40", "#5f5d63", "#8b8a8a", "#b9b6ac",
    "#3a2218", "#6b3f26", "#9a6238", "#c98f54",
    "#2f4a2a", "#4f7436", "#7fa04a", "#b4c96a",
    "#6fa3b5", "#a9cdbf", "#e6e2b8",
    "#2f5d74", "#4f8ea0", "#bfe3dc",
    "#a8432a", "#e2783a", "#f8c860",
    "#3f5a36", "#6a8a4a", "#9db46a", "#e8dcae",
    "#2a1d1a", "#f4ead0",
]

VARIANT_GUBBA_HEX = {
    "moss": ["#3f5a36", "#6a8a4a", "#9db46a", "#e8dcae"],
    "kasa": ["#6b4a2e", "#a8743c", "#d4a45c", "#f0dcae"],
    "lantern": ["#3d3a55", "#67648a", "#9a98b8", "#e4dcd0"],
}


def hex_to_linear_rgba(hex_str: str) -> tuple[float, float, float, float]:
    h = hex_str.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))

    def srgb_to_lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return (srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b), 1.0)


def load_ramps() -> dict[str, Any]:
    return json.loads(RAMPS_PATH.read_text(encoding="utf-8"))["ramps"]


def load_spec() -> dict[str, Any]:
    return json.loads(SPEC_PATH.read_text(encoding="utf-8"))


def to_blender_pos(x: float, y: float, z: float) -> Vector:
    """Convert glTF Y-up (x, y, z) to Blender Z-up (x, -z, y)."""
    return Vector((x, -z, y))


def to_blender_rot(rx: float = 0.0, ry: float = 0.0, rz: float = 0.0) -> Matrix:
    """Convert glTF Y-up rotation (rx about X, ry about Y, rz about Z; applied X -> Z -> Y)
    into a Blender Z-up 4x4 rotation matrix."""
    # Coordinate change matrix C: blender_v = C * gltf_v
    # C = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
    C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    C_inv = C.inverted()
    Rx = Matrix.Rotation(rx, 4, "X")
    Ry = Matrix.Rotation(ry, 4, "Y")
    Rz = Matrix.Rotation(rz, 4, "Z")
    R_gltf = Ry @ Rz @ Rx
    return C @ R_gltf @ C_inv


def get_or_create_build_scene() -> tuple[bpy.types.Scene, bpy.types.Scene]:
    global _CREATED_SCENE
    prev_scene = bpy.context.window.scene if bpy.context.window else bpy.context.scene
    scene = bpy.data.scenes.get(SCENE_NAME)
    if scene is None:
        scene = bpy.data.scenes.new(SCENE_NAME)
        _CREATED_SCENE = True
    else:
        _CREATED_SCENE = False
    if bpy.context.window:
        bpy.context.window.scene = scene
    return scene, prev_scene


def register_owned_object(obj: bpy.types.Object) -> bpy.types.Object:
    _OWNED_OBJECTS.add(obj)
    return obj


def clear_rm_objects(scene: bpy.types.Scene) -> None:
    """Remove only objects & meshes created by the current build run."""
    for obj in list(_OWNED_OBJECTS):
        try:
            # Never remove an object that is also linked into another user scene
            if obj.name in bpy.data.objects:
                other_scenes = [s for s in bpy.data.scenes if s != scene and obj.name in s.objects]
                if other_scenes:
                    if obj.name in scene.collection.objects:
                        scene.collection.objects.unlink(obj)
                else:
                    bpy.data.objects.remove(obj, do_unlink=True)
        except ReferenceError:
            pass
    _OWNED_OBJECTS.clear()
    for mesh in list(_OWNED_MESHES):
        try:
            if mesh.name in bpy.data.meshes and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
                _OWNED_MESHES.discard(mesh)
        except ReferenceError:
            _OWNED_MESHES.discard(mesh)


def cleanup_all_rm(prev_scene: bpy.types.Scene | None = None) -> None:
    """Clean up only the datablocks created by the current build run."""
    global _CREATED_SCENE
    scene = bpy.data.scenes.get(SCENE_NAME)
    if scene is not None:
        clear_rm_objects(scene)
        if prev_scene is not None and prev_scene.name != SCENE_NAME and bpy.context.window:
            bpy.context.window.scene = prev_scene
        if _CREATED_SCENE and len(scene.objects) == 0 and len(bpy.data.scenes) > 1:
            bpy.data.scenes.remove(scene, do_unlink=True)
    _CREATED_SCENE = False
    for mesh in list(_OWNED_MESHES):
        try:
            if mesh.name in bpy.data.meshes and mesh.users == 0:
                bpy.data.meshes.remove(mesh)
        except ReferenceError:
            pass
    _OWNED_MESHES.clear()
    for mat in list(_OWNED_MATERIALS):
        try:
            if mat.name in bpy.data.materials and mat.users == 0:
                bpy.data.materials.remove(mat)
        except ReferenceError:
            pass
    _OWNED_MATERIALS.clear()
    _MATERIAL_MAP.clear()


def get_ramp_material(ramp_name: str, gubba_variant: str = "moss") -> bpy.types.Material:
    """Create or reuse an owned material named `rm_<ramp_name>` without mutating user materials."""
    mat_name = f"rm_{ramp_name}"
    ramps = load_ramps()
    slots = ramps[ramp_name]["slots"]
    mid_slot = slots[len(slots) // 2]

    palette = list(AFTERNOON_PALETTE_HEX)
    if gubba_variant in VARIANT_GUBBA_HEX:
        palette[26:30] = VARIANT_GUBBA_HEX[gubba_variant]
    rgba = hex_to_linear_rgba(palette[mid_slot])

    mat = _MATERIAL_MAP.get(mat_name)
    if mat is not None:
        try:
            if mat.name not in bpy.data.materials:
                mat = None
        except ReferenceError:
            mat = None
    if mat is None:
        mat = bpy.data.materials.new(name=mat_name)
        _OWNED_MATERIALS.add(mat)
        _MATERIAL_MAP[mat_name] = mat
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        base_input = next((inp for inp in bsdf.inputs if inp.name == "Base Color"), None)
        if base_input is None and len(bsdf.inputs) > 0:
            base_input = bsdf.inputs[0]
        if base_input is not None:
            base_input.default_value = rgba
        rough_input = next((inp for inp in bsdf.inputs if inp.name == "Roughness"), None)
        if rough_input is not None:
            rough_input.default_value = 0.92
    mat.diffuse_color = rgba
    return mat


def make_empty(
    scene: bpy.types.Scene,
    name: str,
    pos: tuple[float, float, float] = (0.0, 0.0, 0.0),
    parent: bpy.types.Object | None = None,
    extras: dict[str, Any] | None = None,
) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 2.0
    scene.collection.objects.link(obj)
    _OWNED_OBJECTS.add(obj)
    obj.location = to_blender_pos(*pos)
    if parent is not None:
        obj.parent = parent
    if extras:
        for k, v in extras.items():
            obj[k] = v
    return obj


def _finalize_bmesh_object(
    scene: bpy.types.Scene,
    bm: bmesh.types.BMesh,
    name: str,
    ramp: str,
    smooth: bool = False,
    parent: bpy.types.Object | None = None,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    extras: dict[str, Any] | None = None,
    gubba_variant: str = "moss",
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{PREFIX}{name}_mesh")
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()

    for poly in mesh.polygons:
        poly.use_smooth = smooth

    mat = get_ramp_material(ramp, gubba_variant=gubba_variant)
    mesh.materials.append(mat)

    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.location = to_blender_pos(*location)
    if parent is not None:
        obj.parent = parent
    if extras:
        for k, v in extras.items():
            obj[k] = v
    return obj


def add_box_to_bmesh(
    bm: bmesh.types.BMesh,
    size: tuple[float, float, float],
    center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    mat_idx: int = 0,
) -> None:
    """Add a box of glTF Y-up size (sx, sy, sz) at Y-up center with Y-up Euler (rx, ry, rz)."""
    sx, sy, sz = size
    # In Blender coords: X=sx, Y=sz, Z=sy
    scale_m = Matrix.Diagonal((sx, sz, sy, 1.0))
    rot_m = to_blender_rot(*rot)
    trans_m = Matrix.Translation(to_blender_pos(*center))
    xform = trans_m @ rot_m @ scale_m
    ret = bmesh.ops.create_cube(bm, size=1.0, matrix=xform)
    verts = set(ret["verts"])
    for f in bm.faces:
        if all(v in verts for v in f.verts):
            f.material_index = mat_idx


def add_prism_to_bmesh(
    bm: bmesh.types.BMesh,
    r_bottom: float,
    r_top: float,
    height: float,
    segments: int = 8,
    base_center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    mat_idx: int = 0,
) -> None:
    """Add a frustum/cylinder along glTF +Y from y=0 to y=height at base_center."""
    # Blender create_cone builds along Z from -depth/2 to +depth/2
    local_shift = Matrix.Translation(Vector((0.0, 0.0, height * 0.5)))
    rot_m = to_blender_rot(*rot)
    trans_m = Matrix.Translation(to_blender_pos(*base_center))
    xform = trans_m @ rot_m @ local_shift
    ret = bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=segments,
        radius1=r_bottom,
        radius2=r_top,
        depth=height,
        matrix=xform,
    )
    verts = set(ret["verts"])
    for f in bm.faces:
        if all(v in verts for v in f.verts):
            f.material_index = mat_idx


def add_ellipsoid_to_bmesh(
    bm: bmesh.types.BMesh,
    radii: tuple[float, float, float],
    center: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rot: tuple[float, float, float] = (0.0, 0.0, 0.0),
    segments: int = 10,
    rings: int = 6,
    mat_idx: int = 0,
    jitter_seed: int | None = None,
    jitter_xz: float = 0.15,
    jitter_y: float = 0.1,
) -> None:
    """Add a low-poly ellipsoid of glTF Y-up radii (rx, ry, rz) at center."""
    rx, ry, rz = radii
    ret = bmesh.ops.create_uvsphere(
        bm,
        u_segments=segments,
        v_segments=rings,
        radius=1.0,
    )
    verts = ret["verts"]
    rng = random.Random(jitter_seed) if jitter_seed is not None else None
    scale_m = Matrix.Diagonal((rx, rz, ry, 1.0))
    rot_m = to_blender_rot(*rot)
    trans_m = Matrix.Translation(to_blender_pos(*center))
    xform = trans_m @ rot_m @ scale_m
    for v in verts:
        co = v.co.copy()
        if rng is not None and abs(co.z) < 0.99:
            k_xy = 1.0 + (rng.random() - 0.5) * 2.0 * jitter_xz
            k_z = 1.0 + (rng.random() - 0.5) * 2.0 * jitter_y
            co.x *= k_xy
            co.y *= k_xy
            co.z *= k_z
        v.co = xform @ co
    vset = set(verts)
    for f in bm.faces:
        if all(v in vset for v in f.verts):
            f.material_index = mat_idx


def build_mesh_obj(
    scene: bpy.types.Scene,
    name: str,
    parts: list[dict[str, Any]],
    ramps: list[str],
    smooth: bool = False,
    parent: bpy.types.Object | None = None,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    extras: dict[str, Any] | None = None,
    gubba_variant: str = "moss",
) -> bpy.types.Object:
    """Build a single Blender object from multiple primitive specs sharing ramp materials."""
    bm = bmesh.new()
    for spec in parts:
        kind = spec["kind"]
        mat_idx = spec.get("mat", 0)
        rot = spec.get("rot", (0.0, 0.0, 0.0))
        if kind == "box":
            add_box_to_bmesh(bm, spec["size"], spec.get("center", (0, 0, 0)), rot, mat_idx)
        elif kind == "prism":
            add_prism_to_bmesh(
                bm,
                spec["r0"],
                spec["r1"],
                spec["h"],
                spec.get("seg", 8),
                spec.get("base", (0, 0, 0)),
                rot,
                mat_idx,
            )
        elif kind == "ell":
            add_ellipsoid_to_bmesh(
                bm,
                spec["radii"],
                spec.get("center", (0, 0, 0)),
                rot,
                spec.get("seg", 10),
                spec.get("rings", 6),
                mat_idx,
                spec.get("seed"),
                spec.get("jxz", 0.15),
                spec.get("jy", 0.1),
            )
    mesh = bpy.data.meshes.new(f"{PREFIX}{name}_mesh")
    _OWNED_MESHES.add(mesh)
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()

    for poly in mesh.polygons:
        poly.use_smooth = smooth

    for rname in ramps:
        mesh.materials.append(get_ramp_material(rname, gubba_variant=gubba_variant))

    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    _OWNED_OBJECTS.add(obj)
    obj.location = to_blender_pos(*location)
    if parent is not None:
        obj.parent = parent
    if extras:
        for k, v in extras.items():
            obj[k] = v
    return obj


def export_objects_glb(scene: bpy.types.Scene, objects: list[bpy.types.Object], out_path: Path) -> None:
    """Export the given objects as a clean, deterministic Y-up GLB."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    for obj in scene.objects:
        obj.select_set(False)
    for obj in objects:
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]

    # Inspect glTF exporter RNA dynamically (DESIGN.md 8.1)
    op_rna = bpy.ops.export_scene.gltf.get_rna_type()
    valid_props = {p.identifier: p for p in op_rna.properties}

    kwargs: dict[str, Any] = {
        "filepath": str(out_path),
    }

    if "export_format" in valid_props:
        fmt_items = [e.identifier for e in valid_props["export_format"].enum_items]
        if fmt_items:
            kwargs["export_format"] = "GLB" if "GLB" in fmt_items else fmt_items[0]
        else:
            kwargs["export_format"] = "GLB"

    desired = {
        "use_selection": True,
        "use_active_scene": True,
        "export_yup": True,
        "export_apply": True,
        "export_extras": True,
        "export_texcoords": False,
        "export_normals": True,
        "export_tangents": False,
        "export_materials": "EXPORT",
        "export_image_format": "NONE",
        "export_animations": False,
        "export_skins": False,
        "export_morph": False,
        "export_cameras": False,
        "export_lights": False,
        "export_draco_mesh_compression_enable": False,
    }
    for key, val in desired.items():
        if key not in valid_props:
            continue
        prop = valid_props[key]
        if prop.type == "ENUM":
            enum_ids = [e.identifier for e in prop.enum_items]
            if not enum_ids or val in enum_ids:
                kwargs[key] = val
        else:
            kwargs[key] = val

    view_layer = scene.view_layers[0]
    with bpy.context.temp_override(
        scene=scene,
        view_layer=view_layer,
        selected_objects=objects,
        selected_editable_objects=objects,
        active_object=objects[0] if objects else None,
    ):
        bpy.ops.export_scene.gltf(**kwargs)
