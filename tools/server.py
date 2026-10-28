"""API de la Bitácora de viajes (usuarios, perfiles, lugares, eventos, fotos) + servidor de web/.

Local:        .venv/bin/uvicorn tools.server:app --reload
Variables:    APP_URL (base de los links de los mails; en local se deduce del pedido),
              SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/MAIL_FROM (sin SMTP los mails quedan en data_local/outbox/),
              COOKIE_SECURE=1 detrás de HTTPS, SEED_FIRST_USER=0 para no precargar los datos de ejemplo.
"""
import json
import os
import re
from pathlib import Path
from typing import List, Optional

from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent


def _load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                if v.strip():
                    os.environ.setdefault(k.strip(), v.strip())


_load_env()

from . import auth, db as dbm, places, store_sql as store  # noqa: E402  (después de cargar .env)
from .models import clean  # noqa: E402

dbm.init()
KINDS = {"lugares", "eventos"}
MAX_PHOTO = 12 * 1024 * 1024
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DUMMY_HASH = auth.hash_password("dummy-password-for-timing")
app = FastAPI(title="Bitácora de viajes", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    else:  # la web: el navegador revalida siempre (304 si no cambió), así nunca queda código viejo
        resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


# ---------- helpers ----------
def current_user(request: Request, sid: Optional[str] = Cookie(default=None)):
    user = auth.user_for_session(sid)
    if not user:
        raise HTTPException(401, "Iniciá sesión")
    return user


def base_url(request: Request) -> str:
    return (os.environ.get("APP_URL") or str(request.base_url)).rstrip("/")


def set_session(resp: Response, request: Request, user_id: str):
    secure = os.environ.get("COOKIE_SECURE") == "1" or request.url.scheme == "https"
    resp.set_cookie("sid", auth.create_session(user_id), max_age=auth.SESSION_DAYS * 86400,
                    httponly=True, samesite="lax", secure=secure, path="/")


def public_user(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"], "avatar": u["avatar"]}


def profiles_for(user_id):
    with dbm.connect() as db:
        rows = db.execute(
            "SELECT p.*, m.role FROM profiles p JOIN members m ON m.profile_id=p.id WHERE m.user_id=? ORDER BY p.created",
            (user_id,)).fetchall()
        out = []
        for r in rows:
            n = db.execute("SELECT COUNT(*) c FROM members WHERE profile_id=?", (r["id"],)).fetchone()["c"]
            out.append({"id": r["id"], "name": r["name"], "kind": r["kind"], "role": r["role"],
                        "paisesOrden": json.loads(r["paises_orden"]), "members": n})
    return out


def need_profile(user, pid, owner=False):
    with dbm.connect() as db:
        r = db.execute("SELECT p.*, m.role FROM profiles p JOIN members m ON m.profile_id=p.id AND m.user_id=? WHERE p.id=?",
                       (user["id"], pid)).fetchone()
    if not r:
        raise HTTPException(404, "Perfil no encontrado")
    if owner and r["role"] != "owner":
        raise HTTPException(403, "Solo quien creó el perfil puede hacer esto")
    return dict(r)


def create_profile(user_id, name, kind):
    pid = auth.new_uid("pf")
    with dbm.connect() as db:
        db.execute("INSERT INTO profiles(id,name,kind,owner_id,created) VALUES(?,?,?,?,?)", (pid, name, kind, user_id, auth.now_iso()))
        db.execute("INSERT INTO members VALUES(?,?,?)", (pid, user_id, "owner"))
    return pid


def valid_password(pw: str):
    if len(pw) < 8:
        raise HTTPException(422, "La contraseña debe tener al menos 8 caracteres")
    if len(pw) > 200:
        raise HTTPException(422, "Contraseña demasiado larga")


def valid_email(email: str) -> str:
    email = email.strip().lower()
    if not EMAIL_RE.match(email) or len(email) > 200:
        raise HTTPException(422, "El email no es válido")
    return email


# ---------- auth ----------
class SignupIn(BaseModel):
    email: str
    password: str
    name: str


class LoginIn(BaseModel):
    email: str
    password: str


class ForgotIn(BaseModel):
    email: str


class ResetIn(BaseModel):
    token: str
    password: str


@app.post("/api/auth/signup")
def signup(data: SignupIn, request: Request, response: Response):
    if auth.too_many("signup:" + (request.client.host if request.client else "?"), 10, 3600):
        raise HTTPException(429, "Demasiados intentos, probá más tarde")
    email, name = valid_email(data.email), data.name.strip()[:60]
    valid_password(data.password)
    if not name:
        raise HTTPException(422, "Falta tu nombre")
    uid = auth.new_uid("u")
    with dbm.connect() as db:
        first = db.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0
        if db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise HTTPException(409, "Ya existe una cuenta con ese email")
        db.execute("INSERT INTO users(id,email,name,pw_hash,created) VALUES(?,?,?,?,?)",
                   (uid, email, name, auth.hash_password(data.password), auth.now_iso()))
    create_profile(uid, "Individual", "personal")  # perfil propio, solo de la persona
    if first and os.environ.get("SEED_FIRST_USER", "1") != "0":
        # el primer usuario hereda los viajes de la Sheet, que son compartidos con su pareja
        store.seed_profile(create_profile(uid, "Ger y Tetu", "shared"))
    set_session(response, request, uid)
    return {"ok": True}


@app.post("/api/auth/login")
def login(data: LoginIn, request: Request, response: Response):
    email = data.email.strip().lower()
    if auth.too_many(f"login:{request.client.host if request.client else '?'}:{email}", 8, 900):
        raise HTTPException(429, "Demasiados intentos, esperá unos minutos")
    with dbm.connect() as db:
        u = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    ok = auth.verify_password(data.password, u["pw_hash"] if u else DUMMY_HASH)
    if not u or not ok:
        raise HTTPException(401, "Email o contraseña incorrectos")
    set_session(response, request, u["id"])
    return {"ok": True}


@app.post("/api/auth/logout")
def logout(response: Response, sid: Optional[str] = Cookie(default=None)):
    auth.drop_session(sid)
    response.delete_cookie("sid", path="/")
    return {"ok": True}


@app.post("/api/auth/forgot")
def forgot(data: ForgotIn, request: Request):
    """Siempre responde igual: no revela si el email tiene cuenta."""
    email = data.email.strip().lower()
    if not auth.too_many("forgot:" + email, 5, 3600):
        with dbm.connect() as db:
            u = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            if u:
                token = auth.new_token()
                db.execute("INSERT INTO resets VALUES(?,?,?,0)", (auth.token_hash(token), u["id"], __import__("time").time() + auth.RESET_MINUTES * 60))
                link = f"{base_url(request)}/?reset={token}"
                auth.send_mail(email, "Restablecer tu contraseña · Bitácora de viajes",
                               f"Hola {u['name']},\n\nPara elegir una contraseña nueva entrá a este link (vale {auth.RESET_MINUTES} minutos):\n{link}\n\n"
                               "Si no lo pediste vos, ignorá este mail: tu contraseña sigue igual.")
    return {"ok": True}


@app.post("/api/auth/reset")
def reset(data: ResetIn):
    import time
    valid_password(data.password)
    with dbm.connect() as db:
        r = db.execute("SELECT * FROM resets WHERE token_hash=? AND used=0 AND expires>?", (auth.token_hash(data.token), time.time())).fetchone()
        if not r:
            raise HTTPException(400, "El link venció o ya se usó. Pedí uno nuevo.")
        db.execute("UPDATE users SET pw_hash=? WHERE id=?", (auth.hash_password(data.password), r["user_id"]))
        db.execute("UPDATE resets SET used=1 WHERE token_hash=?", (r["token_hash"],))
    auth.drop_all_sessions(r["user_id"])  # cierra las sesiones abiertas por seguridad
    return {"ok": True}


# ---------- cuenta ----------
@app.get("/api/me")
def me(user=Depends(current_user)):
    return {"user": public_user(user), "profiles": profiles_for(user["id"])}


class MeIn(BaseModel):
    name: str


@app.patch("/api/me")
def update_me(data: MeIn, user=Depends(current_user)):
    name = data.name.strip()[:60]
    if not name:
        raise HTTPException(422, "Falta tu nombre")
    with dbm.connect() as db:
        db.execute("UPDATE users SET name=? WHERE id=?", (name, user["id"]))
    return {"ok": True}


class PasswordIn(BaseModel):
    current: str
    new: str


@app.post("/api/me/password")
def change_password(data: PasswordIn, user=Depends(current_user)):
    valid_password(data.new)
    if not auth.verify_password(data.current, user["pw_hash"]):
        raise HTTPException(403, "La contraseña actual no es correcta")
    with dbm.connect() as db:
        db.execute("UPDATE users SET pw_hash=? WHERE id=?", (auth.hash_password(data.new), user["id"]))
    return {"ok": True}


async def read_image(f: UploadFile) -> bytes:
    data = await f.read()
    if len(data) > MAX_PHOTO:
        raise HTTPException(413, f"{f.filename}: pesa más de 12 MB")
    if not (f.content_type or "").startswith("image/"):
        raise HTTPException(415, f"{f.filename}: no es una imagen")
    return data


@app.post("/api/me/avatar")
async def set_avatar(file: UploadFile = File(...), user=Depends(current_user)):
    data = await read_image(file)
    pid = store.save_photo(data, file.content_type, user["id"], None)
    with dbm.connect() as db:
        db.execute("UPDATE users SET avatar=? WHERE id=?", (pid, user["id"]))
    if user["avatar"]:
        store.delete_photo(user["avatar"])
    return {"avatar": pid}


# ---------- perfiles ----------
class ProfileIn(BaseModel):
    name: str


@app.post("/api/profiles")
def new_profile(data: ProfileIn, user=Depends(current_user)):
    name = data.name.strip()[:60]
    if not name:
        raise HTTPException(422, "Falta el nombre del perfil")
    pid = create_profile(user["id"], name, "shared")
    return {"id": pid}


@app.patch("/api/profiles/{pid}")
def rename_profile(pid: str, data: ProfileIn, user=Depends(current_user)):
    need_profile(user, pid, owner=True)
    with dbm.connect() as db:
        db.execute("UPDATE profiles SET name=? WHERE id=?", (data.name.strip()[:60], pid))
    return {"ok": True}


@app.delete("/api/profiles/{pid}")
def remove_profile(pid: str, user=Depends(current_user)):
    p = need_profile(user, pid, owner=True)
    if p["kind"] == "personal":
        raise HTTPException(400, "El perfil personal no se puede borrar")
    store.delete_profile_data(pid)
    return {"ok": True}


@app.get("/api/profiles/{pid}/members")
def members(pid: str, user=Depends(current_user)):
    need_profile(user, pid)
    with dbm.connect() as db:
        ms = [dict(r) for r in db.execute(
            "SELECT u.id, u.name, u.email, u.avatar, m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.profile_id=? ORDER BY m.role DESC, u.name", (pid,)).fetchall()]
        inv = [dict(r) for r in db.execute("SELECT id, email FROM invites WHERE profile_id=? AND accepted=0", (pid,)).fetchall()]
    return {"members": ms, "invites": inv}


class InviteIn(BaseModel):
    email: str


@app.post("/api/profiles/{pid}/invites")
def invite(pid: str, data: InviteIn, request: Request, user=Depends(current_user)):
    p = need_profile(user, pid, owner=True)
    if p["kind"] != "shared":
        raise HTTPException(400, "Solo los perfiles compartidos admiten invitados")
    email = valid_email(data.email)
    if auth.too_many("invite:" + user["id"], 20, 3600):
        raise HTTPException(429, "Demasiadas invitaciones, probá más tarde")
    token = auth.new_token()
    with dbm.connect() as db:
        db.execute("DELETE FROM invites WHERE profile_id=? AND email=? AND accepted=0", (pid, email))
        db.execute("INSERT INTO invites VALUES(?,?,?,?,?,?,0)", (auth.new_uid("inv"), pid, email, auth.token_hash(token), user["id"], auth.now_iso()))
    link = f"{base_url(request)}/?invite={token}"
    auth.send_mail(email, f"{user['name']} te invitó a “{p['name']}” · Bitácora de viajes",
                   f"Hola,\n\n{user['name']} te invitó a sumar y ver viajes en el perfil compartido “{p['name']}”.\n\n"
                   f"Entrá con este link (creá tu cuenta con este mismo email si todavía no tenés una):\n{link}\n")
    return {"ok": True}


class AcceptIn(BaseModel):
    token: str


@app.post("/api/invites/accept")
def accept_invite(data: AcceptIn, user=Depends(current_user)):
    with dbm.connect() as db:
        inv = db.execute("SELECT * FROM invites WHERE token_hash=? AND accepted=0", (auth.token_hash(data.token),)).fetchone()
        if not inv:
            raise HTTPException(400, "La invitación no es válida o ya se usó")
        if inv["email"] != user["email"]:
            raise HTTPException(403, f"Esta invitación es para {inv['email']}. Iniciá sesión con ese email.")
        db.execute("INSERT OR IGNORE INTO members VALUES(?,?,?)", (inv["profile_id"], user["id"], "editor"))
        db.execute("UPDATE invites SET accepted=1 WHERE id=?", (inv["id"],))
    return {"profileId": inv["profile_id"]}


@app.delete("/api/profiles/{pid}/members/{uid}")
def remove_member(pid: str, uid: str, user=Depends(current_user)):
    p = need_profile(user, pid)
    if uid != user["id"] and p["role"] != "owner":
        raise HTTPException(403, "Solo quien creó el perfil puede quitar a otros")
    if uid == p["owner_id"]:
        raise HTTPException(400, "Quien creó el perfil no puede salirse: borralo en su lugar")
    with dbm.connect() as db:
        db.execute("DELETE FROM members WHERE profile_id=? AND user_id=?", (pid, uid))
    return {"ok": True}


@app.delete("/api/invites/{inv_id}")
def cancel_invite(inv_id: str, user=Depends(current_user)):
    with dbm.connect() as db:
        inv = db.execute("SELECT profile_id FROM invites WHERE id=?", (inv_id,)).fetchone()
        if not inv:
            raise HTTPException(404, "No encontrada")
        need_profile(user, inv["profile_id"], owner=True)
        db.execute("DELETE FROM invites WHERE id=?", (inv_id,))
    return {"ok": True}


# ---------- lugares y eventos (por perfil) ----------
# ---------- buscador de lugares (Google Places) ----------
TOKEN_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
PLACE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{5,300}$")


def _places(user, fn, *a):
    if auth.too_many("places:" + user["id"], 120, 60) or auth.too_many("placesday:" + user["id"], 2000, 86400):
        raise HTTPException(429, "Demasiadas búsquedas. Probá en un minuto.")
    try:
        return fn(*a)
    except places.PlacesError as e:
        raise HTTPException(e.status, e.msg)


@app.get("/api/places/autocomplete")
def places_autocomplete(q: str, session: str, tipo: str = "", region: str = "", user=Depends(current_user)):
    q = q.strip()[:120]
    if len(q) < 2 or not TOKEN_RE.match(session):
        return []
    return _places(user, places.autocomplete, q, session, tipo[:20], region[:2] if re.fullmatch(r"[A-Za-z]{2}", region[:2] or "") else "")


@app.get("/api/places/details")
def places_details(id: str, session: str, user=Depends(current_user)):
    if not PLACE_ID_RE.match(id) or not TOKEN_RE.match(session):
        raise HTTPException(422, "Pedido inválido")
    return _places(user, places.details, id, session)


@app.get("/api/places/resolve")
def places_resolve(q: str, tipo: str = "", region: str = "", user=Depends(current_user)):
    q = q.strip()[:160]
    if len(q) < 2:
        raise HTTPException(422, "Pedido inválido")
    return _places(user, places.resolve, q, tipo[:20], region[:2] if re.fullmatch(r"[A-Za-z]{2}", region[:2] or "") else "") or {}


def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(404, "No existe")
    return kind


@app.get("/api/p/{pid}/{kind}")
def list_items(pid: str, kind: str, user=Depends(current_user)):
    need_profile(user, pid)
    return store.list_items(pid, _kind(kind))


@app.post("/api/p/{pid}/{kind}")
def add_item(pid: str, kind: str, data: dict, user=Depends(current_user)):
    need_profile(user, pid)
    d = clean(_kind(kind), data)
    if not (d.get("nombre") or d.get("titulo")):
        raise HTTPException(422, "Falta el nombre")
    return store.add_item(pid, kind, d)


@app.patch("/api/p/{pid}/{kind}/{item_id}")
def update_item(pid: str, kind: str, item_id: str, data: dict, user=Depends(current_user)):
    need_profile(user, pid)
    item = store.update_item(pid, _kind(kind), item_id, data)
    if not item:
        raise HTTPException(404, "No encontrado")
    return item


@app.delete("/api/p/{pid}/{kind}/{item_id}")
def delete_item(pid: str, kind: str, item_id: str, user=Depends(current_user)):
    need_profile(user, pid)
    item = store.get_item(pid, _kind(kind), item_id)
    if not item:
        raise HTTPException(404, "No encontrado")
    for ph in item.get("fotos", []):
        store.delete_photo(ph)
    store.delete_item(pid, kind, item_id)
    return {"ok": True}


@app.post("/api/p/{pid}/{kind}/{item_id}/fotos")
async def upload_photos(pid: str, kind: str, item_id: str, files: List[UploadFile] = File(...), user=Depends(current_user)):
    need_profile(user, pid)
    item = store.get_item(pid, _kind(kind), item_id)
    if not item:
        raise HTTPException(404, "No encontrado")
    ids = [store.save_photo(await read_image(f), f.content_type, user["id"], pid) for f in files]
    return store.update_item(pid, kind, item_id, {"fotos": item.get("fotos", []) + ids})


@app.delete("/api/p/{pid}/{kind}/{item_id}/fotos/{photo_id}")
def delete_photo(pid: str, kind: str, item_id: str, photo_id: str, user=Depends(current_user)):
    need_profile(user, pid)
    item = store.get_item(pid, _kind(kind), item_id)
    if not item or photo_id not in item.get("fotos", []):
        raise HTTPException(404, "No encontrado")
    store.delete_photo(photo_id)
    return store.update_item(pid, kind, item_id, {"fotos": [p for p in item["fotos"] if p != photo_id]})


@app.get("/api/photo/{photo_id}")
def get_photo(photo_id: str, user=Depends(current_user)):
    meta = store.photo_meta(photo_id)
    if not meta:
        raise HTTPException(404, "No encontrada")
    if meta["profile_id"]:  # foto de un lugar: solo para miembros del perfil
        need_profile(user, meta["profile_id"])
    data = store.read_photo(photo_id)
    if data is None:
        raise HTTPException(404, "No encontrada")
    return Response(data, media_type=meta["mime"], headers={"Cache-Control": "private, max-age=31536000, immutable"})


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
