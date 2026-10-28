// Globo 3D (D3 ortográfico en canvas).
// Gestos: en el círculo central (.grab) el dedo gira el globo en cualquier dirección; en el anillo exterior y fuera
// del globo el gesto vertical scrollea la página. Pellizco o ctrl+rueda para zoom; tocar un país visitado o un pin.
// Rendimiento: la esfera la dibuja la GPU con WebGL2 (una textura equirectangular del mundo, generada una sola vez con
// el mapa detallado, se proyecta en un shader ortográfico); sobre ella un canvas 2D transparente dibuja solo pines y
// nombres. Si el teléfono no soporta WebGL2 se usa el dibujo 2D de siempre. Dibujo agrupado en un requestAnimationFrame,
// el brillo vive en un elemento aparte y todo se pausa fuera de pantalla.
import { cssVar, tcolorVar, reducedMotion } from "./util.js?v=19";
import { geo, mainland } from "./geo.js?v=19";
const d3 = window.d3;

export function createGlobe(canvas, { gl: glCanvas, grab, onCountry, onPlace }) {
  const ctx = canvas.getContext("2d");
  const proj = d3.geoOrthographic().clipAngle(90).rotate([-11, -28]).precision(1);
  const path = d3.geoPath(proj, ctx);
  const grat = d3.geoGraticule10();
  const MAXK = 8, MINK = 1; // con menos de 1 el globo quedaba "metido" dentro del círculo de brillo

  let W = 0, base = 1, k = 1, colors = {}, pinColors = {}, dprCap = 3;
  let data = { visited: new Set(), places: [], labels: [], pins: true };
  let dirty = true, moving = false, animating = false, spinning = false, visible = true, raf = 0;
  let lastTick = 0, lastTouch = 0, vx = 0, vy = 0, inertia = false;

  const a2Of = f => geo.idToA2[f.id];

  /* ---------- WebGL2: esfera con textura equirectangular ---------- */
  const TEX_W = 4096, TEX_H = 2048;
  let GL = null, glProg = null, glTex = null, glU = {}, texKey = null, useGL = false;
  const VS = `#version 300 es
in vec2 a; out vec2 uv; void main(){ uv = a; gl_Position = vec4(a, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec3 i0, i1, i2; uniform float scale, invR;
in vec2 uv; out vec4 o;
const float PI = 3.14159265359;
void main(){
  vec2 p = uv / scale; float r = length(p);
  if (r > 1.0) { o = vec4(0.); return; }
  vec3 v = vec3(p, sqrt(1.0 - r * r));
  vec3 w = vec3(dot(i0, v), dot(i1, v), dot(i2, v));
  float lat = asin(clamp(w.y, -1., 1.)), lon = atan(w.x, w.z);
  vec2 t = vec2(lon / (2. * PI) + .5, .5 - lat / PI);
  vec2 t2 = vec2(fract(t.x + .5), t.y);                         // misma posición con la costura corrida 180°
  vec2 dx = dFdx(t), dy = dFdy(t), dx2 = dFdx(t2), dy2 = dFdy(t2);
  bool alt = abs(dx.x) + abs(dy.x) > abs(dx2.x) + abs(dy2.x);   // derivadas sin salto: evita la línea en el antimeridiano
  vec4 c = alt ? textureGrad(tex, t, dx2, dy2) : textureGrad(tex, t, dx, dy);
  float edge = 1.0 - smoothstep(1.0 - 1.5 * invR, 1.0, r);
  o = vec4(c.rgb * edge, edge);
}`;
  function initGL() {
    if (!glCanvas) return false;
    GL = glCanvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    if (!GL) return false;
    const sh = (type, src) => { const s = GL.createShader(type); GL.shaderSource(s, src); GL.compileShader(s); if (!GL.getShaderParameter(s, GL.COMPILE_STATUS)) throw new Error(GL.getShaderInfoLog(s)); return s; };
    try {
      glProg = GL.createProgram();
      GL.attachShader(glProg, sh(GL.VERTEX_SHADER, VS)); GL.attachShader(glProg, sh(GL.FRAGMENT_SHADER, FS)); GL.linkProgram(glProg);
      if (!GL.getProgramParameter(glProg, GL.LINK_STATUS)) throw new Error(GL.getProgramInfoLog(glProg));
    } catch (e) { console.warn("WebGL no disponible, uso el dibujo 2D:", e.message); GL = null; return false; }
    GL.useProgram(glProg);
    for (const n of ["tex", "i0", "i1", "i2", "scale", "invR"]) glU[n] = GL.getUniformLocation(glProg, n);
    const buf = GL.createBuffer(); GL.bindBuffer(GL.ARRAY_BUFFER, buf);
    GL.bufferData(GL.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), GL.STATIC_DRAW);
    const loc = GL.getAttribLocation(glProg, "a"); GL.enableVertexAttribArray(loc); GL.vertexAttribPointer(loc, 2, GL.FLOAT, false, 0, 0);
    glTex = GL.createTexture(); texKey = null;
    return true;
  }
  // Textura del mundo con el mapa detallado: océano, grilla, tierra, países visitados. Se rehace solo si cambian los países visitados.
  function buildTexture() {
    const key = [...data.visited].sort().join(",");
    if (key === texKey || !GL) return;
    texKey = key;
    const tc = document.createElement("canvas"); tc.width = TEX_W; tc.height = TEX_H;
    const t = tc.getContext("2d"), tp = d3.geoEquirectangular().scale(TEX_W / (2 * Math.PI)).translate([TEX_W / 2, TEX_H / 2]), tpath = d3.geoPath(tp, t);
    t.fillStyle = colors.ocean; t.fillRect(0, 0, TEX_W, TEX_H);
    t.beginPath(); tpath(grat); t.strokeStyle = colors.line; t.globalAlpha = 0.35; t.lineWidth = 1; t.stroke(); t.globalAlpha = 1;
    t.beginPath(); for (const f of geo.world) if (!data.visited.has(a2Of(f))) tpath(f);
    t.fillStyle = colors.land; t.fill(); t.strokeStyle = colors.landLine; t.lineWidth = 1.5; t.stroke();
    t.beginPath(); for (const f of geo.world) if (data.visited.has(a2Of(f))) tpath(f);
    t.fillStyle = colors.visited; t.fill(); t.strokeStyle = "rgba(255,255,255,.4)"; t.lineWidth = 2; t.stroke();
    GL.bindTexture(GL.TEXTURE_2D, glTex);
    GL.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
    GL.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA, GL.RGBA, GL.UNSIGNED_BYTE, tc);
    GL.generateMipmap(GL.TEXTURE_2D);
    GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
    GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.REPEAT);
    GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
    const an = GL.getExtension("EXT_texture_filter_anisotropic");
    if (an) GL.texParameterf(GL.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, GL.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }
  // Imágenes de los ejes del mundo bajo la rotación de d3: así el shader coincide exactamente con los pines y nombres (proj de d3).
  function rotationImages() {
    const rot = d3.geoRotation(proj.rotate()), R = 180 / Math.PI;
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(e => {
      const [l, p] = rot([Math.atan2(e[0], e[2]) * R, Math.asin(e[1]) * R]), L = l / R, P = p / R;
      return [Math.cos(P) * Math.sin(L), Math.sin(P), Math.cos(P) * Math.cos(L)];
    });
  }
  function glDraw() {
    buildTexture();
    GL.viewport(0, 0, glCanvas.width, glCanvas.height);
    GL.clearColor(0, 0, 0, 0); GL.clear(GL.COLOR_BUFFER_BIT);
    const im = rotationImages();
    GL.activeTexture(GL.TEXTURE0); GL.bindTexture(GL.TEXTURE_2D, glTex);
    GL.uniform1i(glU.tex, 0);
    GL.uniform3fv(glU.i0, im[0]); GL.uniform3fv(glU.i1, im[1]); GL.uniform3fv(glU.i2, im[2]);
    GL.uniform1f(glU.scale, 0.985 * k); GL.uniform1f(glU.invR, 1 / Math.max(1, base * k * (glCanvas.width / W)));
    GL.drawArrays(GL.TRIANGLE_STRIP, 0, 4);
  }

  // centro y radio angular de cada país: si está entero detrás del horizonte ni se dibuja (casi la mitad del trabajo)
  const bounds = new Map();
  function boundsOf(f) {
    let b = bounds.get(f);
    if (!b) {
      const c = d3.geoCentroid(f); let r = 0;
      (function walk(a) { if (typeof a[0] === "number") r = Math.max(r, d3.geoDistance(c, a)); else for (const x of a) walk(x); })(f.geometry.coordinates);
      bounds.set(f, b = { c, r });
    }
    return b;
  }
  // fuera de vista: detrás del horizonte o, con zoom, fuera del casquete visible (a 3x solo entran unos pocos países)
  const behind = (f, center) => {
    const b = boundsOf(f), lim = k > 1.4 ? Math.asin(Math.min(1, 1.45 / (0.985 * k))) : Math.PI / 2;
    return d3.geoDistance(b.c, center) - b.r > lim + 0.03;
  };

  function readColors() {
    colors = { ocean: cssVar("--g-ocean"), land: cssVar("--g-land"), landLine: cssVar("--g-land-line"), visited: cssVar("--g-visited"), line: cssVar("--g-line"), label: cssVar("--g-label") };
    pinColors = {};
  }
  const pinColor = tipo => pinColors[tipo] || (pinColors[tipo] = cssVar(tcolorVar(tipo)));

  function resize() {
    W = canvas.getBoundingClientRect().width;
    if (!W) return;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap); // en el iPhone (3x) con tope 2 el globo se veía levemente borroso
    canvas.width = canvas.height = Math.round(W * dpr);
    if (glCanvas) glCanvas.width = glCanvas.height = canvas.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    base = (W / 2) * 0.985;
    proj.translate([W / 2, W / 2]).scale(base * k);
    dirty = true;
  }

  function draw() {
    dirty = false;
    if (!W) return;
    ctx.clearRect(0, 0, W, W);
    const center0 = proj.invert([W / 2, W / 2]);
    // GPU hasta 4.2x; con más zoom la textura se pixelaría, así que se vuelve al dibujo vectorial (nítido a cualquier escala),
    // que se hace a 2x de resolución (menos píxeles = más fluido)
    const onGPU = useGL && k < 4.2;
    const want = onGPU ? 3 : 2;
    if (want !== dprCap) { dprCap = want; resize(); }
    if (glCanvas && glCanvas.hidden === onGPU) glCanvas.hidden = !onGPU;
    if (onGPU) glDraw();
    else {
      ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = colors.ocean; ctx.fill();
      const world = k < 2.5 && geo.worldLite.length ? geo.worldLite : geo.world; // con mucho zoom se usa el mapa detallado
      ctx.beginPath();
      for (const f of world) if (!data.visited.has(a2Of(f)) && !behind(f, center0)) path(f);
      ctx.fillStyle = colors.land; ctx.fill(); ctx.strokeStyle = colors.landLine; ctx.lineWidth = 0.5; ctx.stroke();
      ctx.beginPath();
      for (const f of world) if (data.visited.has(a2Of(f)) && !behind(f, center0)) path(f);
      ctx.fillStyle = colors.visited; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 0.7; ctx.stroke();
    }
    const center = center0;
    drawLabels(center);
    if (data.pins) {
      for (const p of data.places) {
        if (!p._hasXY || d3.geoDistance([p.lng, p.lat], center) > Math.PI / 2 - 0.02) continue;
        const [x, y] = proj([p.lng, p.lat]);
        ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = pinColor(p.tipo); ctx.fill();
        ctx.lineWidth = 1.3; ctx.strokeStyle = "#fff"; ctx.stroke();
      }
    }
  }

  // Nombres de países visitados: del más grande al más chico; si se pisan con uno ya puesto, se omiten
  // (por eso Uruguay aparece recién al hacer zoom, cuando se separa de Argentina).
  function drawLabels(center) {
    const fs = Math.max(11, Math.min(15, 10.5 + k * 1.6)), R = base * k, placed = [];
    ctx.font = `600 ${fs}px "Bricolage Grotesque",system-ui,sans-serif`;
    ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineWidth = 3.5;
    for (const l of data.labels) {
      const dist = d3.geoDistance(l.c, center);
      if (dist > 1.3) continue;
      const [px, py] = proj(l.c), tw = ctx.measureText(l.name).width, w = Math.sqrt(l.area) * R;
      const inside = tw < w * 1.05;
      const x = inside ? px : px + Math.max(w / 2, 5) + 5;
      const r = { x0: inside ? x - tw / 2 : x, x1: inside ? x + tw / 2 : x + tw, y0: py - fs / 2 - 2, y1: py + fs / 2 + 2 };
      if (r.x1 > W - 2 || r.x0 < 2 || placed.some(o => r.x0 < o.x1 && r.x1 > o.x0 && r.y0 < o.y1 && r.y1 > o.y0)) continue;
      placed.push(r);
      ctx.globalAlpha = Math.max(0, Math.min(1, (1.3 - dist) / 0.3));
      ctx.textAlign = inside ? "center" : "left";
      ctx.strokeStyle = "rgba(5,16,26,.9)"; ctx.strokeText(l.name, x, py);
      ctx.fillStyle = colors.label; ctx.fillText(l.name, x, py);
    }
    ctx.globalAlpha = 1;
  }

  /* ---- hit testing (x, y en píxeles CSS relativos al canvas) ---- */
  function pickPlace(x, y) {
    if (!data.pins) return null;
    const center = proj.invert([W / 2, W / 2]);
    let best = null, bd = 14;
    for (const p of data.places) {
      if (!p._hasXY || d3.geoDistance([p.lng, p.lat], center) > Math.PI / 2 - 0.02) continue;
      const [px, py] = proj([p.lng, p.lat]);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function pickCountry(x, y) {
    const ll = proj.invert([x, y]);
    if (!ll || !isFinite(ll[0]) || d3.geoDistance(ll, proj.invert([W / 2, W / 2])) > Math.PI / 2) return null;
    const f = geo.world.find(f => data.visited.has(a2Of(f)) && d3.geoContains(f, ll));
    return f ? a2Of(f) : null;
  }
  function tap(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
    const place = pickPlace(x, y);
    if (place) return onPlace(place);
    const a2 = pickCountry(x, y);
    if (a2) goToCountry(a2);
  }

  /* ---- animación hacia un país (toque directo sobre el globo) ---- */
  function rotateTo(lon, lat, targetK) {
    return new Promise(res => {
      animating = true; inertia = false;
      const r0 = proj.rotate(), t = [-lon, -lat], k0 = k, dur = reducedMotion() ? 0 : 1100, t0 = performance.now();
      while (t[0] - r0[0] > 180) t[0] -= 360;
      while (t[0] - r0[0] < -180) t[0] += 360;
      const ir = d3.interpolate(r0, t);
      (function step(now) {
        const u = dur ? Math.min(1, (now - t0) / dur) : 1, e = d3.easeCubicInOut(u);
        proj.rotate(ir(e)); k = k0 + (targetK - k0) * e; proj.scale(base * k); dirty = true;
        if (u < 1) requestAnimationFrame(step); else { animating = false; res(); }
      })(t0);
    });
  }
  async function goToCountry(a2) {
    const f = geo.world.find(f => a2Of(f) === a2);
    if (!f) return onCountry(a2);
    const [lon, lat] = d3.geoCentroid(mainland(f));
    await rotateTo(lon, lat, 2.4);
    onCountry(a2);
  }

  /* ---- gestos (sobre la zona de agarre) ---- */
  const pts = new Map();
  let g = null, pinch = null;
  const rotateBy = (dx, dy) => {
    const s = 57.3 / (base * k), r = proj.rotate();
    proj.rotate([r[0] + dx * s, Math.max(-90, Math.min(90, r[1] - dy * s))]);
    dirty = true;
  };
  const setK = nk => { k = Math.max(MINK, Math.min(MAXK, nk)); proj.scale(base * k); dirty = true; };

  grab.addEventListener("pointerdown", e => {
    if (animating) return;
    try { grab.setPointerCapture(e.pointerId); } catch { /* el puntero ya terminó */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moving = true; inertia = false; lastTouch = performance.now();
    if (pts.size === 1) g = { sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false, lx: e.clientX, ly: e.clientY, vx: 0, vy: 0 };
    else if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k0: k }; if (g) g.moved = true; }
  });
  grab.addEventListener("pointermove", e => {
    const p = pts.get(e.pointerId);
    if (!p) { const r = canvas.getBoundingClientRect(); grab.style.cursor = pickPlace(e.clientX - r.left, e.clientY - r.top) ? "pointer" : ""; return; }
    p.x = e.clientX; p.y = e.clientY; lastTouch = performance.now();
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      setK(pinch.k0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
    } else if (g) {
      const dx = e.clientX - g.lx, dy = e.clientY - g.ly;
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 5) g.moved = true;
      if (g.moved) { rotateBy(dx, dy); g.vx = dx; g.vy = dy; }
      g.lx = e.clientX; g.ly = e.clientY;
    }
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size > 0) return;
    moving = false; lastTouch = performance.now();
    if (g && !g.moved && e.type === "pointerup" && performance.now() - g.t < 500) tap(e.clientX, e.clientY);
    else if (g && g.moved && e.type === "pointerup" && (Math.abs(g.vx) > 2 || Math.abs(g.vy) > 2)) { vx = g.vx; vy = g.vy; inertia = true; }
    g = null; dirty = true;
  };
  grab.addEventListener("pointerup", end);
  grab.addEventListener("pointercancel", end);
  // toques en el anillo exterior (fuera de la zona de agarre): seleccionar sin girar
  canvas.addEventListener("click", e => { if (!animating) tap(e.clientX, e.clientY); });
  const wheel = e => {
    if (!(e.ctrlKey || e.metaKey)) return; // la rueda normal scrollea la página
    e.preventDefault(); lastTouch = performance.now();
    setK(k * Math.exp(-e.deltaY * 0.01));
  };
  grab.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("wheel", wheel, { passive: false });

  /* ---- bucle ---- */
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(64, now - lastTick); lastTick = now;
    if (!visible || document.hidden) return;
    if (inertia) { rotateBy(vx, vy); vx *= 0.93; vy *= 0.93; if (Math.abs(vx) < 0.15 && Math.abs(vy) < 0.15) { inertia = false; dirty = true; } }
    else if (spinning && !moving && !animating && !reducedMotion() && now - lastTouch > 3500) {
      const r = proj.rotate(); proj.rotate([r[0] + dt * 0.006, r[1]]); dirty = true;
    }
    if (dirty) draw();
  }

  readColors();
  useGL = initGL();
  if (glCanvas) {
    glCanvas.hidden = !useGL;
    glCanvas.addEventListener("webglcontextlost", e => { e.preventDefault(); useGL = false; glCanvas.hidden = true; dirty = true; });
    glCanvas.addEventListener("webglcontextrestored", () => { useGL = initGL(); glCanvas.hidden = !useGL; dirty = true; });
  }
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) dirty = true; }).observe(canvas);

  return {
    setData(places, visitedA2, { pins = true } = {}) {
      const visited = new Set(visitedA2);
      const labels = [];
      for (const a2 of visited) {
        const f = geo.world.find(x => a2Of(x) === a2); if (!f) continue;
        const m = mainland(f);
        labels.push({ a2, name: geo.countryName[a2] || a2, c: d3.geoCentroid(m), area: d3.geoArea(m) });
      }
      labels.sort((a, b) => b.area - a.area);
      data = { places, visited, labels, pins };
      dirty = true;
    },
    start() { spinning = true; lastTick = performance.now(); if (!raf) raf = requestAnimationFrame(tick); resize(); },
    stop() { spinning = false; cancelAnimationFrame(raf); raf = 0; },
    resize,
    goToCountry,
    zoomBy(f) { setK(k * f); },
    // Deja el globo mirando a los lugares visitados (al abrir o volver desde un mapa).
    focusVisited() {
      const pts2 = data.places.filter(p => p._hasXY).map(p => [p.lng, p.lat]);
      if (!pts2.length) return;
      const c = d3.geoCentroid({ type: "MultiPoint", coordinates: pts2 });
      proj.rotate([-c[0], -c[1] * 0.6]); k = 1; proj.scale(base); inertia = false; dirty = true;
    },
  };
}


// Mini globo decorativo y giratorio (pantalla Stats). Devuelve una función para detenerlo.
export function startMiniGlobe(canvas, visitedA2, places) {
  const ctx = canvas.getContext("2d"), visited = new Set(visitedA2);
  const proj = d3.geoOrthographic().clipAngle(90).precision(1);
  const path = d3.geoPath(proj, ctx);
  const c = ["--g-ocean", "--g-land", "--g-land-line", "--g-visited", "--g-line"].map(cssVar);
  let W = 0, lon = 0, raf = 0, last = performance.now(), visible = true;
  const pts = places.filter(p => p._hasXY).map(p => [p.lng, p.lat]);
  const home = pts.length ? d3.geoCentroid({ type: "MultiPoint", coordinates: pts }) : [0, 20];
  lon = -home[0];
  const resize = () => {
    W = canvas.getBoundingClientRect().width; if (!W) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = canvas.height = Math.round(W * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    proj.translate([W / 2, W / 2]).scale(W / 2 - 1);
  };
  const draw = () => {
    proj.rotate([lon, -Math.max(-35, Math.min(45, home[1] * 0.7))]);
    ctx.clearRect(0, 0, W, W);
    ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = c[0]; ctx.fill();
    ctx.beginPath(); for (const f of geo.worldLite) if (!visited.has(geo.idToA2[f.id])) path(f);
    ctx.fillStyle = c[1]; ctx.fill(); ctx.strokeStyle = c[2]; ctx.lineWidth = 0.4; ctx.stroke();
    ctx.beginPath(); for (const f of geo.worldLite) if (visited.has(geo.idToA2[f.id])) path(f);
    ctx.fillStyle = c[3]; ctx.fill();
  };
  const tick = now => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(64, now - last); last = now;
    if (!visible || document.hidden) return;
    if (!reducedMotion()) lon += dt * 0.012; // ~12°/s
    draw();
  };
  resize(); draw();
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }); io.observe(canvas);
  if (!reducedMotion()) raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); io.disconnect(); };
}
