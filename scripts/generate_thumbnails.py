#!/usr/bin/env python3
"""
generate_thumbnails.py

Genera thumbnail PNG (dalla versione tris) per ogni mesh in una cartella
di input e costruisce/aggiorna meshes/manifest.json per il mesh viewer.

Convenzione attesa nella cartella di input, per ogni mesh "stem":
    stem.obj                  -> tris, usata SOLO per generare la thumbnail
    stem_quad.obj              -> quadrangolazione (visualizzata flat-shaded)
    stem_primal_layout.obj     -> primal layout (visualizzato solo bordi)
    stem_dual_layout.obj       -> dual layout (visualizzato solo bordi)

Tutti i file tranne stem.obj sono opzionali: il manifest registra solo
le varianti effettivamente presenti, e il viewer disabilita gli stati
non disponibili per quella mesh.

Uso:
    python3 generate_thumbnails.py --input /path/to/obj_folder --output /path/to/mesh-viewer-template
"""

import argparse
import json
import os
import shutil
import sys

os.environ.setdefault("PYOPENGL_PLATFORM", "egl")

import numpy as np
import trimesh
import pyrender
from PIL import Image


THUMB_SIZE = 320
BG_COLOR = (26, 26, 26, 255)   # matches --bg-app from style.css
MESH_COLOR = [0.72, 0.74, 0.73, 1.0]  # matches the flat material in viewer.js

SUFFIXES = {
    "quad": "_quad.obj",
    "primal": "_primal_layout.obj",
    "dual": "_dual_layout.obj",
}


def find_mesh_entries(input_dir):
    """
    Returns list of dicts: {id, name, tris_filename, quad_filename, primal_filename, dual_filename}
    Each variant filename is None if not present.
    A mesh "stem" is identified by a plain `<stem>.obj` file (the tris/preview file)
    that is not itself one of the suffixed variants.
    """
    all_files = set(f for f in os.listdir(input_dir) if f.lower().endswith(".obj"))

    suffixed_files = set()
    for suf in SUFFIXES.values():
        suffixed_files |= {f for f in all_files if f.lower().endswith(suf.lower())}

    tris_files = sorted(f for f in all_files if f not in suffixed_files)

    entries = []
    for tris_f in tris_files:
        stem = tris_f[:-4]  # strip ".obj"
        variant_files = {}
        for key, suf in SUFFIXES.items():
            candidate = f"{stem}{suf}"
            variant_files[key] = candidate if candidate in all_files else None

        entries.append({
            "id": stem,
            "name": stem,
            "tris_filename": tris_f,
            "quad_filename": variant_files["quad"],
            "primal_filename": variant_files["primal"],
            "dual_filename": variant_files["dual"],
        })
    return entries


def render_thumbnail(obj_path, out_png_path, size=THUMB_SIZE):
    mesh = trimesh.load(obj_path, force="mesh", process=False)

    if mesh.is_empty:
        raise ValueError(f"Empty mesh: {obj_path}")

    # Center and scale to unit-ish box for consistent framing
    mesh.vertices -= mesh.bounding_box.centroid
    scale = 1.0 / max(mesh.extents.max(), 1e-8)
    mesh.vertices *= scale

    pmesh = pyrender.Mesh.from_trimesh(mesh, smooth=False, material=pyrender.MetallicRoughnessMaterial(
        baseColorFactor=MESH_COLOR,
        metallicFactor=0.0,
        roughnessFactor=1.0,
        doubleSided=True,  # avoid blank thumbnails when face normals are inconsistent
    ))

    scene = pyrender.Scene(bg_color=[c / 255 for c in BG_COLOR], ambient_light=[0.35, 0.35, 0.35])
    scene.add(pmesh)

    # Camera framing: 3/4 view, distance based on bounding sphere
    radius = np.linalg.norm(mesh.extents) * 0.6
    cam_dist = radius * 2.6 + 0.5
    eye = np.array([cam_dist * 0.62, cam_dist * 0.47, cam_dist * 0.82])
    target = np.array([0.0, 0.0, 0.0])
    up = np.array([0.0, 1.0, 0.0])

    def look_at(eye, target, up):
        f = (target - eye)
        f = f / np.linalg.norm(f)
        s = np.cross(f, up)
        s = s / (np.linalg.norm(s) + 1e-8)
        u = np.cross(s, f)
        rot = np.array([s, u, -f])
        cam_pose = np.eye(4)
        cam_pose[:3, :3] = rot.T
        cam_pose[:3, 3] = eye
        return cam_pose

    cam_pose = look_at(eye, target, up)

    camera = pyrender.PerspectiveCamera(yfov=np.radians(35), aspectRatio=1.0)
    scene.add(camera, pose=cam_pose)

    key_light = pyrender.DirectionalLight(color=np.ones(3), intensity=4.0)
    scene.add(key_light, pose=cam_pose)

    fill_pose = np.eye(4)
    fill_pose[:3, 3] = [-cam_dist * 0.5, cam_dist * 0.2, -cam_dist * 0.3]
    fill_light = pyrender.DirectionalLight(color=np.ones(3), intensity=1.5)
    scene.add(fill_light, pose=fill_pose)

    renderer = pyrender.OffscreenRenderer(size, size)
    color, _ = renderer.render(scene)
    renderer.delete()

    img = Image.fromarray(color)
    img.save(out_png_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Folder containing the mesh .obj files")
    parser.add_argument("--output", required=True, help="mesh-viewer-template root folder")
    parser.add_argument("--skip-existing", action="store_true",
                         help="Skip thumbnail generation if PNG already exists")
    args = parser.parse_args()

    input_dir = args.input
    output_root = args.output
    meshes_dir = os.path.join(output_root, "meshes")
    thumbs_dir = os.path.join(meshes_dir, "thumbnails")
    os.makedirs(meshes_dir, exist_ok=True)
    os.makedirs(thumbs_dir, exist_ok=True)

    entries = find_mesh_entries(input_dir)
    if not entries:
        print(f"No .obj files found in {input_dir}")
        sys.exit(1)

    print(f"Found {len(entries)} mesh(es).")

    n_with_quad = sum(1 for e in entries if e["quad_filename"])
    n_with_primal = sum(1 for e in entries if e["primal_filename"])
    n_with_dual = sum(1 for e in entries if e["dual_filename"])
    print(f"  with quad:   {n_with_quad}")
    print(f"  with primal: {n_with_primal}")
    print(f"  with dual:   {n_with_dual}")

    manifest_entries = []
    for i, entry in enumerate(entries):
        stem = entry["id"]

        # Copy tris (used for thumbnail only, not loaded in viewer by default)
        src_tris = os.path.join(input_dir, entry["tris_filename"])

        # Copy whichever variants are present
        rel_paths = {}
        for key, filename_key in [("quad", "quad_filename"), ("primal", "primal_filename"), ("dual", "dual_filename")]:
            fname = entry[filename_key]
            if fname:
                shutil.copy2(os.path.join(input_dir, fname), os.path.join(meshes_dir, fname))
                rel_paths[key] = f"./meshes/{fname}"
            else:
                rel_paths[key] = None

        thumb_filename = f"{stem}.png"
        thumb_path = os.path.join(thumbs_dir, thumb_filename)

        if args.skip_existing and os.path.exists(thumb_path):
            print(f"[{i+1}/{len(entries)}] skip (exists): {stem}")
        else:
            print(f"[{i+1}/{len(entries)}] rendering: {stem}")
            try:
                render_thumbnail(src_tris, thumb_path)
            except Exception as e:
                print(f"  !! failed to render {stem}: {e}")
                continue

        manifest_entries.append({
            "id": stem,
            "name": stem,
            "quad": rel_paths["quad"],
            "primal": rel_paths["primal"],
            "dual": rel_paths["dual"],
            "thumbnail": f"./meshes/thumbnails/{thumb_filename}",
        })

    manifest_path = os.path.join(meshes_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump({"meshes": manifest_entries}, f, indent=2)

    print(f"\nWrote manifest with {len(manifest_entries)} entries -> {manifest_path}")


if __name__ == "__main__":
    main()
