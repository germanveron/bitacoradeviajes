// Mapa plano (SVG + D3): país → región con pines y etiquetas; y mapa de ruta de un viaje.
import { cssVar, tcolor, isMobile } from "./util.js?v=19";
import { geo, mainland, countryFeature, REGION_ALIAS } from "./geo.js?v=19";
const d3 = window.d3;

const W = 960, H = 600, PS = 0.78;

const norm = s => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function setFrame(svgEl, h) {
  svgEl.setAttribute("viewBox", `0 0 ${W} ${h}`);
  svgEl.style.aspectRatio = `${W} / ${h}`;
  const cw = svgEl.getBoundingClientRect().width || W;
  return Math.min(3, Math.max(1, W / cw));
}

export function createFlatMap(svgEl, tipEl, { onPlace, onRegion }) {
  const svg = d3.select(svgEl);
  const root = svg.append("g");
  let U = 1, PB = 1;
  let curK = 1;
  // Sin zoom, un dedo scrollea la página (el mapa ya entra entero); con zoom, un dedo mueve el mapa.
  // La página se sigue scrolleando tocando fuera del mapa.
  const zoom = d3.zoom().scaleExtent([1, 24])
    .filter(e => (e.type.startsWith("touch") ? e.touches.length > 1 || curK > 1.001 : e.type === "wheel" ? e.ctrlKey || e.metaKey : !e.button))
    .on("zoom", e => {
      root.attr("transform", e.transform); applyK(e.transform.k);
      curK = e.transform.k; svgEl.style.touchAction = curK > 1.001 ? "none" : "";
      svgEl.parentElement.classList.toggle("zoomed", curK > 1.001);
    });
  svg.call(zoom).on("dblclick.zoom", null);

  function showTip(ev, text) {
    const box = svgEl.parentElement.getBoundingClientRect();
    tipEl.textContent = text; tipEl.style.left = ev.clientX - box.left + "px"; tipEl.style.top = ev.clientY - box.top + "px"; tipEl.hidden = false;
  }
  const hideTip = () => (tipEl.hidden = true);

  function applyK(k) {
    root.selectAll("g.pin").attr("transform", d => `translate(${d._x},${d._y}) scale(${(PS * PB) / Math.sqrt(k)})`);
    root.selectAll("text.rlabel").attr("font-size", (14 * U) / k).attr("stroke-width", (3 * U) / k);
    layoutPinLabels(k);
  }

  // Etiquetas de pines sin solaparse: prueba derecha, izquierda, arriba y abajo.
  function layoutPinLabels(k) {
    const lab = root.selectAll("text.plabel");
    if (lab.empty()) return;
    const s = (PS * PB) / Math.sqrt(k), fs = (12 * U) / k, cw = fs * 0.56, hgt = fs * 1.1, placed = [];
    root.selectAll("g.pin").each(d => placed.push({ x0: d._x - 6 * s, x1: d._x + 6 * s, y0: d._y - 21 * s, y1: d._y }));
    root.selectAll("text.rlabel").each(function () { try { const b = this.getBBox(); if (b.width) placed.push({ x0: b.x, x1: b.x + b.width, y0: b.y, y1: b.y + b.height }); } catch { /* sin layout */ } });
    const hit = b => placed.some(o => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    lab.attr("font-size", fs).attr("stroke-width", (3 * U) / k).each(function (d) {
      const w = d.nombre.length * cw, hy = d._y - 15 * s, g = 8 * s + (2 * U) / k;
      const opts = [
        [d._x + g, hy + hgt * 0.35, "start", { x0: d._x + g, x1: d._x + g + w, y0: hy - hgt / 2, y1: hy + hgt / 2 }],
        [d._x - g, hy + hgt * 0.35, "end", { x0: d._x - g - w, x1: d._x - g, y0: hy - hgt / 2, y1: hy + hgt / 2 }],
        [d._x, d._y - 22 * s - 2 / k, "middle", { x0: d._x - w / 2, x1: d._x + w / 2, y0: d._y - 22 * s - 2 / k - hgt, y1: d._y - 22 * s - 2 / k }],
        [d._x, d._y + hgt + 1 / k, "middle", { x0: d._x - w / 2, x1: d._x + w / 2, y0: d._y + 1 / k, y1: d._y + hgt + 1 / k }],
      ];
      const o = opts.find(o => !hit(o[3]));
      if (o) { placed.push(o[3]); d3.select(this).attr("x", o[0]).attr("y", o[1]).attr("text-anchor", o[2]).attr("display", null); }
      else d3.select(this).attr("display", "none");
    });
  }

  function draw(c) {
    root.selectAll("*").remove();
    svg.call(zoom.transform, d3.zoomIdentity);
    const regs = geo.byA2[c.a2] || [];
    const countryF = countryFeature(c.a2);
    const target = c.level === "region" ? regs.find(f => f.properties._key === c.region) : null;
    const fitTo = target || (countryF ? mainland(countryF) : { type: "FeatureCollection", features: regs });
    const FH = isMobile() ? Math.round(W * 5 / 4) : H, pad = 24;
    U = setFrame(svgEl, FH); PB = Math.max(1, U * 0.8);
    const proj = d3.geoMercator().fitExtent([[pad, pad], [W - pad, FH - pad]], fitTo);
    const path = d3.geoPath(proj);
    const inScope = p => p._a2 === c.a2 && (c.level !== "region" || p._rkey === c.region);

    root.append("g").selectAll("path").data(geo.world.filter(x => geo.idToA2[x.id] !== c.a2)).join("path").attr("class", "bg").attr("d", path);
    const visitedR = new Set(c.places.filter(p => p._a2 === c.a2).map(p => p._rkey));
    for (const [enclave, host] of Object.entries(REGION_ALIAS)) if (visitedR.has(host)) visitedR.add(enclave);
    root.append("g").selectAll("path").data(regs.length ? regs : countryF ? [countryF] : []).join("path")
      .attr("class", d => {
        const k = d.properties && d.properties._key; let cl = "region";
        if (c.level === "region") cl += k === c.region ? " current" : " dim"; else if (visitedR.has(k)) cl += " visited";
        return cl;
      })
      .attr("d", path)
      .on("mousemove", (e, d) => { const k = d.properties?._key; if (!k) return; const n = c.places.filter(p => p._rkey === k).length; showTip(e, d.properties._name + (n ? ` · ${n} lugares` : "")); })
      .on("mouseleave", hideTip)
      .on("click", (e, d) => { const k = REGION_ALIAS[d.properties?._key] || d.properties?._key; if (k && visitedR.has(k) && c.region !== k) { hideTip(); onRegion(k); } });
    if (c.level === "country") {
      for (const f of regs) {
        if (!visitedR.has(f.properties._key)) continue;
        const p = proj(d3.geoCentroid(f));
        if (p) root.append("text").attr("class", "rlabel").attr("x", p[0]).attr("y", p[1]).attr("text-anchor", "middle").text(f.properties._name);
      }
    }

    // Los ríos no se dibujan en el mapa (ensucian la vista); siguen en las listas y métricas.

    // pines
    const pts = c.places.filter(p => inScope(p) && p._hasXY && norm(p.tipo) !== "rio" && (!c.tipo || norm(p.tipo) === c.tipo));
    for (const d of pts) { const q = proj([d.lng, d.lat]); d._x = q[0]; d._y = q[1]; }
    pts.sort((a, b) => a._y - b._y);
    const pg = root.append("g").selectAll("g").data(pts, d => d.id).join("g").attr("class", "pin")
      .attr("transform", d => `translate(${d._x},${d._y})`)
      .on("mousemove", (e, d) => showTip(e, `${d.nombre} · ${d.tipo || ""}`)).on("mouseleave", hideTip)
      .on("click", (e, d) => { hideTip(); onPlace(d); });
    pg.append("ellipse").attr("class", "shadow").attr("cx", 1.5).attr("cy", 0).attr("rx", 3).attr("ry", 1.2);
    pg.append("rect").attr("class", "needle").attr("x", -0.9).attr("y", -12).attr("width", 1.8).attr("height", 12).attr("rx", 0.9);
    pg.append("circle").attr("class", "head").attr("cx", 0).attr("cy", -15).attr("r", 6).style("fill", d => tcolor(d.tipo));
    pg.append("circle").attr("class", "shine").attr("cx", -2).attr("cy", -17.2).attr("r", 1.8);
    pg.append("title").text(d => d.nombre);
    root.append("g").selectAll("text").data(pts, d => d.id).join("text").attr("class", "plabel").text(d => d.nombre);
    applyK(1);
  }

  return {
    draw,
    zoomBy: f => svg.transition().duration(250).call(zoom.scaleBy, f),
    reset: () => svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity),
  };
}

// Mapa de ruta de un viaje: pasos numerados unidos por una línea punteada, en orden.
export function drawTrip(svgEl, tipEl, steps, onStep) {
  const svg = d3.select(svgEl);
  svg.selectAll("*").remove();
  const pts = steps.filter(s => s._hasXY);
  const FH = isMobile() ? 520 : 460;
  const U = setFrame(svgEl, FH);
  if (!pts.length) return;
  const coords = pts.map(s => [s.lng, s.lat]);
  const fit = pts.length === 1
    ? { type: "Feature", geometry: { type: "Point", coordinates: coords[0] } }
    : { type: "Feature", geometry: { type: "MultiPoint", coordinates: coords } };
  const proj = d3.geoMercator().fitExtent([[60, 60], [W - 60, FH - 60]], fit);
  if (pts.length === 1) proj.scale(Math.min(proj.scale(), 9000)).center(coords[0]).translate([W / 2, FH / 2]);
  const path = d3.geoPath(proj);
  svg.append("g").selectAll("path").data(geo.world).join("path").attr("class", "bg").style("opacity", 0.7).attr("d", path);
  const xy = pts.map(s => proj([s.lng, s.lat]));
  if (xy.length > 1) {
    const dd = d3.line().curve(d3.curveCatmullRom.alpha(0.5))(xy);
    svg.append("path").attr("class", "route-casing").attr("d", dd);
    svg.append("path").attr("class", "route").attr("d", dd);
  }
  const r = 13 * U;
  const g = svg.append("g").selectAll("g").data(pts).join("g").style("cursor", "pointer")
    .on("click", (e, d) => onStep(d))
    .on("mousemove", (e, d) => {
      const box = svgEl.parentElement.getBoundingClientRect();
      tipEl.textContent = d.nombre; tipEl.style.left = e.clientX - box.left + "px"; tipEl.style.top = e.clientY - box.top + "px"; tipEl.hidden = false;
    }).on("mouseleave", () => (tipEl.hidden = true));
  g.append("circle").attr("class", "step").attr("cx", (d, i) => xy[i][0]).attr("cy", (d, i) => xy[i][1]).attr("r", r);
  g.append("text").attr("class", "stepn").attr("x", (d, i) => xy[i][0]).attr("y", (d, i) => xy[i][1]).attr("font-size", 12 * U).text((d, i) => i + 1);
}
