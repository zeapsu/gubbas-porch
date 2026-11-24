"""Entry point for building all 30 Rake Me `.glb` assets in Blender 5.3+.

Usage:
- Live Blender MCP:
    import runpy, sys
    sys.argv = ["build_all.py"]
    runpy.run_path("<repo>/scripts/blender/build_all.py", run_name="__main__")
- Headless CLI:
    blender -b --factory-startup -P scripts/blender/build_all.py -- [--only rakes|props|gubba] [--keep]
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from build_gubba import build_all_gubbas  # noqa: E402
from build_props import build_all_props  # noqa: E402
from build_rakes import build_all_rakes  # noqa: E402
from rm_common import cleanup_all_rm, get_or_create_build_scene  # noqa: E402


def parse_args(argv: list[str]) -> tuple[str | None, bool]:
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    only = None
    keep = False
    i = 0
    while i < len(argv):
        if argv[i] == "--only" and i + 1 < len(argv):
            only = argv[i + 1]
            i += 2
        elif argv[i] == "--keep":
            keep = True
            i += 1
        else:
            i += 1
    return only, keep


def main() -> None:
    only, keep = parse_args(sys.argv[1:])
    scene, prev_scene = get_or_create_build_scene()
    exported: list[str] = []
    try:
        if only in (None, "rakes"):
            exported.extend(build_all_rakes(scene))
        if only in (None, "props"):
            exported.extend(build_all_props(scene))
        if only in (None, "gubba"):
            exported.extend(build_all_gubbas(scene))
    finally:
        if not keep:
            cleanup_all_rm(prev_scene)
    print(f"RM_BUILD_DONE: exported {len(exported)} models: {', '.join(exported)}")


if __name__ == "__main__":
    main()
