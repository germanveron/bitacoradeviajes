"""Contraseñas, sesiones por cookie, límite de intentos y envío de mails."""
import hashlib
import hmac
import os
import secrets
import smtplib
import time
from collections import defaultdict, deque
from datetime import datetime
from email.message import EmailMessage
from typing import Optional

from .db import DATA, connect

ITERATIONS = 600_000
SESSION_DAYS = 30
RESET_MINUTES = 60


def now_iso() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def hash_password(pw: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITERATIONS)
    return f"pbkdf2${ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), dk)
    except Exception:
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def new_uid(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(6)}"


# ---- sesiones ----
def create_session(user_id: str) -> str:
    token = new_token()
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
        db.execute("INSERT INTO sessions VALUES(?,?,?)", (token_hash(token), user_id, time.time() + SESSION_DAYS * 86400))
    return token


def user_for_session(token: Optional[str]):
    if not token:
        return None
    with connect() as db:
        row = db.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=? AND s.expires>?",
            (token_hash(token), time.time())).fetchone()
        return dict(row) if row else None


def drop_session(token: Optional[str]):
    if token:
        with connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(token),))


def drop_all_sessions(user_id: str):
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


# ---- límite de intentos (en memoria; suficiente para una sola instancia) ----
_hits = defaultdict(deque)


def too_many(key: str, limit: int, window: int) -> bool:
    q, t = _hits[key], time.time()
    while q and q[0] < t - window:
        q.popleft()
    if len(q) >= limit:
        return True
    q.append(t)
    return False


# ---- mail ----
def send_mail(to: str, subject: str, body: str):
    """SMTP si hay SMTP_HOST; si no, deja el mail en data_local/outbox/ y lo imprime (modo desarrollo)."""
    host = os.environ.get("SMTP_HOST")
    if not host:
        out = DATA / "outbox"
        out.mkdir(parents=True, exist_ok=True)
        fname = out / f"{int(time.time())}-{to.replace('@', '_at_')}.txt"
        fname.write_text(f"Para: {to}\nAsunto: {subject}\n\n{body}\n")
        print(f"[mail dev] {subject} -> {to}\n{body}\n(guardado en {fname})", flush=True)
        return
    msg = EmailMessage()
    msg["From"] = os.environ.get("MAIL_FROM", os.environ.get("SMTP_USER", "bitacora@localhost"))
    msg["To"], msg["Subject"] = to, subject
    msg.set_content(body)
    port = int(os.environ.get("SMTP_PORT", "587"))
    if port == 465:
        s = smtplib.SMTP_SSL(host, port, timeout=15)
    else:
        s = smtplib.SMTP(host, port, timeout=15)
        s.starttls()
    try:
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
    finally:
        s.quit()
