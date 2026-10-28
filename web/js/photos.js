// Fotos: compresión en el cliente y subida con progreso.
import { api } from "./api.js?v=18";
import { toast } from "./util.js?v=18";

// Reduce a 2000 px y JPEG 85 %: fotos de celular de 6 MB bajan a ~400 KB.
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
  blob.name = file.name.replace(/\.\w+$/, "") + ".jpg";
  return blob;
}

// Sube de a una foto para mostrar progreso real. Devuelve el item actualizado (o null).
export async function uploadPhotos(kind, id, files, onProgress = () => {}) {
  const list = [...files].filter(f => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!list.length) { toast("No hay imágenes para subir."); return null; }
  let item = null, ok = 0, fail = 0;
  for (const [n, file] of list.entries()) {
    onProgress(n, list.length);
    try {
      let blob;
      try { blob = await shrink(file); } catch (e) {
        if (/heic|heif/i.test(file.type + file.name)) throw new Error("HEIC no soportado: exportala como JPG");
        blob = file; // el servidor valida que sea imagen
      }
      item = await api.upload(kind, id, [blob]);
      ok++;
    } catch (e) { fail++; console.warn(e); if (fail === 1) toast(e.message); }
  }
  onProgress(list.length, list.length);
  if (ok) toast(`${ok} ${ok === 1 ? "foto subida" : "fotos subidas"}${fail ? `, ${fail} con error` : ""}`);
  return item;
}
