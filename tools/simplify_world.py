"""Genera web/data/world-globe.json: el mapa mundial simplificado (Douglas-Peucker sobre los arcos TopoJSON)
para que el globo gire fluido. El mapa detallado (world.json) se sigue usando con zoom alto y en los mapas por país.

Uso: python3 tools/simplify_world.py [tolerancia_en_grados] [umbral_arco_chico] [ids_protegidos_separados_por_coma]
Los países "protegidos" conservan todos sus puntos: la simplificación puede dejar inválidos algunos polígonos grandes
(Rusia, EEUU, Grecia, Antártida) y d3 los rellena como si fueran la esfera entera al girar. Verificado con una grilla de
rotaciones (ver tools/README o el historial): 0 cuadros inundados.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SMALL = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0  # grados: arcos más chicos que esto se conservan enteros
PROTECT = set(sys.argv[3].split(",")) if len(sys.argv) > 3 and sys.argv[3] else set()
SRC, DST = ROOT / "web/data/world.json", ROOT / "web/data/world-globe.json"


def dp(pts, eps):
    """Douglas-Peucker iterativo; conserva siempre el primer y el último punto."""
    n = len(pts)
    if n < 3:
        return pts
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if den == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > best:
                best, idx = d2, i
        if best > eps * eps and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(pts, keep) if k]


def main():
    deg = float(sys.argv[1]) if len(sys.argv) > 1 else 0.15
    topo = json.loads(SRC.read_text())
    tr = topo.get("transform")
    sx, sy = tr["scale"] if tr else (1, 1)  # la cuantización no es isótropa: se simplifica en grados
    def arcs_of(geom):
        found = set()
        def walk(a):
            for x in a:
                if isinstance(x, list):
                    walk(x)
                else:
                    found.add(x if x >= 0 else ~x)
        walk(geom.get("arcs", []))
        return found
    protected = set()
    for g in topo["objects"]["countries"]["geometries"]:
        if str(g.get("id")) in PROTECT:
            protected |= arcs_of(g)
    before = after = 0
    out = []
    for idx, arc in enumerate(topo["arcs"]):
        abs_pts, x, y = [], 0, 0
        for dx, dy in arc:
            x, y = (x + dx, y + dy) if tr else (dx, dy)
            abs_pts.append((x, y))
        geo_pts = [(a * sx, b * sy) for a, b in abs_pts]
        xs, ys = [q[0] for q in geo_pts], [q[1] for q in geo_pts]
        small = (max(xs) - min(xs) < SMALL and max(ys) - min(ys) < SMALL) or idx in protected  # islas, microestados y países protegidos: no se tocan
        s = abs_pts if small else [(a / sx, b / sy) for a, b in dp(geo_pts, deg)]
        before += len(abs_pts)
        after += len(s)
        if tr:
            enc, px, py = [], 0, 0
            for qx, qy in s:
                qx, qy = round(qx), round(qy)
                enc.append([qx - px, qy - py])
                px, py = qx, qy
            out.append(enc)
        else:
            out.append([list(p) for p in s])
    topo["arcs"] = out
    DST.write_text(json.dumps(topo, separators=(",", ":")))
    print(f"arcos: {before} -> {after} puntos ({after / before:.0%}); {DST.stat().st_size // 1024} KB (original {SRC.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
