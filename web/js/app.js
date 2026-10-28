// Bitácora de viajes: cuenta y perfiles, pestañas Inicio (globo + mapa), Viajes, Eventos, Stats y hojas de detalle/alta.
import { $, $$, norm, esc, fmtDate, toast, TIPOS, tcolor, isDate, plural, initial, pref } from "./util.js?v=19";
import { api, setProfile, photoUrl } from "./api.js?v=19";
import { geo, loadGeo, enrich, countryAt, computeStats, continentOf, TOTAL_COUNTRIES } from "./geo.js?v=19";
import { createGlobe, startMiniGlobe } from "./globe.js?v=19";
import { createFlatMap, drawTrip } from "./map.js?v=19";
import { deriveTrips } from "./trips.js?v=19";
import { uploadPhotos } from "./photos.js?v=19";
import { cropAvatar } from "./cropper.js?v=19";
import { showAuth } from "./auth.js?v=19";
const d3 = window.d3;

const LIMIT = 14; // lugares visibles antes de "Ver más"
const state = { tab: "inicio", level: "world", a2: null, region: null, tipo: null, tripId: null, sheet: null, expanded: false,
  vision: pref.get("vision", "detalle"), layout: pref.get("layout", "grid") };
let me = null, profiles = [], activeId = null, places = [], eventos = [], loaded = false, lastLevel = "world", geoReady = false;
const profile = () => profiles.find(p => p.id === activeId) || profiles[0];
const detailed = () => state.vision === "detalle";

/* ---------- datos ---------- */
async function loadMe() { const r = await api.me(); me = r.user; profiles = r.profiles; }
async function refresh(kind) {
  if (kind === "lugares") { const [items] = await Promise.all([api.list(kind), loadMe()]); places = items; enrich(places); }
  else eventos = await api.list(kind);
}
async function loadProfileData() { await Promise.all([refresh("lugares"), refresh("eventos")]); }
const placeById = id => places.find(p => p.id === id);
const eventById = id => eventos.find(e => e.id === id);

/* ---------- elementos persistentes: globo y mapa plano ---------- */
const heroWrap = document.createElement("div");
heroWrap.className = "hero";
heroWrap.innerHTML = `<div class="world-title">Mundo</div>
  <div class="globewrap"><div class="glow"></div><canvas id="globeGL" aria-hidden="true"></canvas><canvas id="globe" aria-label="Globo con los países visitados" role="img"></canvas><div class="grab" id="grab"></div></div>
  <div class="zoomctl"><button id="gzin" aria-label="Acercar">+</button><button id="gzout" aria-label="Alejar">−</button></div>
  <div class="hint" id="heroHint"></div>`;
const mapBox = document.createElement("div");
mapBox.className = "mapbox";
mapBox.innerHTML = `<svg id="map" viewBox="0 0 960 600" role="img" aria-label="Mapa de lugares visitados"></svg>
  <button class="backbtn" id="back"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span id="backLabel">Volver</span></button>
  <div class="zoomctl"><button id="zin" aria-label="Acercar">+</button><button id="zout" aria-label="Alejar">−</button><button id="zreset" class="zreset" aria-label="Volver al tamaño original" title="Volver al tamaño original"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button></div>
  <div class="hint" id="mapHint"></div><div class="maptip" id="tip" hidden></div>`;

const onCountry = a2 => { if (detailed()) go({ level: "country", a2, region: null }); else openSheet("country", a2); };
const globe = createGlobe($("#globe", heroWrap), { gl: $("#globeGL", heroWrap), grab: $("#grab", heroWrap), onCountry, onPlace: p => openSheet("place", p.id) });
const flat = createFlatMap($("#map", mapBox), $("#tip", mapBox), { onPlace: p => openSheet("place", p.id), onRegion: key => go({ level: "region", region: key }) });
$("#back", mapBox).onclick = () => go(state.level === "region" ? { level: "country", region: null } : { level: "world", a2: null, region: null });
$("#zin", mapBox).onclick = () => flat.zoomBy(1.6);
$("#zout", mapBox).onclick = () => flat.zoomBy(1 / 1.6);
$("#zreset", mapBox).onclick = () => flat.reset();
$("#gzin", heroWrap).onclick = () => globe.zoomBy(1.4);
$("#gzout", heroWrap).onclick = () => globe.zoomBy(1 / 1.4);

/* ---------- navegación ---------- */
const scroller = $("#scroller");
function go(patch, { top = true } = {}) {
  Object.assign(state, patch, { expanded: false });
  render();
  if (top) scroller.scrollTo({ top: 0 });
}
// Ir a una pestaña. Tocar "Inicio" estando en Inicio (por ejemplo dentro de un país) vuelve al mundo.
function goTab(tab) {
  if (tab === "inicio" && state.tab === "inicio") go({ level: "world", a2: null, region: null, tipo: null, tripId: null });
  else go({ tab, tripId: null });
}
const tabbar = $("#tabbar"), tabBtns = $$("button[data-tab]", tabbar);
tabbar.addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) goTab(b.dataset.tab); });

/* Barra con "glider": una píldora que acompaña a la pestaña activa y sigue al dedo al deslizar entre Inicio y Stats.
   Al soltar, se va a la pestaña que quedó resaltada. */
const glider = document.createElement("div");
glider.className = "glider";
tabbar.prepend(glider);
function placeGlider(btn, x = null, dragging = false) {
  const b = btn.getBoundingClientRect(), r = tabbar.getBoundingClientRect();
  glider.style.width = b.width - 8 + "px";
  glider.style.transition = dragging ? "none" : "";
  glider.style.transform = `translateX(${x === null ? b.left - r.left + 4 : x}px)${dragging ? " scale(1.1)" : ""}`;
  glider.classList.toggle("drag", dragging);
}
const syncGlider = () => { const a = tabBtns.find(b => b.dataset.tab === state.tab); if (a) placeGlider(a); };
new ResizeObserver(syncGlider).observe(tabbar);
document.fonts?.ready.then(syncGlider);

let tdrag = null;
tabbar.addEventListener("pointerdown", e => {
  const btn = e.target.closest("button[data-tab]");
  tdrag = btn ? { id: e.pointerId, sx: e.clientX, active: false, hot: btn } : null;
});
tabbar.addEventListener("pointermove", e => {
  if (!tdrag || e.pointerId !== tdrag.id) return;
  if (!tdrag.active) {
    if (Math.abs(e.clientX - tdrag.sx) < 8) return;
    tdrag.active = true;
    try { tabbar.setPointerCapture(e.pointerId); } catch { /* el puntero ya terminó */ }
  }
  const r = tabbar.getBoundingClientRect(), a = tabBtns[0].getBoundingClientRect(), z = tabBtns[tabBtns.length - 1].getBoundingClientRect();
  const w = a.width - 8;
  const x = Math.max(a.left - r.left + 4, Math.min(z.left - r.left + 4, e.clientX - r.left - w / 2));
  const cx = r.left + x + w / 2;
  const hot = tabBtns.reduce((best, b) => { const c = b.getBoundingClientRect(); return Math.abs(c.left + c.width / 2 - cx) < Math.abs(best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2 - cx) ? b : best; }, tabBtns[0]);
  tabBtns.forEach(b => b.toggleAttribute("data-hot", b === hot));
  tdrag.hot = hot;
  placeGlider(hot, x, true);
});
const endTabDrag = e => {
  if (!tdrag || e.pointerId !== tdrag.id) return;
  const d = tdrag; tdrag = null;
  tabBtns.forEach(b => b.removeAttribute("data-hot"));
  if (!d.active) return;                       // fue un toque: lo maneja el click normal
  if (e.type === "pointerup" && d.hot.dataset.tab !== state.tab) goTab(d.hot.dataset.tab);
  else syncGlider();
};
tabbar.addEventListener("pointerup", endTabDrag);
tabbar.addEventListener("pointercancel", endTabDrag);

// La página no se agranda con pellizco ni doble toque (en iOS el meta viewport no alcanza)
document.addEventListener("gesturestart", e => e.preventDefault());
document.addEventListener("gesturechange", e => e.preventDefault());
$("#plusBtn").onclick = () => openSheet("menu");
$("#avatarBtn").onclick = () => openSheet("accountMenu");

/* ---------- helpers de vista ---------- */
const slot = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content; };
const inScope = p => state.level === "world" || (p._a2 === state.a2 && (state.level !== "region" || p._rkey === state.region));
const flagImg = (a2, cls = "") => `<img class="${cls}" src="flags/${a2.toLowerCase()}.svg" alt="" onerror="this.style.display='none'">`;

function flagOrder() {
  const vis = new Set(places.map(p => p._a2).filter(Boolean));
  const ordered = (profile()?.paisesOrden || []).map(n => geo.nameToA2[norm(n)]).filter((a, i, arr) => a && vis.has(a) && arr.indexOf(a) === i);
  const rest = [...vis].filter(a => !ordered.includes(a)).sort((a, b) => (geo.countryName[a] || a).localeCompare(geo.countryName[b] || b, "es"));
  return [...ordered, ...rest]; // los países nuevos se suman a la derecha
}

const kindLabel = kind => (kind === "shared" ? "Compartido" : "Individual");
function renderHeader() {
  // En un perfil compartido todos ven la misma foto: la de quien lo creó. En el individual, la propia.
  const p = profile(), av = p?.kind === "shared" ? (p.ownerAvatar || me?.avatar) : me?.avatar;
  $("#avatarDot").innerHTML = av ? `<img src="${photoUrl(av)}" alt="">` : esc(initial(me?.name));
  $("#hello").textContent = me ? `¡Hola, ${me.name.trim().split(/\s+/)[0]}!` : "";
  $("#profType").textContent = profile() ? kindLabel(profile().kind) : "";
}

/* ---------- INICIO ---------- */
const GRID_ICON = `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>`;
const LIST_ICON = `<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;

function cardHTML(p) {
  const cover = (p.fotos || [])[0];
  return `<button class="card" data-open="${esc(p.id)}" style="--c:${tcolor(p.tipo)}">
    <div class="cover">${cover ? `<img src="${photoUrl(cover)}" alt="" loading="lazy">` : `<span class="glyph">${esc((p.nombre || "?").charAt(0))}</span>`}${(p.fotos || []).length ? `<span class="count">${p.fotos.length} ${p.fotos.length === 1 ? "foto" : "fotos"}</span>` : ""}</div>
    <div class="body"><h3>${esc(p.nombre)}</h3><div class="meta"><span class="dot"></span>${esc(p.tipo || "Lugar")}${p._rname ? " · " + esc(p._rname) : ""}</div>${p.fecha ? `<div class="meta mono">${fmtDate(p.fecha)}</div>` : ""}</div></button>`;
}
function rowHTML(p) {
  const cover = (p.fotos || [])[0];
  return `<button class="li" data-open="${esc(p.id)}" style="--c:${tcolor(p.tipo)}">
    <div class="thumb">${cover ? `<img src="${photoUrl(cover)}" alt="" loading="lazy">` : esc((p.nombre || "?").charAt(0))}</div>
    <div class="tx"><b>${esc(p.nombre)}</b><span class="sub">${esc(p.tipo || "Lugar")}${p._rname ? " · " + esc(p._rname) : ""}${p.fecha ? " · " + fmtDate(p.fecha) : ""}${(p.fotos || []).length ? ` · ${p.fotos.length} 📷` : ""}</span></div><span class="chev">›</span></button>`;
}
function countryCardHTML(a2) {
  const n = places.filter(p => p._a2 === a2).length, cont = continentOf(a2);
  return `<button class="card" data-country="${a2}" style="--c:var(--accent)"><div class="cover">${flagImg(a2, "flagbig")}</div>
    <div class="body"><h3>${esc(geo.countryName[a2] || a2)}</h3><div class="meta">${esc(cont || "")}${cont ? " · " : ""}${n} ${n === 1 ? "lugar" : "lugares"}</div></div></button>`;
}
function countryRowHTML(a2) {
  const n = places.filter(p => p._a2 === a2).length;
  return `<button class="li" data-country="${a2}"><div class="thumb">${flagImg(a2, "flagbig")}</div><div class="tx"><b>${esc(geo.countryName[a2] || a2)}</b><span class="sub">${esc(continentOf(a2) || "")} · ${n} ${n === 1 ? "lugar" : "lugares"}</span></div><span class="chev">›</span></button>`;
}

// Filtros + lista: se redibuja en el lugar, sin tocar el scroll ni el resto de la página.
function fillListZone() {
  const zone = $("#listZone"); if (!zone) return;
  const layoutBtns = `<div class="seg" role="group" aria-label="Formato de la lista"><button data-layout="grid" aria-pressed="${state.layout === "grid"}" aria-label="Tarjetas">${GRID_ICON}</button><button data-layout="list" aria-pressed="${state.layout === "list"}" aria-label="Lista">${LIST_ICON}</button></div>`;
  const wrap = (items, noun) => {
    const visible = state.expanded ? items : items.slice(0, LIMIT);
    const body = state.layout === "list" ? `<div class="list">${visible.join("")}</div>` : `<div class="grid">${visible.join("")}</div>`;
    if (items.length <= LIMIT) return body;
    const hidden = items.length - LIMIT;
    return body + `<div class="more"><button class="btn" data-more="${state.expanded ? 0 : 1}">${state.expanded ? "Ver menos" : `Ver más ${noun} (${hidden})`}</button></div>`;
  };
  if (!detailed()) {
    const flags = flagOrder();
    zone.innerHTML = `<div class="section-head"><h2>Países visitados</h2>${layoutBtns}</div>` +
      (flags.length ? wrap(flags.map(state.layout === "list" ? countryRowHTML : countryCardHTML), "países") : `<div class="empty">Todavía no hay países. Sumá el primer lugar con el botón ＋.</div>`);
    return;
  }
  const list = places.filter(inScope);
  const counts = d3.rollup(list, v => v.length, p => norm(p.tipo));
  const keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (state.tipo && !counts.has(state.tipo)) state.tipo = null;
  const shown = list.filter(p => !state.tipo || norm(p.tipo) === state.tipo).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
  const regionName = () => (geo.byA2[state.a2] || []).find(f => f.properties._key === state.region)?.properties._name || places.find(p => p._rkey === state.region)?._rname || "la región";
  const title = state.level === "world" ? "Todos los lugares" : `Lugares en ${state.level === "region" ? regionName() : geo.countryName[state.a2] || ""}`;
  const noXY = shown.filter(p => !p._hasXY).length;
  zone.innerHTML = `<div class="filters"><button class="chip" aria-pressed="${!state.tipo}" data-tipo="">Todos <span class="n">${list.length}</span></button>${keys.map(k => { const label = list.find(p => norm(p.tipo) === k)?.tipo || "Otro"; return `<button class="chip" aria-pressed="${state.tipo === k}" data-tipo="${esc(k)}" style="--c:${tcolor(label)}"><span class="dot"></span>${esc(plural(label))} <span class="n">${counts.get(k)}</span></button>`; }).join("")}</div>
    <div class="section-head"><div><h2>${esc(title)}</h2>${noXY ? `<span class="help">${noXY} sin coordenadas, no aparecen en el mapa</span>` : ""}</div>${layoutBtns}</div>` +
    (shown.length ? wrap(shown.map(state.layout === "list" ? rowHTML : cardHTML), "lugares") : `<div class="empty">Todavía no hay lugares acá. Sumá el primero con el botón ＋.</div>`);
}

function viewInicio(inner) {
  const s = computeStats(places, eventos), visited = s.visited, det = detailed();
  const countryName = geo.countryName[state.a2] || "";
  const regionName = state.level === "region" ? (geo.byA2[state.a2] || []).find(f => f.properties._key === state.region)?.properties._name || places.find(p => p._rkey === state.region)?._rname || "Región" : "";
  const crumbs = [`<button data-go="world">Mundo</button>`, `<span class="sep">›</span>` + (state.level === "country" ? `<span class="here">${esc(countryName)}</span>` : `<button data-go="country">${esc(countryName)}</button>`)];
  if (state.level === "region") crumbs.push(`<span class="sep">›</span><span class="here">${esc(regionName)}</span>`);
  const cities = places.filter(p => ["ciudad", "pueblo"].includes(norm(p.tipo))).length;
  const pct = (s.pct * 100).toFixed(1).replace(".", ",") + "%";
  const kpi = (n, l) => `<div class="kpi"><b>${n}</b><span>${l}</span></div>`;

  inner.append(slot(`<section class="v">
    <div class="toolbar"><div class="seg" role="group" aria-label="Visión del mapa"><button data-vision="detalle" aria-pressed="${det}">Detallada</button><button data-vision="paises" aria-pressed="${!det}">Solo países</button></div></div>
    ${state.level !== "world" ? `<div class="crumbs">${crumbs.join(" ")}</div><div id="slotMap"></div>` : ""}
    ${state.level === "world" ? `<div class="kpis">${det
      ? kpi(s.sovereign.length, s.sovereign.length === 1 ? "país" : "países") + kpi(cities, cities === 1 ? "ciudad" : "ciudades") + kpi(s.regions, s.regions === 1 ? "región" : "regiones") + kpi(s.continents, s.continents === 1 ? "continente" : "continentes") + kpi(pct, "del mundo") + kpi(s.photos, "fotos")
      : kpi(s.sovereign.length, s.sovereign.length === 1 ? "país" : "países") + kpi(s.continents, s.continents === 1 ? "continente" : "continentes") + kpi(pct, "del mundo") + kpi(s.photos, "fotos")}</div>
      <div class="flags">${flagOrder().map(a => `<button data-flag="${a}" title="${esc(geo.countryName[a] || a)}" aria-label="Ver ${esc(geo.countryName[a] || a)}">${flagImg(a)}</button>`).join("")}</div>` : ""}
    <div id="listZone" style="display:flex;flex-direction:column;gap:16px"></div>
  </section>`));
  fillListZone();

  if (state.level === "world") {
    globe.setData(places, visited, { pins: det });
    $("#heroHint", heroWrap).textContent = visited.length ? "Arrastrá para girar · tocá un país verde" : "Todavía no hay lugares cargados";
    if (lastLevel !== "world" || !viewInicio.shown) globe.focusVisited();
    viewInicio.shown = true;
    globe.start();
  } else {
    globe.stop();
    $("#slotMap", inner).replaceWith(mapBox);
    $("#backLabel", mapBox).textContent = state.level === "region" ? `Volver a ${countryName}` : "Volver al mundo";
    const touch = matchMedia("(pointer: coarse)").matches;
    $("#mapHint", mapBox).textContent = (state.level === "country" ? "Tocá una región pintada o un pin" : "Tocá un pin para ver el lugar") + (touch ? " · pellizcá para hacer zoom y arrastrá para mover" : " · arrastrá para mover, ctrl + rueda para zoom");
    flat.draw({ level: state.level, a2: state.a2, region: state.region, tipo: state.tipo, places });
  }
  lastLevel = state.level;

  inner.onclick = e => {
    const t = e.target.closest("[data-go],[data-flag],[data-tipo],[data-open],[data-vision],[data-layout],[data-country],[data-more]");
    if (!t) return;
    if (t.dataset.vision) { pref.set("vision", t.dataset.vision); go({ vision: t.dataset.vision, level: "world", a2: null, region: null, tipo: null }, { top: false }); }
    else if (t.dataset.layout) { pref.set("layout", t.dataset.layout); state.layout = t.dataset.layout; fillListZone(); }
    else if (t.dataset.tipo !== undefined) {
      state.tipo = t.dataset.tipo || null; state.expanded = false; fillListZone();
      if (state.level !== "world") flat.draw({ level: state.level, a2: state.a2, region: state.region, tipo: state.tipo, places });
    }
    else if (t.dataset.go) go(t.dataset.go === "world" ? { level: "world", a2: null, region: null } : { level: "country", region: null });
    else if (t.dataset.more !== undefined) {
      state.expanded = t.dataset.more === "1"; fillListZone();
      if (!state.expanded) $("#listZone").scrollIntoView({ block: "start" }); // al colapsar, volver al inicio de la lista
    }
    else if (t.dataset.flag || t.dataset.country) onCountry(t.dataset.flag || t.dataset.country); // sin girar el globo: va directo al país
    else if (t.dataset.open) openSheet("place", t.dataset.open);
  };
}

/* ---------- VIAJES ---------- */
function viewViajes(inner) {
  globe.stop();
  const trips = deriveTrips(places);
  const trip = trips.find(t => t.id === state.tripId);
  if (trip) return viewTrip(inner, trip);
  const range = t => (t.undated ? "Sin fecha" : t.desde === t.hasta ? fmtDate(t.desde) : `${fmtDate(t.desde)} – ${fmtDate(t.hasta)}`);
  inner.append(slot(`<section class="v">
    <div class="section-head"><h2>Viajes</h2></div><p class="help" style="margin:0">Se agrupan solos por fecha: lugares con menos de 4 días de diferencia son un mismo viaje.</p>
    ${trips.length ? `<div class="trips">${trips.map(t => `<button class="trip" data-trip="${esc(t.id)}">
      <div class="tcover">${t.cover ? `<img class="photo" src="${photoUrl(t.cover)}" alt="" loading="lazy">` : `<span style="font-size:2.4rem">🧭</span>`}${t.countries[0] ? flagImg(t.countries[0], "flag") : ""}</div>
      <div class="tbody"><h3>${esc(t.titulo)}</h3><div class="tmeta"><span>${range(t)}</span><span>${t.steps.length} lugares</span>${t.days ? `<span>${t.days} ${t.days === 1 ? "día" : "días"}</span>` : ""}${t.km ? `<span>${t.km.toLocaleString("es")} km</span>` : ""}${t.photos ? `<span>${t.photos} fotos</span>` : ""}</div></div></button>`).join("")}</div>`
      : `<div class="empty">Cuando carguen lugares, van a aparecer acá como viajes.</div>`}
  </section>`));
  inner.onclick = e => { const t = e.target.closest("[data-trip]"); if (t) go({ tripId: t.dataset.trip }); };
}

function viewTrip(inner, trip) {
  const steps = trip.steps;
  inner.append(slot(`<section class="v">
    <div class="crumbs"><button data-back>Viajes</button><span class="sep">›</span><span class="here">${esc(trip.titulo)}</span></div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
      <div class="kpi"><b>${steps.length}</b><span>lugares</span></div>
      ${trip.days ? `<div class="kpi"><b>${trip.days}</b><span>${trip.days === 1 ? "día" : "días"}</span></div>` : ""}
      ${trip.km ? `<div class="kpi"><b>${trip.km.toLocaleString("es")}</b><span>km en la ruta</span></div>` : ""}
      <div class="kpi"><b>${trip.photos}</b><span>fotos</span></div></div>
    <div class="mapbox"><svg id="tripMap" viewBox="0 0 960 460" role="img" aria-label="Ruta del viaje"></svg><div class="maptip" id="tripTip" hidden></div></div>
    <div class="feed">${steps.map((s, i) => `<div class="step"><div class="num">${i + 1}</div><div class="sbody">
      ${(s.fotos || [])[0] ? `<img class="simg" data-open="${esc(s.id)}" src="${photoUrl(s.fotos[0])}" alt="" loading="lazy">` : ""}
      <div class="stext"><h3><button style="background:none;border:0;padding:0;font:inherit;color:inherit;text-align:left" data-open="${esc(s.id)}">${esc(s.nombre)}</button></h3>
        <div class="help">${esc(s.tipo || "")}${s._rname ? " · " + esc(s._rname) : ""}${s.fecha ? " · " + fmtDate(s.fecha) : ""}${s.conQuien ? " · con " + esc(s.conQuien) : ""}</div>
        ${s.notas && !/^(Coordenadas aproximadas|Punto de referencia)/.test(s.notas) ? `<div class="notes">${esc(s.notas)}</div>` : ""}</div></div></div>`).join("")}</div>
  </section>`));
  drawTrip($("#tripMap", inner), $("#tripTip", inner), steps, p => openSheet("place", p.id));
  inner.onclick = e => {
    if (e.target.closest("[data-back]")) return go({ tripId: null });
    const o = e.target.closest("[data-open]"); if (o) openSheet("place", o.dataset.open);
  };
}

/* ---------- EVENTOS ---------- */
const EMOJI_RULES = [[/oktoberfest|cerveza|bier|beer|wiesn/, "🍺"], [/lego/, "🧱"], [/castillo|schloss|neuschwanstein|burg|palacio|castle/, "🏰"], [/concierto|konzert|show|recital|festival/, "🎵"], [/cumple|birthday/, "🎂"], [/boda|casamiento|hochzeit/, "💍"], [/futbol|partido|stadion|estadio|bayern/, "⚽"], [/navidad|weihnacht|christkindl/, "🎄"], [/museo|museum|expo/, "🖼️"], [/ski|nieve|schnee/, "⛷️"], [/playa|strand|beach/, "🏖️"], [/parque|park|zoo/, "🎢"], [/teatro|opera|theater/, "🎭"], [/vuelo|flug|aeropuerto/, "✈️"], [/cena|comida|restaurant/, "🍽️"]];
const EMOJI_PICK = ["✨", "🍺", "🏰", "🧱", "🎢", "🎵", "🎂", "💍", "⚽", "🎄", "🖼️", "⛷️", "🏖️", "🎭", "✈️", "🍽️", "🥨", "🚂", "⛰️", "🎉"];
const guessEmoji = t => EMOJI_RULES.find(([re]) => re.test(norm(t)))?.[1] || "✨";
const evMeta = e => [e.fecha ? fmtDate(e.fecha) : "", e.lugar || "", e.pais && !(e.lugar || "").includes(e.pais) ? e.pais : ""].filter(Boolean).join(" · ");

function viewEventos(inner) {
  globe.stop();
  const list = [...eventos].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (a.titulo || "").localeCompare(b.titulo || "", "es"));
  inner.append(slot(`<section class="v"><div class="section-head"><h2>Eventos especiales</h2></div><p class="help" style="margin:0">Cosas que no son una ciudad: festivales, parques, castillos…</p>
    <div class="pills">${list.map(e => { const m = evMeta(e), n = (e.fotos || []).length; return `<button class="pill" data-ev="${esc(e.id)}"><span class="em" aria-hidden="true">${esc(e.emoji || guessEmoji(e.titulo))}</span><span class="tx"><b>${esc(e.titulo)}</b>${m || n ? `<small>${esc(m)}${n ? `${m ? " · " : ""}${n} ${n === 1 ? "foto" : "fotos"}` : ""}</small>` : ""}</span></button>`; }).join("")}
    <button class="pill add" data-ev="__new"><span class="em" aria-hidden="true">+</span><span class="tx"><b>Nuevo evento</b></span></button></div></section>`));
  inner.onclick = e => { const t = e.target.closest("[data-ev]"); if (t) t.dataset.ev === "__new" ? openSheet("eventForm") : openSheet("event", t.dataset.ev); };
}

/* ---------- ESTADÍSTICAS ---------- */
let miniStop = null;
function viewStats(inner) {
  globe.stop();
  const s = computeStats(places, eventos);
  const C = 2 * Math.PI * 60, pct = (s.pct * 100).toFixed(1).replace(".", ",");
  const years = Object.entries(s.years).sort((a, b) => b[0] - a[0]);
  const byCountry = d3.rollups(places, v => v.length, p => p._a2).filter(([a]) => a).sort((a, b) => b[1] - a[1]);
  inner.append(slot(`<section class="v"><h2>Estadísticas</h2>
    <div class="spacecard">
      <div class="ringwrap">
        <svg viewBox="0 0 150 150" aria-hidden="true"><circle cx="75" cy="75" r="60" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="12"/><circle cx="75" cy="75" r="60" fill="none" stroke="var(--g-visited)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * s.pct).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 75 75)"/>
          <text x="75" y="76" class="rtxt">${pct}%</text><text x="75" y="98" class="rsub">del mundo</text></svg>
        <div class="ringcap">${s.sovereign.length} de ${TOTAL_COUNTRIES} países</div></div>
      <div class="miniglobe"><div class="glow"></div><canvas id="miniGlobe" aria-hidden="true"></canvas></div></div>
    <div class="panel"><h3>Por continente</h3><div class="bars">${Object.entries(s.byCont).map(([k, c]) => `<div class="bar"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${(c.seen / c.total * 100).toFixed(1)}%"></div></div><span class="num">${c.seen} / ${c.total}</span></div>`).join("")}</div></div>
    <div class="panel"><h3>Lugares por país</h3><div class="bars">${byCountry.map(([a, n]) => `<div class="bar"><span>${flagImg(a)} ${esc(geo.countryName[a] || a)}</span><div class="track"><div class="fill" style="width:${(n / byCountry[0][1] * 100).toFixed(1)}%"></div></div><span class="num">${n}</span></div>`).join("") || `<span class="help">Sin datos todavía.</span>`}</div></div>
    ${years.length ? `<div class="panel"><h3>Países por año</h3><div class="bars">${years.map(([y, n]) => `<div class="bar"><span>${y}</span><div class="track"><div class="fill" style="width:${(n / Math.max(...years.map(x => x[1])) * 100).toFixed(1)}%"></div></div><span class="num">${n}</span></div>`).join("")}</div></div>` : `<p class="help">Cuando carguen fechas de visita, acá aparece cuántos países conocieron cada año.</p>`}
    <div class="row"><button class="btn primary" id="shareBtn">Compartir mi mapa</button></div></section>`));
  $("#shareBtn", inner).onclick = () => shareCard(s, byCountry);
  miniStop = startMiniGlobe($("#miniGlobe", inner), s.visited, places);
}

async function shareCard(s, byCountry) {
  const c = document.createElement("canvas"); c.width = 1080; c.height = 1350;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 0, 1350); g.addColorStop(0, "#0d2236"); g.addColorStop(1, "#07121c");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
  x.fillStyle = "#fff"; x.textAlign = "center";
  x.font = "700 80px 'Bricolage Grotesque',sans-serif"; x.fillText("Bitácora de viajes", 540, 200);
  x.font = "700 300px 'Bricolage Grotesque',sans-serif"; x.fillText((s.pct * 100).toFixed(1).replace(".", ",") + "%", 540, 620);
  x.font = "500 52px 'Bricolage Grotesque',sans-serif"; x.fillText(`del mundo · ${s.sovereign.length} países`, 540, 710);
  x.font = "500 44px 'Source Serif 4',serif";
  x.fillText(byCountry.map(([a]) => geo.countryName[a] || a).join("  ·  "), 540, 860, 960);
  x.font = "500 40px 'Bricolage Grotesque',sans-serif";
  x.fillText(`${s.regions} regiones · ${places.length} lugares · ${s.photos} fotos`, 540, 980);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  const file = new File([blob], "bitacora.png", { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: "Mi bitácora de viajes" }); return; } catch { /* cancelado */ } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "bitacora.png"; a.click();
  toast("Imagen descargada");
}

/* ---------- render ---------- */
function render() {
  miniStop?.(); miniStop = null;
  $$("#tabbar button[data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === state.tab));
  syncGlider();
  renderHeader();
  const main = $("#main"), top = $("#topSlot");
  const showGlobe = loaded && state.tab === "inicio" && state.level === "world";
  if (showGlobe) top.append(heroWrap); else heroWrap.remove();
  if (state.tab !== "inicio" || state.level === "world") mapBox.remove();
  main.replaceChildren();
  const inner = document.createElement("div"); inner.className = "inner"; main.append(inner);
  if (!loaded) { inner.innerHTML = `<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`; return; }
  ({ inicio: viewInicio, viajes: viewViajes, eventos: viewEventos, stats: viewStats })[state.tab](inner);
  if (state.sheet) renderSheet();
}

/* ---------- hoja (detalle, formularios, cuenta, perfiles) ---------- */
function openSheet(type, id = null) { state.sheet = { type, id }; $("#overlay").hidden = false; document.body.style.overflow = "hidden"; renderSheet(); }
function closeSheet() { state.sheet = null; $("#overlay").hidden = true; document.body.style.overflow = ""; }
$("#overlay").addEventListener("click", e => { if (e.target.id === "overlay") closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") { if (!$("#lightbox").hidden) $("#lightbox").hidden = true; else if (state.sheet) closeSheet(); } });

const head = (label, title, extra = "") => `<div class="sheet-head"><div>${extra}<div class="label">${label}</div><h2 id="sheetTitle">${title}</h2></div><button class="close" id="closeSheet" aria-label="Cerrar">✕</button></div>`;

function renderSheet() {
  const { type, id } = state.sheet, s = $("#sheet");
  const fn = { menu: sheetMenu, place: sheetPlace, placeForm: sheetPlaceForm, event: sheetEvent, eventForm: sheetEventForm, photos: sheetPhotoPicker, country: sheetCountry, account: sheetAccount, accountMenu: sheetAccountMenu, switchProfile: sheetSwitch, invite: sheetInvite }[type];
  s.onclick = null;
  if (!fn(s, id)) return closeSheet();
  $("#closeSheet", s)?.addEventListener("click", closeSheet);
}

function sheetMenu(s) {
  s.innerHTML = head("Agregar", "¿Qué sumamos?") + `<div class="sheet-body"><div class="menu">
    <button data-m="placeForm"><span class="ico">📍</span>Lugar</button><button data-m="eventForm"><span class="ico">🎉</span>Evento</button><button data-m="photos"><span class="ico">📷</span>Fotos</button></div></div>`;
  s.onclick = e => { const b = e.target.closest("[data-m]"); if (b) openSheet(b.dataset.m); };
  return true;
}

function sheetCountry(s, a2) {
  const name = geo.countryName[a2]; if (!name) return false;
  const mine = places.filter(p => p._a2 === a2), byTipo = d3.rollups(mine, v => v.length, p => p.tipo).sort((a, b) => b[1] - a[1]);
  const regions = new Set(mine.map(p => p._rkey).filter(Boolean)).size;
  s.innerHTML = head(esc(continentOf(a2) || "País"), esc(name), `<span style="display:block;margin-bottom:6px">${flagImg(a2, "")}</span>`) + `<div class="sheet-body">
    <dl class="facts"><dt>Lugares</dt><dd>${mine.length}</dd><dt>Regiones</dt><dd>${regions}</dd>${byTipo.map(([t, n]) => `<dt>${esc(plural(t))}</dt><dd>${n}</dd>`).join("")}</dl>
    <div class="row"><button class="btn primary" id="seeDetail">Ver en detalle</button></div></div>`;
  $("#seeDetail", s).onclick = () => { pref.set("vision", "detalle"); closeSheet(); go({ vision: "detalle", tab: "inicio", level: "country", a2, region: null, tipo: null }); };
  return true;
}

/* ---- cuenta ---- */
function sheetAccount(s) {
  s.innerHTML = head("Cuenta", "Mi cuenta") + `<div class="sheet-body">
    <div class="who"><button class="avatar avatar-lg" id="bigAvatar" aria-label="Cambiar foto">${me.avatar ? `<img src="${photoUrl(me.avatar)}" alt="">` : esc(initial(me.name))}</button>
      <div><button class="btn" id="changePhoto">Cambiar foto</button><div class="help" style="margin-top:6px">${esc(me.email)}</div></div></div>
    <form class="form" id="nameForm" novalidate><div class="field full"><label class="label" for="acc-name">Nombre</label><input id="acc-name" maxlength="60" value="${esc(me.name)}"></div>
      <div class="row" style="grid-column:1/-1"><button class="btn primary" type="submit">Guardar nombre</button><span class="msg" id="nameMsg"></span></div></form>
    <form class="form" id="pwForm" novalidate><div class="field"><label class="label" for="pw-cur">Contraseña actual</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
      <div class="field"><label class="label" for="pw-new">Contraseña nueva</label><input id="pw-new" type="password" autocomplete="new-password" minlength="8"></div>
      <div class="row" style="grid-column:1/-1"><button class="btn" type="submit">Cambiar contraseña</button><span class="msg" id="pwMsg"></span></div></form>
    <div class="row"><button class="btn danger" id="logoutBtn">Cerrar sesión</button></div></div>`;
  const pick = () => { const i = $("#avatarInput"); i.value = ""; i.onchange = async () => {
    if (!i.files[0]) return;
    try { const blob = await cropAvatar(i.files[0]); if (!blob) return; await api.avatar(blob); await loadMe(); renderHeader(); renderSheet(); toast("Foto actualizada"); } catch (e) { toast("No se pudo subir la foto: " + e.message); }
  }; i.click(); };
  $("#changePhoto", s).onclick = pick; $("#bigAvatar", s).onclick = pick;
  $("#nameForm", s).onsubmit = async e => {
    e.preventDefault(); const m = $("#nameMsg", s);
    try { await api.rename($("#acc-name", s).value); await loadMe(); renderHeader(); m.className = "msg ok"; m.textContent = "Guardado"; } catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };
  $("#pwForm", s).onsubmit = async e => {
    e.preventDefault(); const m = $("#pwMsg", s);
    try { await api.changePassword($("#pw-cur", s).value, $("#pw-new", s).value); m.className = "msg ok"; m.textContent = "Contraseña cambiada"; $("#pwForm", s).reset(); } catch (err) { m.className = "msg err"; m.textContent = err.message; }
  };
  $("#logoutBtn", s).onclick = async () => { try { await api.logout(); } catch { /* ya cerrada */ } closeSheet(); toLogin(); };
  return true;
}

/* ---- menú del avatar: ir a otro perfil / invitar / ajustes ---- */
function sheetAccountMenu(s) {
  const cur = profile();
  const others = profiles.filter(p => p.id !== cur.id);
  const opposite = others.filter(p => p.kind !== cur.kind);
  const targets = opposite.length ? opposite : others;
  const row = (id, ico, title, sub) => `<button class="opt" data-opt="${id}"><span class="ico">${ico}</span><span class="tx"><b>${title}</b><span class="help">${sub}</span></span><span class="chev">›</span></button>`;
  let switchRow = "";
  if (targets.length === 1) switchRow = row("switch1", targets[0].kind === "shared" ? "👥" : "👤", `Ir a perfil “${kindLabel(targets[0].kind)}”`, targets[0].kind === "shared" ? esc(targets[0].name) : "Solo vos");
  else if (targets.length > 1) switchRow = row("switchN", "🔀", "Cambiar de perfil", `${targets.length} perfiles disponibles`);
  s.innerHTML = head("Cuenta", esc(`¡Hola, ${me.name.trim().split(/\s+/)[0]}!`)) + `<div class="sheet-body">
    <p class="help" style="margin:0">Estás viendo el perfil <b>${kindLabel(cur.kind)}</b>${cur.kind === "shared" ? ` “${esc(cur.name)}”` : ""}.</p>
    <div style="display:flex;flex-direction:column;gap:10px">${switchRow}${row("invite", "✉️", "Invitar a alguien", "Compartí una bitácora por email")}${row("settings", "⚙️", "Ajustes", "Tu cuenta, foto y contraseña")}</div>
    ${cur.kind === "shared" && cur.role !== "owner" ? `<div class="row"><button class="linkbtn" id="leaveHere">Salir de este perfil compartido</button></div>` : ""}</div>`;
  s.onclick = async e => {
    const b = e.target.closest("[data-opt]"); if (!b) return;
    const o = b.dataset.opt;
    if (o === "switch1") { await switchProfile(targets[0].id); toast(`Ahora estás en el perfil ${kindLabel(targets[0].kind)}`); }
    else if (o === "switchN") openSheet("switchProfile");
    else if (o === "invite") openSheet("invite");
    else if (o === "settings") openSheet("account");
  };
  $("#leaveHere", s)?.addEventListener("click", () => leaveProfile(cur));
  return true;
}

function sheetSwitch(s) {
  const cur = profile();
  s.innerHTML = head("Perfiles", "Cambiar de perfil") + `<div class="sheet-body"><div style="display:flex;flex-direction:column;gap:8px">${profiles.map(p => `<button class="prof" data-switch="${p.id}" aria-current="${p.id === cur.id}"><div class="tx"><b>${kindLabel(p.kind)}${p.kind === "shared" ? ` · ${esc(p.name)}` : ""}</b><span class="help">${p.kind === "shared" ? `${p.members} ${p.members === 1 ? "persona" : "personas"}` : "Solo vos"}</span></div>${p.id === cur.id ? `<span class="badge2">Activo</span>` : ""}</button>`).join("")}</div></div>`;
  s.onclick = async e => { const b = e.target.closest("[data-switch]"); if (b) { await switchProfile(b.dataset.switch); toast("Perfil cambiado"); } };
  return true;
}

async function leaveProfile(p) {
  const owner = p.role === "owner";
  if (!confirm(owner ? `¿Borrar “${p.name}” con todos sus lugares y fotos? No se puede deshacer.` : `¿Salir de “${p.name}”?`)) return;
  try {
    await (owner ? api.deleteProfile(p.id) : api.removeMember(p.id, me.id));
    await loadMe();
    if (activeId === p.id || !profiles.some(x => x.id === activeId)) await switchProfile(profiles.find(x => x.kind === "personal").id);
    else renderSheet();
    toast("Listo");
  } catch (e) { toast(e.message); }
}

/* ---- invitar ---- */
function sheetInvite(s) {
  const owned = profiles.filter(p => p.kind === "shared" && p.role === "owner");
  const cur = profile();
  const sel = state.sheet.sel || (owned.find(p => p.id === cur.id) || owned[0])?.id || "__new";
  s.innerHTML = head("Invitar", "Invitar a alguien") + `<div class="sheet-body">
    <p class="help" style="margin:0">La persona invitada va a poder ver y cargar viajes en el perfil compartido. Tu perfil Individual sigue siendo solo tuyo.</p>
    <form class="form" id="invForm" novalidate>
      ${field("inv-profile", "Perfil compartido", `<select id="inv-profile">${owned.map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("")}<option value="__new" ${sel === "__new" ? "selected" : ""}>＋ Crear un perfil compartido nuevo</option></select>`, "full")}
      <div class="field full" id="newNameBox" ${sel === "__new" ? "" : "hidden"}><label class="label" for="inv-name">Nombre del perfil nuevo</label><input id="inv-name" maxlength="60" placeholder="Ej: Viajes en pareja"></div>
      ${field("inv-email", "Email de la persona", `<input id="inv-email" type="email" inputmode="email" autocomplete="off" placeholder="nombre@ejemplo.com">`, "full")}
      <div class="row" style="grid-column:1/-1"><button class="btn primary" type="submit">Invitar</button><span class="msg" id="invMsg" role="status"></span></div></form>
    <div id="members"></div></div>`;
  const pickSel = () => $("#inv-profile", s).value;
  $("#inv-profile", s).onchange = () => { $("#newNameBox", s).hidden = pickSel() !== "__new"; loadMembers(s, pickSel()); };
  $("#invForm", s).onsubmit = async e => {
    e.preventDefault();
    const m = $("#invMsg", s), email = $("#inv-email", s).value.trim();
    const fail = t => { m.className = "msg err"; m.textContent = t; };
    if (!email) return fail("Escribí el email de la persona.");
    let pid = pickSel(); const btn = $("button[type=submit]", s); btn.disabled = true;
    try {
      if (pid === "__new") {
        const name = $("#inv-name", s).value.trim();
        if (!name) { btn.disabled = false; return fail("Poné un nombre para el perfil compartido."); }
        pid = (await api.newProfile(name)).id;
      }
      await api.invite(pid, email);
      await loadMe();
      state.sheet.sel = pid; renderSheet();            // vuelve a dibujar con el perfil ya creado
      const m2 = $("#invMsg", s); m2.className = "msg ok"; m2.textContent = `Ya enviamos la invitación a ${email}.`;
      toast("Ya enviamos la invitación");
    } catch (err) { fail(err.message); btn.disabled = false; }
  };
  loadMembers(s, sel);
  return true;
}

async function loadMembers(s, pid) {
  const box = $("#members", s); if (!box) return;
  const p = profiles.find(x => x.id === pid);
  if (!p) { box.innerHTML = ""; return; }
  let info; try { info = await api.members(pid); } catch { return; }
  if (state.sheet?.type !== "invite" || !$("#members", s)) return;
  const owner = p.role === "owner";
  const people = info.members.map(m => `<div class="member"><span class="avatar">${m.avatar ? `<img src="${photoUrl(m.avatar)}" alt="">` : esc(initial(m.name))}</span><div style="flex:1;min-width:0"><b style="font-family:var(--f-display)">${esc(m.name)}${m.id === me.id ? " (vos)" : ""}</b><div class="help">${esc(m.email)} · ${m.role === "owner" ? "creó el perfil" : "editor"}</div></div>${owner && m.role !== "owner" ? `<button class="linkbtn" data-rm="${m.id}">Quitar</button>` : ""}</div>`).join("");
  const pending = info.invites.map(i => `<div class="member"><span class="avatar" style="background:var(--land);color:var(--muted)">✉</span><div style="flex:1"><b style="font-family:var(--f-display)">${esc(i.email)}</b><div class="help">Invitación pendiente</div></div>${owner ? `<button class="linkbtn" data-cancel="${i.id}">Cancelar</button>` : ""}</div>`).join("");
  box.innerHTML = `<div class="panel"><h3>Personas en “${esc(p.name)}”</h3><div>${people}${pending}</div>${owner ? `<div class="row"><button class="btn danger" id="delProf">Borrar este perfil</button></div>` : ""}</div>`;
  $$("[data-rm]", box).forEach(b => (b.onclick = async () => { try { await api.removeMember(pid, b.dataset.rm); await loadMe(); loadMembers(s, pid); } catch (e) { toast(e.message); } }));
  $$("[data-cancel]", box).forEach(b => (b.onclick = async () => { try { await api.cancelInvite(b.dataset.cancel); loadMembers(s, pid); } catch (e) { toast(e.message); } }));
  $("#delProf", box)?.addEventListener("click", () => leaveProfile(p));
}

async function switchProfile(id, keepSheet = false) {
  activeId = id; setProfile(id); pref.set("profile", id);
  Object.assign(state, { tab: "inicio", level: "world", a2: null, region: null, tipo: null, tripId: null });
  if (!keepSheet) closeSheet();
  loaded = false; render();
  await loadProfileData(); loaded = true; viewInicio.shown = false; render();
}

/* ---- fotos de lugares y eventos ---- */
function photoBlock(kind, item) {
  const fotos = item.fotos || [];
  return `<div class="gallery" id="gal">${fotos.map((pid, i) => `<button data-i="${i}" aria-label="Ver foto ${i + 1}"><img src="${photoUrl(pid)}" alt="" loading="lazy">${i === 0 ? `<span class="badge">Portada</span>` : ""}</button>`).join("")}</div>
  <div class="drop" id="drop"><span>${fotos.length ? "Sumar más fotos" : "Todavía no hay fotos. Elegilas de tu galería o sacá una ahora."}</span>
    <div class="row"><button class="btn primary" id="pickPhotos" type="button">Elegir fotos</button><button class="btn" id="takePhoto" type="button">Sacar foto</button></div>
    ${fotos.length ? "" : `<button class="btn later" id="laterBtn" type="button">Agregar después</button>`}
    <div class="progress" id="prog" hidden><i></i></div></div>`;
}
function wirePhotos(s, kind, item) {
  const run = async files => {
    const prog = $("#prog", s), bar = $("i", prog); prog.hidden = false;
    await uploadPhotos(kind, item.id, files, (n, t) => (bar.style.width = (t ? n / t * 100 : 0) + "%"));
    await refresh(kind); render(); if (state.sheet) renderSheet();
  };
  const pick = input => { input.value = ""; input.onchange = () => run(input.files); input.click(); };
  $("#pickPhotos", s).onclick = () => pick($("#photoInput"));
  $("#takePhoto", s).onclick = () => pick($("#cameraInput"));
  const later = $("#laterBtn", s); if (later) later.onclick = closeSheet;
  const drop = $("#drop", s);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); run(e.dataTransfer.files); };
  $$("#gal button", s).forEach(b => (b.onclick = () => openLightbox(kind, item.id, +b.dataset.i)));
}
function confirmDelete(s, kind, item, label) {
  const box = $("#delConfirm", s);
  box.innerHTML = `<span class="help">¿Borrar “${esc(label)}” y sus fotos?</span> <button class="btn danger" id="delYes">Sí, borrar</button> <button class="btn" id="delNo">Cancelar</button>`;
  $("#delNo", s).onclick = () => (box.innerHTML = "");
  $("#delYes", s).onclick = async () => {
    try { await api.remove(kind, item.id); closeSheet(); await refresh(kind); render(); toast("Borrado"); } catch (e) { toast("No se pudo borrar: " + e.message); }
  };
}

function sheetPlace(s, id) {
  const p = placeById(id); if (!p) return false;
  const xy = p._hasXY ? `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? "N" : "S"} · ${Math.abs(p.lng).toFixed(4)}° ${p.lng >= 0 ? "E" : "O"}` : "";
  const note = p.notas && !/^(Coordenadas aproximadas|Punto de referencia)/.test(p.notas) ? p.notas : "";
  s.innerHTML = head(`<span style="color:${tcolor(p.tipo)}">${esc(p.tipo || "Lugar")}</span>`, esc(p.nombre)) + `<div class="sheet-body">
    ${photoBlock("lugares", p)}
    ${note ? `<div class="notes">${esc(note)}</div>` : ""}
    <dl class="facts"><dt>País</dt><dd>${esc(p.pais || "—")}</dd><dt>Región</dt><dd>${esc(p._rname || "—")}</dd><dt>Fecha</dt><dd>${p.fecha ? fmtDate(p.fecha) : "—"}</dd>
    <dt>Ubicación</dt><dd>${xy ? `<span class="mono">${xy}</span> · <a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener">Abrir en Google Maps</a>` : "Sin coordenadas"}${/aproximadas/.test(p.notas || "") ? ` <span class="help">(aprox.)</span>` : ""}</dd></dl>
    <div class="row"><button class="btn" id="editBtn">Editar datos</button><button class="btn danger" id="delBtn">Borrar lugar</button><span id="delConfirm"></span></div></div>`;
  wirePhotos(s, "lugares", p);
  $("#editBtn", s).onclick = () => openSheet("placeForm", p.id);
  $("#delBtn", s).onclick = () => confirmDelete(s, "lugares", p, p.nombre);
  return true;
}

const field = (id, label, html, cls = "") => `<div class="field ${cls}"><label class="label" for="${id}">${label}</label>${html}</div>`;

// crypto.randomUUID no existe en http:// (solo en HTTPS/localhost); getRandomValues sí.
const newSession = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const FORM_TIPOS = ["Ciudad", "Lago", "Montaña", "Río"];
const CITY_HINT = "París, Londres, Barcelona…";

function sheetPlaceForm(s, id) {
  const p = id ? placeById(id) : null;
  if (id && !p) return false;
  const paises = [...new Set([...places.map(x => x.pais).filter(Boolean), ...Object.values(geo.countryName)])].sort((a, b) => a.localeCompare(b, "es"));
  const tipos = [...new Set([...FORM_TIPOS, p?.tipo].filter(Boolean))];
  const tipo0 = p?.tipo || "Ciudad";
  s.innerHTML = head("Lugar", p ? `Editar: ${esc(p.nombre)}` : "Nuevo lugar") + `<div class="sheet-body"><form class="form" id="placeForm" novalidate>
    ${field("f-tipo", "Tipo *", `<select id="f-tipo">${tipos.map(t => `<option ${t === tipo0 ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`)}
    ${field("f-nombre", "Lugar *", `<input id="f-nombre" required autocomplete="off" autocapitalize="words" value="${esc(p?.nombre)}" placeholder="${tipo0 === "Ciudad" ? CITY_HINT : ""}"><ul class="sugg" id="sugg" hidden></ul>`, "pos")}
    ${field("f-pais", "País *", `<input id="f-pais" list="paises" value="${esc(p?.pais || "")}" placeholder="Argentina, Alemania, España…"><datalist id="paises">${paises.map(x => `<option value="${esc(x)}">`).join("")}</datalist>`)}
    ${field("f-region", "Región", `<input id="f-region" value="${esc(p?.region)}" placeholder="Se completa sola con las coordenadas">`)}
    ${field("f-fecha", "Fecha de visita", `<input id="f-fecha" type="date" value="${esc(p?.fecha)}">`)}
    ${field("f-coords", "Coordenadas", `<input id="f-coords" class="mono" value="${p?._hasXY ? `${p.lat}, ${p.lng}` : ""}" placeholder="Se completan solas"><span class="help">Podés ajustarlas a mano. <button class="btn" type="button" id="geoBtn" style="padding:3px 10px">Usar mi ubicación</button></span>`, "full")}
    ${field("f-notas", "Notas", `<textarea id="f-notas" placeholder="Qué hicimos, qué comimos, qué no hay que perderse la próxima">${esc(p?.notas)}</textarea>`, "full")}
    <p class="help full" style="margin:0">* Campo obligatorio</p>
    <div class="row" style="grid-column:1/-1"><button class="btn primary" type="submit">${p ? "Guardar cambios" : "Guardar lugar"}</button><button class="btn" type="button" id="cancelBtn">Cancelar</button><span class="msg err" id="formMsg"></span></div></form></div>`;
  const [tipoEl, nameEl, paisEl, coordsEl, list, msg] = ["#f-tipo", "#f-nombre", "#f-pais", "#f-coords", "#sugg", "#formMsg"].map(q => $(q, s));
  let session = newSession(), seq = 0, timer = 0, autoCoords = false;
  const hide = () => { list.hidden = true; list.innerHTML = ""; };
  const setCoords = (lat, lng) => { coordsEl.value = `${(+lat).toFixed(5)}, ${(+lng).toFixed(5)}`; };
  const setCountry = (a2, name, lat, lng) => {
    const code = a2 || (lat != null ? countryAt(lat, lng) : null);
    const n = (code && geo.countryName[code]) || name;
    if (n) paisEl.value = n;
  };

  tipoEl.onchange = () => { nameEl.placeholder = tipoEl.value === "Ciudad" ? CITY_HINT : ""; hide(); };
  nameEl.addEventListener("input", () => {
    if (autoCoords) { coordsEl.value = ""; autoCoords = false; }
    clearTimeout(timer);
    const q = nameEl.value.trim();
    if (q.length < 2) return hide();
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const r = await api.placeSuggest(q, session, tipoEl.value);
        if (mine !== seq) return;
        list.innerHTML = r.length ? r.map(x => `<li><button type="button" data-id="${esc(x.id)}" data-main="${esc(x.main)}"><b>${esc(x.main)}</b>${x.sub ? `<span>${esc(x.sub)}</span>` : ""}</button></li>`).join("") : `<li class="none">Sin resultados. Podés escribirlo igual.</li>`;
        list.hidden = false;
      } catch { if (mine === seq) { list.innerHTML = `<li class="none">No pude buscar ahora. Podés escribirlo igual.</li>`; list.hidden = false; } }
    }, 250);
  });
  nameEl.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  document.addEventListener("pointerdown", function away(e) {
    if (!s.isConnected) return document.removeEventListener("pointerdown", away);
    if (!e.target.closest(".field.pos")) hide();
  });
  list.onclick = async e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    nameEl.value = b.dataset.main; hide(); seq++;
    msg.textContent = "";
    try {
      const d = await api.placeDetails(b.dataset.id, session);
      session = newSession(); // la sesión de cobro termina con el detalle
      if (d.lat != null) { setCoords(d.lat, d.lng); autoCoords = true; }
      setCountry(d.a2, d.pais, d.lat, d.lng);
    } catch (err) { msg.textContent = "No pude completar los datos: " + err.message; }
  };

  $("#cancelBtn", s).onclick = () => (p ? openSheet("place", p.id) : closeSheet());
  $("#geoBtn", s).onclick = () => navigator.geolocation?.getCurrentPosition(
    pos => { setCoords(pos.coords.latitude, pos.coords.longitude); autoCoords = false; if (!paisEl.value.trim()) setCountry(null, "", pos.coords.latitude, pos.coords.longitude); },
    () => toast("No pude obtener tu ubicación (en el celular necesita HTTPS)."), { enableHighAccuracy: true, timeout: 10000 });
  $("#placeForm", s).onsubmit = async e => {
    e.preventDefault();
    const nombre = nameEl.value.trim(), pais = paisEl.value.trim();
    if (!nombre) { msg.textContent = "Falta el lugar."; return nameEl.focus(); }
    if (!pais) { msg.textContent = "Falta el país."; return paisEl.focus(); }
    const raw = coordsEl.value.trim(); let lat = null, lng = null;
    if (raw) {
      const mm = raw.replace(/[°NnEeSsOoWw]/g, "").match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/);
      if (!mm) { msg.textContent = "No entiendo las coordenadas. Usá el formato 47.71, 11.75."; return; }
      lat = parseFloat(mm[1].replace(",", ".")); lng = parseFloat(mm[2].replace(",", "."));
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { msg.textContent = "Las coordenadas están fuera de rango."; return; }
    }
    const btn = $("button[type=submit]", s); btn.disabled = true;
    let found = true;
    if (lat == null) { // no eligió una sugerencia: buscamos la ubicación con lo escrito
      msg.textContent = "Buscando la ubicación…";
      try { const r = await api.placeResolve(`${nombre}, ${pais}`, tipoEl.value); if (r?.lat != null) { lat = r.lat; lng = r.lng; } else found = false; } catch { found = false; }
      msg.textContent = "";
    }
    const data = { nombre, tipo: tipoEl.value, pais, region: $("#f-region", s).value.trim(), fecha: $("#f-fecha", s).value, notas: $("#f-notas", s).value.trim(), lat, lng };
    try {
      const saved = p ? await api.update("lugares", p.id, data) : await api.add("lugares", data);
      await refresh("lugares"); render(); openSheet("place", saved.id);
      toast(found ? (p ? "Cambios guardados" : `“${nombre}” guardado`) : `“${nombre}” guardado, pero sin ubicación en el mapa`);
    } catch (err) { msg.textContent = "No se pudo guardar: " + err.message; btn.disabled = false; }
  };
  return true;
}

function sheetEvent(s, id) {
  const e = eventById(id); if (!e) return false;
  s.innerHTML = head("Evento", esc(e.titulo), `<span class="em" style="font-size:2rem">${esc(e.emoji || guessEmoji(e.titulo))}</span>`) + `<div class="sheet-body">
    ${photoBlock("eventos", e)}
    ${e.notas ? `<div class="notes">${esc(e.notas)}</div>` : ""}
    <dl class="facts"><dt>Fecha</dt><dd>${e.fecha ? fmtDate(e.fecha) : "—"}</dd><dt>Dónde</dt><dd>${esc(e.lugar || "—")}</dd><dt>País</dt><dd>${esc(e.pais || "—")}</dd></dl>
    <div class="row"><button class="btn" id="editBtn">Editar datos</button><button class="btn danger" id="delBtn">Borrar evento</button><span id="delConfirm"></span></div></div>`;
  wirePhotos(s, "eventos", e);
  $("#editBtn", s).onclick = () => openSheet("eventForm", e.id);
  $("#delBtn", s).onclick = () => confirmDelete(s, "eventos", e, e.titulo);
  return true;
}

function sheetEventForm(s, id) {
  const e = id ? eventById(id) : null;
  if (id && !e) return false;
  const cur0 = e?.emoji || guessEmoji(e?.titulo || "");
  let chosen = cur0, touched = !!e?.emoji;
  s.innerHTML = head("Evento", e ? "Editar evento" : "Nuevo evento") + `<div class="sheet-body"><form class="form" id="evForm" novalidate>
    ${field("ev-titulo", "Título", `<input id="ev-titulo" value="${esc(e?.titulo)}" placeholder="Oktoberfest 2026">`, "full")}
    <div class="field full"><span class="label">Emoji</span><div class="emoji-row" id="evEmojis">${[...new Set([cur0, ...EMOJI_PICK])].map(x => `<button type="button" data-e="${esc(x)}" aria-pressed="${x === cur0}">${esc(x)}</button>`).join("")}</div></div>
    ${field("ev-fecha", "Fecha", `<input id="ev-fecha" type="date" value="${esc(e?.fecha)}">`)}
    ${field("ev-lugar", "Dónde", `<input id="ev-lugar" value="${esc(e?.lugar)}" placeholder="Múnich">`)}
    ${field("ev-pais", "País", `<input id="ev-pais" value="${esc(e?.pais)}">`)}
    ${field("ev-notas", "Notas", `<textarea id="ev-notas" placeholder="Qué pasó, con quién fuimos, qué no nos queremos olvidar">${esc(e?.notas)}</textarea>`, "full")}
    <div class="row" style="grid-column:1/-1"><button class="btn primary" type="submit">${e ? "Guardar cambios" : "Guardar evento"}</button><button class="btn" type="button" id="cancelBtn">Cancelar</button><span class="msg err" id="evMsg"></span></div></form></div>`;
  const row = $("#evEmojis", s), mark = () => $$("button", row).forEach(b => b.setAttribute("aria-pressed", b.dataset.e === chosen));
  row.onclick = ev => { const b = ev.target.closest("button[data-e]"); if (b) { chosen = b.dataset.e; touched = true; mark(); } };
  $("#ev-titulo", s).addEventListener("input", ev => {
    if (touched) return;
    const g = guessEmoji(ev.target.value);
    if (g !== chosen) { chosen = g; if (!$(`[data-e="${g}"]`, row)) row.insertAdjacentHTML("afterbegin", `<button type="button" data-e="${g}">${g}</button>`); mark(); }
  });
  $("#cancelBtn", s).onclick = () => (e ? openSheet("event", e.id) : closeSheet());
  $("#evForm", s).onsubmit = async ev => {
    ev.preventDefault();
    const m = $("#evMsg", s), titulo = $("#ev-titulo", s).value.trim();
    if (!titulo) { m.textContent = "Falta el título."; return $("#ev-titulo", s).focus(); }
    const data = { titulo, emoji: chosen, fecha: $("#ev-fecha", s).value, lugar: $("#ev-lugar", s).value.trim(), pais: $("#ev-pais", s).value.trim(), notas: $("#ev-notas", s).value.trim() };
    try {
      const saved = e ? await api.update("eventos", e.id, data) : await api.add("eventos", data);
      await refresh("eventos"); render(); openSheet("event", saved.id); toast(e ? "Cambios guardados" : `“${titulo}” guardado`);
    } catch (err) { m.textContent = "No se pudo guardar: " + err.message; }
  };
  return true;
}

// "＋ → Fotos": elegir primero a qué lugar o evento van las fotos.
function sheetPhotoPicker(s) {
  const opts = [...places.filter(p => norm(p.tipo) !== "rio").sort((a, b) => a.nombre.localeCompare(b.nombre, "es")).map(p => `<option value="lugares:${esc(p.id)}">${esc(p.nombre)} (${esc(p.pais)})</option>`),
    ...eventos.map(e => `<option value="eventos:${esc(e.id)}">${esc(e.emoji || "")} ${esc(e.titulo)}</option>`)];
  s.innerHTML = head("Fotos", "¿De dónde son?") + `<div class="sheet-body">
    ${opts.length ? `${field("ph-target", "Lugar o evento", `<select id="ph-target">${opts.join("")}</select>`)}<div class="row"><button class="btn primary" id="phGo">Continuar</button></div>` : `<div class="empty">Todavía no hay lugares ni eventos.</div>`}
    <p class="help">¿No está en la lista? Primero creá el lugar o el evento con el botón ＋.</p></div>`;
  $("#phGo", s)?.addEventListener("click", () => { const [k, id] = $("#ph-target", s).value.split(":"); openSheet(k === "eventos" ? "event" : "place", id); });
  return true;
}

/* ---------- visor de fotos ---------- */
function openLightbox(kind, itemId, start) {
  const item = (kind === "eventos" ? eventById : placeById)(itemId), f = item?.fotos || [], lb = $("#lightbox");
  if (!f.length) return;
  let i = start;
  const show = () => {
    lb.innerHTML = `<img src="${photoUrl(f[i])}" alt="Foto ${i + 1} de ${esc(item.nombre || item.titulo)}">
      <div class="row"><button class="btn" id="lbPrev" ${i === 0 ? "disabled" : ""}>‹ Anterior</button><span class="mono" style="color:#cfd">${i + 1} / ${f.length}</span><button class="btn" id="lbNext" ${i === f.length - 1 ? "disabled" : ""}>Siguiente ›</button></div>
      <div class="row">${i > 0 ? `<button class="btn" id="lbCover">Usar de portada</button>` : ""}<button class="btn" id="lbDel">Borrar foto</button><button class="btn" id="lbClose">Cerrar</button></div>`;
    $("#lbPrev", lb).onclick = () => { if (i > 0) { i--; show(); } };
    $("#lbNext", lb).onclick = () => { if (i < f.length - 1) { i++; show(); } };
    $("#lbClose", lb).onclick = () => (lb.hidden = true);
    const cover = $("#lbCover", lb);
    if (cover) cover.onclick = async () => {
      try { await api.update(kind, itemId, { fotos: [f[i], ...f.filter((_, j) => j !== i)] }); lb.hidden = true; await refresh(kind); render(); toast("Portada actualizada"); } catch (e) { toast("No se pudo guardar: " + e.message); }
    };
    $("#lbDel", lb).onclick = () => {
      $("#lbDel", lb).outerHTML = `<button class="btn" id="lbDelYes" style="color:#ffb4ae">Confirmar borrado</button>`;
      $("#lbDelYes", lb).onclick = async () => {
        try { await api.removePhoto(kind, itemId, f[i]); lb.hidden = true; await refresh(kind); render(); toast("Foto borrada"); } catch (e) { toast("No se pudo borrar: " + e.message); }
      };
    };
  };
  lb.hidden = false; show();
}

/* ---------- arranque y sesión ---------- */
function toLogin(notice = "") {
  globe.stop(); loaded = false; me = null; places = []; eventos = [];
  closeSheet(); $("#shell").hidden = true;
  showAuth({ mode: "login", invited: !!sessionStorage.getItem("invite"), notice, onDone: enter });
}
window.addEventListener("unauth", () => { if (!$("#shell").hidden) toLogin("Tu sesión terminó. Iniciá sesión de nuevo."); });

async function acceptPendingInvite() {
  const token = sessionStorage.getItem("invite");
  if (!token) return;
  sessionStorage.removeItem("invite");
  try { const r = await api.acceptInvite(token); await loadMe(); activeId = r.profileId; pref.set("profile", r.profileId); toast("Te sumaste al perfil compartido"); }
  catch (e) { toast(e.message); }
  history.replaceState(null, "", location.pathname);
}

async function enter() {
  try {
    await loadMe();
    await acceptPendingInvite();
    activeId = profiles.some(p => p.id === activeId) ? activeId : profiles.some(p => p.id === pref.get("profile", "")) ? pref.get("profile", "") : (profiles.find(p => p.kind === "shared") || profiles[0]).id;
    setProfile(activeId);
    $("#auth").hidden = true; $("#shell").hidden = false;
    Object.assign(state, { tab: "inicio", level: "world", a2: null, region: null, tipo: null, tripId: null });
    loaded = false; render();
    if (!geoReady) { await loadGeo(); geoReady = true; }
    await loadProfileData();
    loaded = true; viewInicio.shown = false; render();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  } catch (e) {
    console.error(e);
    $("#main").innerHTML = `<div class="inner"><div class="empty">No se pudieron cargar los datos (${esc(e.message)}). Recargá la página.</div></div>`;
  }
}

async function start() {
  const q = new URLSearchParams(location.search);
  if (q.get("invite")) sessionStorage.setItem("invite", q.get("invite"));
  if (q.get("reset")) { showAuth({ mode: "reset", resetToken: q.get("reset"), onDone: enter }); return; }
  try { await api.me(); } catch { showAuth({ mode: "login", invited: !!sessionStorage.getItem("invite"), onDone: enter }); return; }
  await enter();
}
let lastW = innerWidth;
addEventListener("resize", () => {
  clearTimeout(window.__rz);
  window.__rz = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 40 && state.tab === "inicio" && state.level !== "world") { lastW = innerWidth; render(); } }, 250);
});
start();

/* ---------- diagnóstico (tocá 5 veces seguidas el logo): muestra medidas de la pantalla de la app instalada ---------- */
(function () {
  let taps = 0, timer;
  $(".brand").addEventListener("click", () => {
    clearTimeout(timer); timer = setTimeout(() => (taps = 0), 1500);
    if (++taps < 5) return;
    taps = 0;
    const old = $("#dbg"); if (old) return old.remove();
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe);
    const cs = getComputedStyle(probe), vv = window.visualViewport;
    const r = $("#shell").getBoundingClientRect(), d = $(".tabdock").getBoundingClientRect();
    const rows = [
      ["standalone", navigator.standalone === true || matchMedia("(display-mode: standalone)").matches],
      ["innerWidth x innerHeight", `${innerWidth} x ${innerHeight}`],
      ["screen", `${screen.width} x ${screen.height}`],
      ["visualViewport", vv ? `${Math.round(vv.width)} x ${Math.round(vv.height)} @ ${Math.round(vv.offsetTop)}` : "-"],
      ["safe-area (t r b l)", `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`],
      ["shell top/bottom", `${Math.round(r.top)} / ${Math.round(r.bottom)}`],
      ["barra top/bottom", `${Math.round(d.top)} / ${Math.round(d.bottom)}`],
      ["dpr", devicePixelRatio],
    ];
    probe.remove();
    const el = document.createElement("div"); el.id = "dbg";
    el.style.cssText = "position:fixed;left:8px;right:8px;top:50%;transform:translateY(-50%);z-index:99;background:rgba(0,0,0,.88);color:#fff;font:12px/1.5 ui-monospace,Menlo,monospace;padding:12px 14px;border-radius:12px";
    el.innerHTML = rows.map(([a, b]) => `<div><b>${a}</b>: ${b}</div>`).join("") + `<div style="margin-top:8px;opacity:.7">Sacale una captura y mandámela. Tocá 5 veces el logo para cerrar.</div>`;
    document.body.append(el);
  });
})();
