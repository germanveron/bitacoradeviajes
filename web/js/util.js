export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const norm = s => (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export const esc = s => (s ?? "").toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const TIPOS = ["Ciudad", "Pueblo", "Río", "Lago", "Montaña", "Parque", "Playa", "Museo", "Castillo", "Restaurante", "Otro"];

const PLURAL = { ciudad: "Ciudades", pueblo: "Pueblos", rio: "Ríos", lago: "Lagos", montana: "Montañas", parque: "Parques", playa: "Playas", museo: "Museos", castillo: "Castillos", restaurante: "Restaurantes", otro: "Otros" };
export function plural(tipo) {
  const p = PLURAL[norm(tipo)];
  if (p) return p;
  const t = (tipo || "Otro").trim();
  return /[aeiou]$/i.test(t) ? t + "s" : t + "es";
}

const TCOLOR = { ciudad: "--t-ciudad", pueblo: "--t-ciudad", rio: "--t-rio", lago: "--t-lago", playa: "--t-lago", montana: "--t-montana", parque: "--t-montana" };
export const tcolorVar = t => TCOLOR[norm(t)] || "--t-otro";
export const tcolor = t => `var(${tcolorVar(t)})`;
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const initial = name => ((name || "?").trim().charAt(0) || "?").toUpperCase();

export function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  return m ? `${+m[3]} ${MESES[+m[2] - 1].slice(0, 3)} ${m[1]}` : esc(s);
}
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

let toastTimer;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const isMobile = () => matchMedia("(max-width:640px)").matches;
export const pref = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
};
