// Recorte de la foto de perfil: arrastrar para encuadrar, pellizcar (o deslizar) para hacer zoom.
// Devuelve un JPEG cuadrado de 480 px, o null si se cancela.
const OUT = 480, MIN_SIDE = 120;

export async function cropAvatar(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const base = Math.min(bmp.width, bmp.height);
  const zmax = Math.max(1, Math.min(8, base / MIN_SIDE));
  let z = 1, cx = bmp.width / 2, cy = bmp.height / 2;

  const root = document.createElement("div");
  root.className = "cropper";
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Ajustar foto de perfil");
  root.innerHTML = `<h2>Ajustá tu foto</h2>
    <div class="crop-view"><canvas></canvas><div class="crop-mask"></div></div>
    <p class="help">Arrastrá para mover · pellizcá para hacer zoom</p>
    <input type="range" min="1" max="${zmax}" step="0.01" value="1" aria-label="Zoom">
    <div class="row"><button class="btn" type="button" data-act="cancel">Cancelar</button><button class="btn primary" type="button" data-act="ok">Usar foto</button></div>`;
  document.body.appendChild(root);
  const view = root.querySelector(".crop-view"), cv = root.querySelector("canvas"), slider = root.querySelector("input");
  const V = Math.round(view.getBoundingClientRect().width), dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = cv.height = V * dpr;
  const ctx = cv.getContext("2d");

  const side = () => base / z;
  const clamp = () => {
    const h = side() / 2;
    cx = Math.min(bmp.width - h, Math.max(h, cx)); cy = Math.min(bmp.height - h, Math.max(h, cy));
  };
  const draw = () => {
    clamp();
    const s = side();
    ctx.drawImage(bmp, cx - s / 2, cy - s / 2, s, s, 0, 0, cv.width, cv.height);
    slider.value = z;
  };
  const setZoom = nz => { z = Math.min(zmax, Math.max(1, nz)); draw(); };
  draw();

  // Gestos: un dedo mueve, dos dedos hacen zoom (y también mueven).
  const ptr = new Map();
  let lastDist = 0;
  const dist = () => { const [a, b] = [...ptr.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  view.addEventListener("pointerdown", e => {
    try { view.setPointerCapture(e.pointerId); } catch { /* puntero sintético */ }
    ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptr.size === 2) lastDist = dist();
  });
  view.addEventListener("pointermove", e => {
    const p = ptr.get(e.pointerId); if (!p) return;
    const k = side() / V; // píxeles de la foto por píxel de pantalla
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptr.size === 1) { cx -= dx * k; cy -= dy * k; draw(); }
    else if (ptr.size === 2) {
      const d = dist(); if (lastDist) setZoom(z * d / lastDist); lastDist = d;
    }
  });
  const up = e => { ptr.delete(e.pointerId); lastDist = 0; };
  view.addEventListener("pointerup", up); view.addEventListener("pointercancel", up);
  view.addEventListener("wheel", e => { e.preventDefault(); setZoom(z * Math.exp(-e.deltaY * 0.002)); }, { passive: false });
  slider.addEventListener("input", () => setZoom(+slider.value));

  return await new Promise(resolve => {
    const close = v => { root.remove(); bmp.close?.(); resolve(v); };
    root.querySelector('[data-act="cancel"]').onclick = () => close(null);
    root.querySelector('[data-act="ok"]').onclick = () => {
      const out = document.createElement("canvas"); out.width = out.height = OUT;
      const s = side();
      out.getContext("2d").drawImage(bmp, cx - s / 2, cy - s / 2, s, s, 0, 0, OUT, OUT);
      out.toBlob(b => close(b), "image/jpeg", 0.88);
    };
  });
}
