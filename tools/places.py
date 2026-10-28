"""Búsqueda de lugares con Google Places API (New): autocompletar, detalle y resolución por texto.

La clave (GOOGLE_MAPS_API_KEY en .env) vive solo en el servidor; el navegador pregunta a /api/places/*.
"""
import json
import os
import urllib.error
import urllib.request

BASE = "https://places.googleapis.com/v1"
# Para el tipo "Ciudad": ciudades y también provincias/estados (Entre Ríos, Baviera); para lagos, ríos y montañas no se filtra.
CITY_TYPES = ["locality", "administrative_area_level_3", "administrative_area_level_1"]


# Para lagos, ríos y montañas se priorizan los accidentes geográficos: sin esto "Königsee" trae primero
# el pueblo de Turingia y no el lago de Baviera. No se descarta nada (hay lagos que Google marca como localidad).
NATURAL = {"Lago": "lake", "Río": "river", "Montaña": "mountain_peak"}


def _is_natural(types) -> bool:
    return "natural_feature" in (types or [])


def _rank(tipo, types) -> int:
    if tipo not in NATURAL:
        return 0
    return 0 if NATURAL[tipo] in types else 1 if _is_natural(types) else 2


class PlacesError(Exception):
    def __init__(self, status: int, msg: str):
        super().__init__(msg)
        self.status, self.msg = status, msg


def _call(method: str, path: str, body=None, mask: str = ""):
    key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    if not key:
        raise PlacesError(503, "La búsqueda de lugares no está configurada.")
    headers = {"X-Goog-Api-Key": key, "content-type": "application/json"}
    if mask:
        headers["X-Goog-FieldMask"] = mask
    req = urllib.request.Request(BASE + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        print("places:", e.code, e.read().decode("utf-8", "replace")[:300])  # sin imprimir la clave
        raise PlacesError(502, "No pude consultar el buscador de lugares.")
    except (urllib.error.URLError, TimeoutError):
        raise PlacesError(502, "No pude conectar con el buscador de lugares.")


def autocomplete(q: str, session: str, tipo: str = "", region: str = ""):
    body = {"input": q, "languageCode": "es", "sessionToken": session}
    if tipo == "Ciudad":
        body["includedPrimaryTypes"] = CITY_TYPES
    if region:
        body["includedRegionCodes"] = [region.lower()]
    out = []
    for s in _call("POST", "/places:autocomplete", body).get("suggestions", []):
        p = s.get("placePrediction")
        if not p:
            continue
        types = p.get("types", [])
        f = p.get("structuredFormat", {})
        out.append({"id": p["placeId"], "main": f.get("mainText", {}).get("text") or p["text"]["text"], "sub": f.get("secondaryText", {}).get("text", ""),
                    "_rank": _rank(tipo, types)})
    out.sort(key=lambda x: x["_rank"])  # estable: respeta el orden de Google dentro de cada grupo
    for x in out:
        del x["_rank"]
    return out


def _shape(place: dict) -> dict:
    loc = place.get("location") or {}
    comps = place.get("addressComponents") or []
    country = next((c for c in comps if "country" in c.get("types", [])), {})
    return {
        "nombre": (place.get("displayName") or {}).get("text", ""),
        "lat": loc.get("latitude"), "lng": loc.get("longitude"),
        "a2": (country.get("shortText") or "").upper(), "pais": country.get("longText", ""),
    }


def details(place_id: str, session: str) -> dict:
    mask = "displayName,location,addressComponents"
    return _shape(_call("GET", f"/places/{place_id}?languageCode=es&sessionToken={session}", mask=mask))


def resolve(q: str, tipo: str = "", region: str = ""):
    """Mejor resultado de una búsqueda por texto (para cuando el usuario no eligió una sugerencia)."""
    body = {"textQuery": q, "languageCode": "es", "pageSize": 10}
    if tipo == "Ciudad":
        body["includedType"] = "locality"
    if region:
        body["regionCode"] = region.lower()
    found = _call("POST", "/places:searchText", body, "places.displayName,places.location,places.addressComponents,places.types").get("places", [])
    found.sort(key=lambda x: _rank(tipo, x.get("types", [])))
    return _shape(found[0]) if found else None
