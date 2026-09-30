"""Build the photo-realistic talking-portrait asset used by the Zayed front end.

Takes a front-facing head-and-shoulders photo and writes, next to ``--out``:

* ``<out>.webp`` — square crop with the background removed (alpha channel).
* ``<out>.json`` — a warp mesh (face landmarks + surrounding grid), its triangles,
  and per-vertex displacement bases (jaw, wide, round, blinkL, blinkR) plus a head
  weight. ``static/js/portrait.js`` blends these bases in real time from Azure
  Speech visemes.

This is an offline authoring tool; its extra dependencies are not needed to run the
server::

    pip install mediapipe==0.10.14 rembg==2.0.59 opencv-python-headless scipy
    python tools/build_portrait.py photo.png --crop 185,10,940 --out static/avatar/zayed
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy.spatial import Delaunay

SIZE = 1024
# fmt: off
UPPER_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LOWER_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
UPPER_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LOWER_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]
EYES = {
    "blinkL": ([33, 246, 161, 160, 159, 158, 157, 173, 133], [33, 7, 163, 144, 145, 153, 154, 155, 133], 105),
    "blinkR": ([263, 466, 388, 387, 386, 385, 384, 398, 362], [263, 249, 390, 373, 374, 380, 381, 382, 362], 334),
}
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]
# fmt: on


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def curve_y(points: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Interpolate the y of a left-to-right polyline at ``x``."""
    order = np.argsort(points[:, 0])
    return np.interp(x, points[order, 0], points[order, 1])


def face_triangles(face: np.ndarray) -> list[tuple[int, int, int]]:
    """MediaPipe's canonical tesselation (mouth left open) plus filled eyes."""
    adjacency: dict[int, set[int]] = {}
    for a, b in mp.solutions.face_mesh.FACEMESH_TESSELATION:
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)
    tris = {tuple(sorted((a, b, c))) for a in adjacency for b in adjacency[a] for c in adjacency[a] & adjacency[b]}
    for upper, lower, _ in EYES.values():
        ring = upper + lower[::-1][1:-1]
        iris = list(range(468, 473)) if 33 in upper else list(range(473, 478))
        ids = np.array(ring + iris)
        poly = (face[ring] * SIZE).astype(np.float32).reshape(-1, 1, 2)
        for t in Delaunay(face[ids]).simplices:
            cx, cy = face[ids[t]].mean(axis=0) * SIZE
            if cv2.pointPolygonTest(poly, (float(cx), float(cy)), False) >= 0:
                tris.add(tuple(sorted(int(i) for i in ids[t])))
    return sorted(tris)


def outer_triangles(uv: np.ndarray, n_face: int, n_mid: int, oval_px: np.ndarray) -> list[tuple[int, int, int]]:
    """Delaunay triangles covering everything outside the face outline."""
    ids = np.array(FACE_OVAL + list(range(n_face, len(uv))))
    out = []
    for t in Delaunay(uv[ids]).simplices:
        cx, cy = uv[ids[t]].mean(axis=0) * SIZE
        if cv2.pointPolygonTest(oval_px, (float(cx), float(cy)), False) < 0:
            out.append(tuple(int(i) for i in ids[t]))
    return out


def build(image: Path, crop: tuple[int, int, int], out: Path) -> None:
    x0, y0, side = crop
    src = cv2.imread(str(image))
    rgb = cv2.cvtColor(
        cv2.resize(src[y0 : y0 + side, x0 : x0 + side], (SIZE, SIZE), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB
    )

    mask = np.array(remove(Image.fromarray(rgb), session=new_session("u2net_human_seg"), only_mask=True))
    mask = cv2.GaussianBlur(cv2.erode(mask, np.ones((3, 3), np.uint8)), (3, 3), 0)
    Image.fromarray(np.dstack([rgb, mask])).save(out.with_suffix(".webp"), quality=92, method=6)

    with mp.solutions.face_mesh.FaceMesh(static_image_mode=True, refine_landmarks=True, max_num_faces=1) as mesh:
        found = mesh.process(rgb).multi_face_landmarks
    if not found:
        raise SystemExit("No face found in the image.")
    face = np.array([(p.x, p.y) for p in found[0].landmark], dtype=np.float64)

    oval = face[FACE_OVAL]
    fw = np.linalg.norm(face[454] - face[234])
    # Densify the face outline so the outer Delaunay triangulation conforms to it.
    ring = np.roll(np.array(FACE_OVAL), -1)
    mids = [face[a] + (face[b] - face[a]) * k / 4 for a, b in zip(FACE_OVAL, ring) for k in (1, 2, 3)]
    mid_parents = [(a, b, k / 4) for a, b in zip(FACE_OVAL, ring) for k in (1, 2, 3)]
    grid = np.stack(np.meshgrid(np.linspace(0, 1, 33), np.linspace(0, 1, 33)), -1).reshape(-1, 2)
    oval_px = (oval * SIZE).astype(np.float32).reshape(-1, 1, 2)
    keep = [
        cv2.pointPolygonTest(oval_px, (float(gx * SIZE), float(gy * SIZE)), True) < -0.06 * fw * SIZE for gx, gy in grid
    ]
    uv = np.concatenate([face, np.array(mids), grid[keep]])
    n_face, n_mid = len(face), len(mids)
    triangles = face_triangles(face) + outer_triangles(uv, n_face, n_mid, oval_px)
    verts = uv.copy()
    # Close the lip seam at rest so the mouth cavity has no area until the jaw opens.
    seam = UPPER_INNER[1:-1] + LOWER_INNER[1:-1]
    verts[seam, 1] = (curve_y(face[UPPER_INNER], verts[seam, 0]) + curve_y(face[LOWER_INNER], verts[seam, 0])) / 2
    x, y = verts[:, 0], verts[:, 1]
    n_face = len(face)

    # Jaw: everything below the lip line moves down, fading toward the cheeks and down the neck.
    mouth = (face[13] + face[14]) / 2
    corners_x = sorted((face[78][0], face[308][0]))
    lip_line = curve_y((face[UPPER_INNER] + face[LOWER_INNER]) / 2, x)
    below = (y > lip_line + 1e-4) | np.isin(np.arange(len(verts)), LOWER_INNER[1:-1] + LOWER_OUTER[1:-1])
    below &= ~np.isin(np.arange(len(verts)), UPPER_INNER[1:-1] + UPPER_OUTER[1:-1])
    half = (corners_x[1] - corners_x[0]) / 2
    dx = np.abs(x - mouth[0])
    lips = np.sqrt(np.clip(1 - (dx / (half * 1.08)) ** 2, 0, 1)) * 0.75 + 0.25 * (dx < half)
    rigid = 1 - smoothstep(0.25 * fw, 0.62 * fw, dx)
    horiz = np.where(dx < half * 1.08, lips, 0.0) + (rigid - np.where(dx < half * 1.08, lips, 0.0)) * smoothstep(
        lip_line + 0.02 * fw, lip_line + 0.16 * fw, y
    )
    chin_y = face[152][1]
    neck = 1 - smoothstep(chin_y, chin_y + 0.45 * fw, y)
    corner = np.isin(np.arange(len(verts)), [78, 308, 61, 291])
    jaw_w = np.where(below, horiz * neck, 0.0)
    jaw_w = np.where(corner, 0.35, jaw_w)
    upper_lip = np.isin(np.arange(len(verts)), UPPER_INNER[1:-1])
    jaw = np.zeros_like(verts)
    jaw[:, 1] = 0.11 * fw * jaw_w - 0.015 * fw * upper_lip * lips
    jaw[:, 0] = -0.01 * fw * jaw_w * np.sign(x - mouth[0]) * horiz

    # Lip width (wide / round): horizontal stretch around the mouth.
    radial = 1 - smoothstep(0.1 * fw, 0.42 * fw, np.hypot((x - mouth[0]) * 0.8, y - mouth[1]))
    spread = np.clip((x - mouth[0]) / half, -1, 1) * radial
    wide = np.zeros_like(verts)
    wide[:, 0] = 0.05 * fw * spread
    rnd = np.zeros_like(verts)
    rnd[:, 0] = -0.07 * fw * spread
    rnd[:, 1] = 0.012 * fw * np.where(below, -1.0, 1.0) * radial * (np.abs(x - mouth[0]) < half)

    bases = {"jaw": jaw, "wide": wide, "round": rnd}

    # Blinks: upper lid falls onto the lower lid, eyelid skin follows up to the brow.
    for name, (upper, lower, brow) in EYES.items():
        up, lo = face[upper], face[lower]
        ex0, ex1 = up[:, 0].min(), up[:, 0].max()
        inside_x = (x >= ex0) & (x <= ex1)
        uy, ly = curve_y(up, x), curve_y(lo, x)
        gap = np.maximum(ly - uy, 0)
        t = np.clip((ly - y) / np.maximum(gap, 1e-6), 0, 1)
        skin = 1 - smoothstep(0, max(uy.mean() - face[brow][1], 1e-3) * 0.9, uy - y)
        fade_x = 1 - smoothstep(0, 0.03 * fw, np.maximum(ex0 - x, x - ex1))
        weight = np.where(y >= uy, t, skin) * np.where(inside_x, 1.0, fade_x) * (np.arange(len(verts)) < n_face)
        weight = np.where(y > ly + 1e-4, 0.0, weight)
        blink = np.zeros_like(verts)
        blink[:, 1] = weight * gap * 0.97
        bases[name] = blink

    head = 1 - smoothstep(chin_y + 0.02, chin_y + 0.3, y)

    # Outline midpoints stay on their outline edge so the two triangulations never crack.
    for i, (pa, pb, t) in enumerate(mid_parents):
        v = n_face + i
        for basis in bases.values():
            basis[v] = basis[pa] * (1 - t) + basis[pb] * t
        head[v] = head[pa] * (1 - t) + head[pb] * t
    tri = np.array(triangles)

    def r(a: np.ndarray) -> list:
        return np.round(a, 5).ravel().tolist()

    payload = {
        "size": SIZE,
        "vertices": r(verts),
        "uv": r(uv),
        "triangles": tri.astype(int).ravel().tolist(),
        "bases": {k: r(v) for k, v in bases.items()},
        "head": r(head),
        "mouth": {"upper": UPPER_INNER, "lower": LOWER_INNER[::-1][1:-1], "center": r(mouth)},
        "pivot": r(np.array([mouth[0], chin_y + 0.08])),
        "eyes": {k: r(face[[v[0][0], v[0][-1]]].mean(axis=0)) for k, v in EYES.items()},
        "face_width": round(float(fw), 5),
    }
    out.with_suffix(".json").write_text(json.dumps(payload, separators=(",", ":")))
    print(f"{len(verts)} vertices, {len(tri)} triangles")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("image", type=Path)
    parser.add_argument("--crop", default="0,0,0", help="x,y,side of the square crop in source pixels")
    parser.add_argument("--out", type=Path, default=Path("static/avatar/zayed"))
    args = parser.parse_args()
    x0, y0, side = (int(v) for v in args.crop.split(","))
    if side <= 0:
        h, w = cv2.imread(str(args.image)).shape[:2]
        side = min(h, w)
    build(args.image, (x0, y0, side), args.out)


if __name__ == "__main__":
    main()
