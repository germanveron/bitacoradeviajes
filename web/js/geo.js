// Capa geográfica: países, regiones, continentes y estadísticas "tipo Been".
import { norm } from "./util.js?v=19";
const d3 = window.d3, topojson = window.topojson;

export const geo = { world: [], worldLite: [], regions: [], byA2: {}, nameToA2: {}, idToA2: {}, a2ToId: {}, countryName: {}, ready: false };

export async function loadGeo() {
  const [w, r, c, wl] = await Promise.all(["data/world.json", "data/regions.json", "data/countries.json", "data/world-globe.json"].map(u => fetch(u).then(x => x.json())));
  geo.world = topojson.feature(w, w.objects.countries).features;
  geo.worldLite = topojson.feature(wl, wl.objects.countries).features; // versión liviana para que el globo gire fluido
  geo.regions = topojson.feature(r, r.objects.regions).features;
  for (const [num, v] of Object.entries(c)) {
    geo.idToA2[num] = v.a2; geo.a2ToId[v.a2] = num; geo.countryName[v.a2] = v.es;
    geo.nameToA2[norm(v.es)] = v.a2; geo.nameToA2[norm(v.en)] = v.a2;
  }
  Object.assign(geo.nameToA2, { espana: "ES", eeuu: "US", "estados unidos": "US", usa: "US", "reino unido": "GB", inglaterra: "GB", escocia: "GB", holanda: "NL", "paises bajos": "NL", chequia: "CZ", "republica checa": "CZ", suiza: "CH", deutschland: "DE" });
  for (const f of geo.regions) (geo.byA2[f.properties.iso_a2] = geo.byA2[f.properties.iso_a2] || []).push(f);
  for (const f of geo.regions) { const p = f.properties; p._key = p.iso_3166_2 || p.name; p._name = p.name_es || p.name; }
  geo.ready = true;
}

// País (A2) que contiene un punto; sirve para ríos, lagos y montañas, que Google no devuelve con país.
export const countryAt = (lat, lng) => { const f = geo.world.find(c => d3.geoContains(c, [lng, lat])); return f ? geo.idToA2[f.id] || null : null; };
export const countryFeature = a2 => geo.world.find(f => geo.idToA2[f.id] === a2);

// Isla principal de un país (evita que Francia/EEUU centren la vista en ultramar).
export function mainland(f) {
  const g = f.geometry;
  if (!g || g.type !== "MultiPolygon") return f;
  const polys = g.coordinates.map(c => ({ type: "Feature", geometry: { type: "Polygon", coordinates: c } }));
  polys.forEach(p => { p.a = d3.geoArea(p); p.c = d3.geoCentroid(p); });
  const big = polys.reduce((a, b) => (b.a > a.a ? b : a));
  const keep = polys.filter(p => p === big || (p.a > big.a * 0.002 && d3.geoDistance(p.c, big.c) < 0.35));
  return { type: "Feature", properties: f.properties, geometry: { type: "MultiPolygon", coordinates: keep.map(p => p.geometry.coordinates) } };
}

function regionOf(p, a2) {
  const list = geo.byA2[a2] || [];
  if (p._hasXY) { const hit = list.find(f => d3.geoContains(f, [+p.lng, +p.lat])); if (hit) return hit; }
  if (p.region) {
    const n = norm(p.region);
    const hit = list.find(f => ["name", "name_es", "name_de", "name_en", "name_local"].some(k => f.properties[k] && norm(f.properties[k]) === n));
    if (hit) return hit;
  }
  return null;
}

// Territorios que son enclaves de otra región: un lugar en la Ciudad de Buenos Aires cuenta como Buenos Aires.
export const REGION_ALIAS = { "AR-C": "AR-B" };
const regionKey = r => REGION_ALIAS[r.properties._key] || r.properties._key;

// Calcula campos derivados (_a2, _rkey, _rname, _hasXY) sobre cada lugar.
export function enrich(places) {
  for (const p of places) {
    p._hasXY = typeof p.lat === "number" && typeof p.lng === "number" && isFinite(p.lat) && isFinite(p.lng);
    p._a2 = geo.nameToA2[norm(p.pais)] || null;
    const r = p._a2 ? regionOf(p, p._a2) : null;
    p._rkey = r ? regionKey(r) : p.region ? "txt:" + norm(p.region) : null;
    p._rname = r ? r.properties._name : p.region || null;
  }
}

// Estados soberanos por continente (195 = 193 de la ONU + Vaticano + Palestina), como Been.
const CONT = {
  Europa: "AL AD AT BY BE BA BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SE CH UA GB VA",
  Asia: "AF AM AZ BH BD BT BN KH CN GE IN ID IR IQ IL JP JO KZ KW KG LA LB MY MV MN MM NP KP OM PK PH QA SA SG KR LK SY TJ TH TL TR TM AE UZ VN YE PS",
  África: "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST SN SC SL SO ZA SS SD TZ TG TN UG ZM ZW",
  "América del Norte": "AG BS BB BZ CA CR CU DM DO SV GD GT HT HN JM MX NI PA KN LC VC TT US",
  "América del Sur": "AR BO BR CL CO EC GY PY PE SR UY VE",
  Oceanía: "AU FJ KI MH FM NR NZ PW PG WS SB TO TV VU",
};
export const CONTINENTS = Object.fromEntries(Object.entries(CONT).map(([k, v]) => [k, v.split(" ")]));
export const TOTAL_COUNTRIES = Object.values(CONTINENTS).reduce((a, l) => a + l.length, 0);
export const continentOf = a2 => Object.keys(CONTINENTS).find(k => CONTINENTS[k].includes(a2)) || null;

export function computeStats(places, eventos) {
  const visited = [...new Set(places.map(p => p._a2).filter(Boolean))];
  const sovereign = visited.filter(a => continentOf(a));
  const byCont = Object.fromEntries(Object.keys(CONTINENTS).map(k => [k, { total: CONTINENTS[k].length, seen: sovereign.filter(a => CONTINENTS[k].includes(a)).length }]));
  const regions = new Set(places.filter(p => p._rkey).map(p => p._a2 + "|" + p._rkey)).size;
  const photos = [...places, ...eventos].reduce((n, p) => n + (p.fotos || []).length, 0);
  const years = {};
  for (const p of places) {
    const y = /^(\d{4})/.exec(p.fecha || "")?.[1];
    if (y && p._a2) (years[y] = years[y] || new Set()).add(p._a2);
  }
  return { visited, sovereign, pct: sovereign.length / TOTAL_COUNTRIES, byCont, regions, photos, years: Object.fromEntries(Object.entries(years).map(([y, s]) => [y, s.size])), continents: Object.values(byCont).filter(c => c.seen).length };
}
