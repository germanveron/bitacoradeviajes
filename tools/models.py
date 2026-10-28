"""Esquema compartido entre el almacén local y el de Google Sheets."""
import uuid

# (clave JSON, encabezado en la Sheet)
PLACE_FIELDS = [
    ("pais", "País"), ("tipo", "Tipo"), ("nombre", "Lugar"), ("region", "Región"),
    ("lat", "Latitud"), ("lng", "Longitud"), ("fecha", "Fecha"), ("conQuien", "Con quién"),
    ("notas", "Notas"), ("fotos", "Fotos"), ("id", "ID"),
]
EVENT_FIELDS = [
    ("titulo", "Título"), ("emoji", "Emoji"), ("fecha", "Fecha"), ("lugar", "Dónde"),
    ("pais", "País"), ("notas", "Notas"), ("fotos", "Fotos"), ("id", "ID"),
]
FIELDS = {"lugares": PLACE_FIELDS, "eventos": EVENT_FIELDS}
PREFIX = {"lugares": "l", "eventos": "e"}


def new_id(kind: str) -> str:
    return f"{PREFIX[kind]}-{uuid.uuid4().hex[:8]}"


def to_number(v):
    """La Sheet está en configuración regional es: tolera '49,98' y vacíos."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).strip().replace(",", "."))
    except ValueError:
        return None


def clean(kind: str, raw: dict) -> dict:
    """Deja solo las claves conocidas y normaliza tipos."""
    out = {}
    for key, _ in FIELDS[kind]:
        if key not in raw:
            continue
        v = raw[key]
        if key in ("lat", "lng"):
            v = to_number(v)
        elif key == "fotos":
            v = [str(x) for x in v] if isinstance(v, list) else [x for x in str(v or "").split(",") if x]
        else:
            v = "" if v is None else str(v).strip()
        out[key] = v
    return out


def row_to_item(kind: str, row: list) -> dict:
    item = {}
    for i, (key, _) in enumerate(FIELDS[kind]):
        item[key] = row[i] if i < len(row) else ""
    return clean(kind, item)


def item_to_row(kind: str, item: dict) -> list:
    row = []
    for key, _ in FIELDS[kind]:
        v = item.get(key, "")
        if key == "fotos":
            v = ",".join(v or [])
        elif v is None:
            v = ""
        row.append(v)
    return row
