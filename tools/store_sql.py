"""Lugares, eventos y fotos por perfil, sobre SQLite."""
import json
import mimetypes
from pathlib import Path

from .auth import new_uid, now_iso
from .db import PHOTOS, connect
from .models import clean, new_id

SEED = Path(__file__).resolve().parent / "seed"


def _row(r):
    d = json.loads(r["data"])
    d["id"] = r["id"]
    return d


def list_items(pid, kind):
    with connect() as db:
        rows = db.execute("SELECT * FROM items WHERE profile_id=? AND kind=? ORDER BY created, rowid", (pid, kind)).fetchall()
    return [_row(r) for r in rows]


def get_item(pid, kind, item_id):
    with connect() as db:
        r = db.execute("SELECT * FROM items WHERE id=? AND profile_id=? AND kind=?", (item_id, pid, kind)).fetchone()
    return _row(r) if r else None


def _remember_country(db, pid, pais):
    """El orden de banderas es el orden cronológico en que se sumó cada país: los nuevos van a la derecha."""
    pais = (pais or "").strip()
    if not pais:
        return
    row = db.execute("SELECT paises_orden FROM profiles WHERE id=?", (pid,)).fetchone()
    orden = json.loads(row["paises_orden"])
    if pais.lower() not in [p.lower() for p in orden]:
        orden.append(pais)
        db.execute("UPDATE profiles SET paises_orden=? WHERE id=?", (json.dumps(orden, ensure_ascii=False), pid))


def add_item(pid, kind, data):
    item = {"fotos": [], **clean(kind, data)}
    iid = new_id(kind)
    item.pop("id", None)
    with connect() as db:
        db.execute("INSERT INTO items(id, profile_id, kind, data, created) VALUES(?,?,?,?,?)",
                   (iid, pid, kind, json.dumps(item, ensure_ascii=False), now_iso()))
        if kind == "lugares":
            _remember_country(db, pid, item.get("pais"))
    item["id"] = iid
    return item


def update_item(pid, kind, item_id, data):
    with connect() as db:
        r = db.execute("SELECT * FROM items WHERE id=? AND profile_id=? AND kind=?", (item_id, pid, kind)).fetchone()
        if not r:
            return None
        cur = json.loads(r["data"])
        cur.update({k: v for k, v in clean(kind, data).items() if k != "id"})
        db.execute("UPDATE items SET data=? WHERE id=?", (json.dumps(cur, ensure_ascii=False), item_id))
        if kind == "lugares":
            _remember_country(db, pid, cur.get("pais"))
    cur["id"] = item_id
    return cur


def delete_item(pid, kind, item_id):
    with connect() as db:
        return db.execute("DELETE FROM items WHERE id=? AND profile_id=? AND kind=?", (item_id, pid, kind)).rowcount > 0


# ---- fotos ----
def save_photo(content: bytes, mime: str, user_id: str, profile_id=None) -> str:
    pid = new_uid("p")
    (PHOTOS / pid).write_bytes(content)
    with connect() as db:
        db.execute("INSERT INTO photos VALUES(?,?,?,?)", (pid, profile_id, user_id, mime or "image/jpeg"))
    return pid


def photo_meta(photo_id):
    with connect() as db:
        r = db.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
    return dict(r) if r else None


def read_photo(photo_id):
    f = PHOTOS / Path(photo_id).name
    return f.read_bytes() if f.is_file() else None


def delete_photo(photo_id):
    f = PHOTOS / Path(photo_id).name
    if f.exists():
        f.unlink()
    with connect() as db:
        db.execute("DELETE FROM photos WHERE id=?", (photo_id,))


def delete_profile_data(pid):
    with connect() as db:
        ids = [r["id"] for r in db.execute("SELECT id FROM photos WHERE profile_id=?", (pid,)).fetchall()]
        db.execute("DELETE FROM items WHERE profile_id=?", (pid,))
        db.execute("DELETE FROM members WHERE profile_id=?", (pid,))
        db.execute("DELETE FROM invites WHERE profile_id=?", (pid,))
        db.execute("DELETE FROM profiles WHERE id=?", (pid,))
    for i in ids:
        delete_photo(i)


# ---- datos iniciales (los 37 lugares y 3 eventos de la Sheet) ----
def seed_profile(pid):
    meta = json.loads((SEED / "meta.json").read_text()) if (SEED / "meta.json").exists() else {}
    with connect() as db:
        for kind in ("lugares", "eventos"):
            f = SEED / f"{kind}.json"
            if not f.exists():
                continue
            for it in json.loads(f.read_text()):
                it = {k: v for k, v in it.items() if k != "id"}
                db.execute("INSERT INTO items(id, profile_id, kind, data, created) VALUES(?,?,?,?,?)",
                           (new_id(kind), pid, kind, json.dumps(it, ensure_ascii=False), now_iso()))
        if meta.get("paises_orden"):
            db.execute("UPDATE profiles SET paises_orden=? WHERE id=?", (json.dumps(meta["paises_orden"], ensure_ascii=False), pid))
