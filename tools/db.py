"""SQLite: usuarios, sesiones, perfiles (personales o compartidos), lugares/eventos y fotos."""
import contextlib
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR", ROOT / "data_local"))
DB_FILE = DATA / "bitacora.db"
PHOTOS = DATA / "photos"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, avatar TEXT, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS resets(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS profiles(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  paises_orden TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(
  profile_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(profile_id, user_id));
CREATE TABLE IF NOT EXISTS invites(
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL, created TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS items_profile ON items(profile_id, kind);
CREATE TABLE IF NOT EXISTS photos(
  id TEXT PRIMARY KEY, profile_id TEXT, user_id TEXT NOT NULL, mime TEXT NOT NULL);
"""


def init():
    DATA.mkdir(parents=True, exist_ok=True)
    PHOTOS.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(SCHEMA)


@contextlib.contextmanager
def connect():
    db = sqlite3.connect(DB_FILE, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
