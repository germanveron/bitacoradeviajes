"""Copia tus perfiles, lugares, eventos y fotos de una base local a una app publicada, usando su API.

Uso:
  .venv/bin/python tools/migrate_remote.py https://tu-app.example.com tu@email.com [--data data_local] [--dry-run]

Antes: registrate en la app publicada con ese mismo email (queda tu perfil Individual vacío).
La contraseña de la app publicada se pide por teclado (o variable MIGRATE_PASSWORD); no se guarda ni se imprime.
Se puede volver a correr: lo que ya existe en destino (mismo tipo y nombre) no se duplica.
"""
import argparse
import getpass
import http.cookiejar
import json
import mimetypes
import os
import sqlite3
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Remote:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, raw=None, ctype=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        headers = {"content-type": ctype or "application/json"} if data is not None else {}
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            sys.exit(f"Error {e.code} en {method} {path}: {detail}")

    def upload(self, path, field, filename, mime, content):
        b = uuid.uuid4().hex
        head = f'--{b}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'
        raw = head.encode() + content + f"\r\n--{b}--\r\n".encode()
        return self.call("POST", path, raw=raw, ctype=f"multipart/form-data; boundary={b}")


def open_local(data_dir: Path):
    db = sqlite3.connect(f"file:{data_dir / 'bitacora.db'}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def key(kind, item):
    return (item.get("tipo", ""), item.get("nombre", "")) if kind == "lugares" else (item.get("titulo", ""),)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url"); ap.add_argument("email")
    ap.add_argument("--data", default=str(ROOT / "data_local"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    data_dir = Path(a.data)
    db = open_local(data_dir)
    user = db.execute("SELECT * FROM users WHERE email=?", (a.email.strip().lower(),)).fetchone()
    if not user:
        sys.exit("Ese email no existe en la base local.")
    profiles = db.execute("SELECT p.* FROM profiles p JOIN members m ON m.profile_id=p.id WHERE m.user_id=? AND m.role='owner' ORDER BY p.created", (user["id"],)).fetchall()

    plan = {}
    for p in profiles:
        orden = [c.lower() for c in json.loads(p["paises_orden"])]
        rows = db.execute("SELECT * FROM items WHERE profile_id=? ORDER BY kind, created, rowid", (p["id"],)).fetchall()
        items = [(r["kind"], json.loads(r["data"])) for r in rows]
        # los países se agregan en el orden en que aparece su primer lugar: se reproduce el orden de banderas
        rank = lambda it: orden.index(it[1].get("pais", "").lower()) if it[0] == "lugares" and it[1].get("pais", "").lower() in orden else 99
        items.sort(key=lambda it: (it[0] != "lugares", rank(it)))
        plan[p["id"]] = (p, items)
        nf = sum(len(i.get("fotos", [])) for _, i in items)
        print(f"- {p['name']} ({p['kind']}): {sum(k == 'lugares' for k, _ in items)} lugares, {sum(k == 'eventos' for k, _ in items)} eventos, {nf} fotos")
    if a.dry_run:
        return print("Simulación: no se escribió nada.")

    pw = os.environ.get("MIGRATE_PASSWORD") or getpass.getpass(f"Contraseña de {a.email} en {a.url}: ")
    r = Remote(a.url)
    r.call("POST", "/api/auth/login", {"email": a.email, "password": pw})
    me = r.call("GET", "/api/me")
    remote_profiles = me["profiles"]

    done = skipped = photos = 0
    for lp, items in plan.values():
        if lp["kind"] == "personal":
            tgt = next((x for x in remote_profiles if x["kind"] == "personal"), None)
        else:
            tgt = next((x for x in remote_profiles if x["name"] == lp["name"] and x["kind"] == "shared"), None)
            if not tgt:
                tgt = {"id": r.call("POST", "/api/profiles", {"name": lp["name"]})["id"]}
        if not tgt:
            sys.exit(f"No encontré el perfil destino para “{lp['name']}”.")
        pid = tgt["id"]
        existing = {k: {key(k, i): i for i in r.call("GET", f"/api/p/{pid}/{k}")} for k in ("lugares", "eventos")}
        print(f"\nPerfil “{lp['name']}” → {pid}")
        for kind, item in items:
            fotos = item.pop("fotos", [])
            item.pop("id", None)
            cur = existing[kind].get(key(kind, item))
            if cur:
                skipped += 1
            else:
                cur = r.call("POST", f"/api/p/{pid}/{kind}", item)
                done += 1
            if cur.get("fotos"):  # ya tiene fotos en destino: no se repiten
                continue
            for ph in fotos:
                meta = db.execute("SELECT mime FROM photos WHERE id=?", (ph,)).fetchone()
                f = data_dir / "photos" / Path(ph).name
                if not f.exists():
                    print(f"  ! falta el archivo de la foto {ph}"); continue
                mime = meta["mime"] if meta else mimetypes.guess_type(f.name)[0] or "image/jpeg"
                r.upload(f"/api/p/{pid}/{kind}/{cur['id']}/fotos", "files", f.name + ".jpg", mime, f.read_bytes())
                photos += 1
            print(f"  ✓ {item.get('nombre') or item.get('titulo')}" + (f" ({len(fotos)} fotos)" if fotos else ""))

    if user["avatar"] and not me["user"].get("avatar"):
        f = data_dir / "photos" / Path(user["avatar"]).name
        if f.exists():
            r.upload("/api/me/avatar", "file", "avatar.jpg", "image/jpeg", f.read_bytes())
            print("\nFoto de perfil copiada.")
    print(f"\nListo: {done} elementos creados, {skipped} ya estaban, {photos} fotos subidas.")


if __name__ == "__main__":
    main()
