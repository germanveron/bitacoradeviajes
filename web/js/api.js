// Cliente de la API. La sesión viaja en una cookie HttpOnly; los datos son por perfil.
let profileId = null;
export const setProfile = id => { profileId = id; };

async function req(method, url, body, form) {
  const headers = {};
  if (body && !form) headers["content-type"] = "application/json";
  const r = await fetch(url, { method, headers, credentials: "same-origin", body: form ? body : body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && !url.startsWith("/api/auth/")) {
    await r.text().catch(() => "");
    window.dispatchEvent(new CustomEvent("unauth"));
    throw new Error("Tu sesión terminó. Iniciá sesión de nuevo.");
  }
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? "Revisá los datos ingresados" : msg;
    } catch { /* sin cuerpo */ }
    throw new Error(msg);
  }
  return r.json();
}

const P = () => `/api/p/${profileId}`;
export const api = {
  // cuenta
  me: () => req("GET", "/api/me"),
  signup: d => req("POST", "/api/auth/signup", d),
  login: d => req("POST", "/api/auth/login", d),
  logout: () => req("POST", "/api/auth/logout"),
  forgot: email => req("POST", "/api/auth/forgot", { email }),
  reset: (token, password) => req("POST", "/api/auth/reset", { token, password }),
  rename: name => req("PATCH", "/api/me", { name }),
  changePassword: (current, next) => req("POST", "/api/me/password", { current, new: next }),
  avatar(blob) { const fd = new FormData(); fd.append("file", blob, "avatar.jpg"); return req("POST", "/api/me/avatar", fd, true); },
  // buscador de lugares (Google Places, vía el servidor)
  placeSuggest: (q, session, tipo) => req("GET", `/api/places/autocomplete?q=${encodeURIComponent(q)}&session=${session}&tipo=${encodeURIComponent(tipo || "")}`),
  placeDetails: (id, session) => req("GET", `/api/places/details?id=${encodeURIComponent(id)}&session=${session}`),
  placeResolve: (q, tipo) => req("GET", `/api/places/resolve?q=${encodeURIComponent(q)}&tipo=${encodeURIComponent(tipo || "")}`),
  // perfiles
  newProfile: name => req("POST", "/api/profiles", { name }),
  renameProfile: (id, name) => req("PATCH", `/api/profiles/${id}`, { name }),
  deleteProfile: id => req("DELETE", `/api/profiles/${id}`),
  members: id => req("GET", `/api/profiles/${id}/members`),
  invite: (id, email) => req("POST", `/api/profiles/${id}/invites`, { email }),
  cancelInvite: id => req("DELETE", `/api/invites/${id}`),
  removeMember: (pid, uid) => req("DELETE", `/api/profiles/${pid}/members/${uid}`),
  acceptInvite: token => req("POST", "/api/invites/accept", { token }),
  // lugares y eventos del perfil activo
  list: kind => req("GET", `${P()}/${kind}`),
  add: (kind, data) => req("POST", `${P()}/${kind}`, data),
  update: (kind, id, data) => req("PATCH", `${P()}/${kind}/${id}`, data),
  remove: (kind, id) => req("DELETE", `${P()}/${kind}/${id}`),
  upload(kind, id, blobs) {
    const fd = new FormData();
    blobs.forEach((b, i) => fd.append("files", b, b.name || `foto-${i}.jpg`));
    return req("POST", `${P()}/${kind}/${id}/fotos`, fd, true);
  },
  removePhoto: (kind, id, pid) => req("DELETE", `${P()}/${kind}/${id}/fotos/${pid}`),
};
export const photoUrl = id => `/api/photo/${id}`;
