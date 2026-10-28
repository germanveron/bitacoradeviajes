// Pantallas de ingreso: iniciar sesión, crear cuenta, olvidé mi contraseña y elegir una nueva.
import { $, esc } from "./util.js?v=19";
import { api } from "./api.js?v=19";

const pwdField = (id, label, autocomplete) => `<div class="field"><label class="label" for="${id}">${label}</label>
  <div class="pwd"><input id="${id}" type="password" autocomplete="${autocomplete}" required minlength="8"><button type="button" data-show="${id}">Ver</button></div></div>`;

function frame(inner, subtitle) {
  return `<div class="auth-top"><img src="icon.svg" alt="" width="64" height="64"><h1>Bitácora de viajes</h1><p>${subtitle}</p></div>
    <div class="auth-card">${inner}</div>`;
}

export function showAuth({ mode = "login", resetToken = null, invited = false, notice = "", onDone }) {
  const root = $("#auth");
  root.hidden = false;
  const views = {
    login: () => frame(`<h2>Iniciá sesión</h2>
      ${invited ? `<p class="help" style="margin:0">Te invitaron a un perfil compartido. Entrá con el email al que llegó la invitación, o creá tu cuenta con ese mismo email.</p>` : ""}
      ${notice ? `<div class="msg ok">${esc(notice)}</div>` : ""}
      <form id="f" novalidate>
        <div class="field"><label class="label" for="email">Email</label><input id="email" type="email" autocomplete="email" inputmode="email" required></div>
        ${pwdField("pw", "Contraseña", "current-password")}
        <div class="msg err" id="msg" role="alert"></div>
        <button class="btn primary wide" type="submit">Entrar</button>
      </form>
      <div class="auth-links"><button class="linkbtn" data-go="forgot">Olvidé mi contraseña</button><button class="linkbtn" data-go="signup">Crear cuenta</button></div>`, "Tus viajes, en un solo lugar"),
    signup: () => frame(`<button class="linkbtn" data-go="login" style="align-self:flex-start">‹ Volver</button><h2>Creá tu cuenta</h2>
      ${invited ? `<p class="help" style="margin:0">Usá el mismo email al que llegó la invitación.</p>` : ""}
      <form id="f" novalidate>
        <div class="field"><label class="label" for="name">Tu nombre</label><input id="name" autocomplete="given-name" maxlength="60" required></div>
        <div class="field"><label class="label" for="email">Email</label><input id="email" type="email" autocomplete="email" inputmode="email" required></div>
        ${pwdField("pw", "Contraseña (mínimo 8 caracteres)", "new-password")}
        <div class="msg err" id="msg" role="alert"></div>
        <button class="btn primary wide" type="submit">Crear cuenta</button>
      </form>
      <div class="auth-links" style="justify-content:center"><button class="linkbtn" data-go="login">¿Ya tenés cuenta? Iniciar sesión</button></div>`, "Tus viajes, en un solo lugar"),
    forgot: () => frame(`<button class="linkbtn" data-go="login" style="align-self:flex-start">‹ Volver</button><h2>Restablecer contraseña</h2>
      <p class="help" style="margin:0">Ingresá tu email y te mandamos un link para elegir una contraseña nueva.</p>
      <form id="f" novalidate>
        <div class="field"><label class="label" for="email">Email</label><input id="email" type="email" autocomplete="email" inputmode="email" required></div>
        <div class="msg" id="msg" role="status"></div>
        <button class="btn primary wide" type="submit">Enviar link</button>
      </form>
      <div class="auth-links"><button class="linkbtn" data-go="login">Volver a iniciar sesión</button></div>`, "Recuperá el acceso"),
    reset: () => frame(`<h2>Elegí una contraseña nueva</h2>
      <form id="f" novalidate>
        ${pwdField("pw", "Contraseña nueva (mínimo 8 caracteres)", "new-password")}
        <div class="msg err" id="msg" role="alert"></div>
        <button class="btn primary wide" type="submit">Guardar contraseña</button>
      </form>`, "Recuperá el acceso"),
  };
  root.innerHTML = views[mode]();
  const msg = $("#msg", root), form = $("#f", root);
  const say = (t, ok = false) => { msg.textContent = t; msg.className = "msg " + (ok ? "ok" : "err"); };
  root.onclick = e => {
    const go = e.target.closest("[data-go]");
    if (go) return showAuth({ mode: go.dataset.go, invited, onDone });
    const sh = e.target.closest("[data-show]");
    if (sh) { const i = $("#" + sh.dataset.show, root); i.type = i.type === "password" ? "text" : "password"; sh.textContent = i.type === "password" ? "Ver" : "Ocultar"; }
  };
  $("input", form)?.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = $("button[type=submit]", form); btn.disabled = true; say("");
    const v = id => $("#" + id, root)?.value.trim() ?? "";
    try {
      if (mode === "login") { await api.login({ email: v("email"), password: $("#pw", root).value }); root.hidden = true; onDone(); }
      else if (mode === "signup") { await api.signup({ name: v("name"), email: v("email"), password: $("#pw", root).value }); root.hidden = true; onDone(); }
      else if (mode === "forgot") { await api.forgot(v("email")); say("Si el email tiene cuenta, te enviamos un link. Revisá tu bandeja (y el spam).", true); }
      else if (mode === "reset") {
        await api.reset(resetToken, $("#pw", root).value);
        history.replaceState(null, "", location.pathname);
        showAuth({ mode: "login", invited, notice: "Listo: ya podés entrar con tu contraseña nueva.", onDone });
        return;
      }
    } catch (err) { say(err.message); }
    btn.disabled = false;
  };
}
