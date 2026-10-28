"""Geocodifica los lugares de la Sheet con Google Geocoding API.

Entrada:  .tmp/detalle.json  (lista de filas [País, Tipo, Lugar, Región])
Salida:   .tmp/geocoded.json (lat/lng + dirección devuelta, para revisar a mano)

Uso: python3 tools/geocode_places.py
Requiere GOOGLE_MAPS_API_KEY en .env (nunca se imprime).
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://maps.googleapis.com/maps/api/geocode/json"

# Nombres que la API resuelve mal solos: se aclara la consulta.
QUERY_FIX = {
    ("Uruguay", "Colonia"): "Colonia del Sacramento",
    ("Alemania", "Badestelle Walldorfer See"): "Walldorfer See, Mörfelden-Walldorf",
    ("Alemania", "Kuh See"): "Kuhsee, Augsburg",
    ("Alemania", "Eib See"): "Eibsee, Grainau",
    ("Alemania", "Lauter See"): "Lautersee, Mittenwald",
    ("Alemania", "Ferchen See"): "Ferchensee, Mittenwald",
    ("Alemania", "Alp See"): "Alpsee, Schwangau",
    ("Alemania", "Starnberg See"): "Starnberger See",
    ("Alemania", "Chiem See"): "Chiemsee",
    ("Alemania", "München"): "München",
}


def load_key() -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("GOOGLE_MAPS_API_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("Falta GOOGLE_MAPS_API_KEY en .env")


def geocode(key: str, query: str, country: str) -> dict:
    params = {"address": query, "key": key, "language": "es"}
    region = {"Alemania": "de", "Uruguay": "uy", "Argentina": "ar"}.get(country)
    if region:
        params["components"] = f"country:{region.upper()}"
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r)


def main() -> None:
    key = load_key()
    rows = json.loads((ROOT / ".tmp" / "detalle.json").read_text())
    out = []
    for pais, tipo, lugar, region in rows:
        query = QUERY_FIX.get((pais, lugar)) or f"{lugar}, {region}"
        data = geocode(key, query, pais)
        status = data.get("status")
        if status == "OK":
            res = data["results"][0]
            loc = res["geometry"]["location"]
            out.append({"pais": pais, "tipo": tipo, "lugar": lugar, "region": region,
                        "lat": round(loc["lat"], 5), "lng": round(loc["lng"], 5),
                        "encontrado": res["formatted_address"], "status": status})
        else:
            out.append({"pais": pais, "tipo": tipo, "lugar": lugar, "region": region,
                        "lat": None, "lng": None, "encontrado": data.get("error_message", ""),
                        "status": status})
    (ROOT / ".tmp" / "geocoded.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for o in out:
        print(f'{o["status"]:<14} {o["lugar"]:<28} {o["lat"]}, {o["lng"]}  <- {o["encontrado"]}')


if __name__ == "__main__":
    main()
