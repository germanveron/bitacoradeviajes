// Viajes derivados de las fechas (estilo Polarsteps): lugares con pocos días de diferencia = un viaje.
// Los lugares sin fecha se agrupan por país para no perderlos.
import { geo } from "./geo.js?v=19";
import { MESES, isDate } from "./util.js?v=19";
const d3 = window.d3;

const GAP_DAYS = 4;
const day = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;

function describe(trip) {
  const pts = trip.steps.filter(s => s._hasXY);
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += d3.geoDistance([pts[i - 1].lng, pts[i - 1].lat], [pts[i].lng, pts[i].lat]) * 6371;
  trip.km = trip.undated ? 0 : Math.round(km); // sin fechas el orden no es real: no hay ruta
  trip.countries = [...new Set(trip.steps.map(s => s._a2).filter(Boolean))];
  trip.photos = trip.steps.reduce((n, s) => n + (s.fotos || []).length, 0);
  trip.cover = trip.steps.flatMap(s => s.fotos || [])[0] || null;
  if (trip.desde) trip.days = day(trip.hasta) - day(trip.desde) + 1;
  return trip;
}

export function deriveTrips(places) {
  const real = places.filter(p => (p.tipo || "").toLowerCase() !== "río");
  const dated = real.filter(p => isDate(p.fecha)).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const trips = [];
  let cur = null;
  for (const p of dated) {
    if (!cur || day(p.fecha) - day(cur.hasta) > GAP_DAYS) {
      cur = { id: "t-" + p.fecha, desde: p.fecha, hasta: p.fecha, steps: [], undated: false };
      trips.push(cur);
    }
    cur.hasta = p.fecha; cur.steps.push(p);
  }
  for (const t of trips) {
    describe(t);
    const regions = [...new Set(t.steps.map(s => s._rname).filter(Boolean))];
    const where = regions.length === 1 ? regions[0] : t.countries.length === 1 ? geo.countryName[t.countries[0]] : regions.slice(0, 2).join(" y ") || "Viaje";
    const m = +t.desde.slice(5, 7) - 1;
    t.titulo = `${where} · ${MESES[m].slice(0, 3)} ${t.desde.slice(0, 4)}`;
  }
  trips.sort((a, b) => b.desde.localeCompare(a.desde));
  const byCountry = d3.group(real.filter(p => !isDate(p.fecha)), p => p._a2 || p.pais || "—");
  for (const [a2, steps] of byCountry) {
    trips.push(describe({ id: "sf-" + a2, titulo: geo.countryName[a2] || a2, steps, undated: true }));
  }
  return trips;
}
