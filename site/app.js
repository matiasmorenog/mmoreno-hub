'use strict';
// mmoreno-hub: una sola llamada GET al cargar; tildes en lote con debounce; tracker a demanda y cacheado.
const $ = (s) => document.querySelector(s);
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const DEBOUNCE_MS = 2500;
const RECENT_MS = 5 * 60 * 1000; // superpone tildes confirmadas sobre un GET cacheado
let brief = null, timer = null, tracker = null, meds = null, medTimer = null, shopping = null, shopTimer = null;
let gastos = null, gastosPreview = null, gastosFileB64 = null, gastosFileName = null, gastosSettlementB64 = null, gastosSub = 'movimientos';
/** Selected account ids for Movimientos filter. null = all (default). */
let gastosAcctSelected = null;
let gastosMovSearchTimer = null;
/** Expanded Reglas category-group keys (persist across re-render). */
const gastosRuleGroupsOpen = new Set();
/** Last loaded movimientos rows (client sort). */
let gastosMovRows = [];
let gastosMovSort = { key: 'fecha', dir: 'desc' };

function formatGastosHora(t) {
  if (t == null) return '—';
  if (typeof t.hora_local === 'number' && t.hora_local >= 0 && t.hora_local <= 23) {
    const hh = String(t.hora_local).padStart(2, '0');
    if (t.posted_at) {
      try {
        const d = new Date(t.posted_at);
        if (!Number.isNaN(d.getTime())) {
          const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          }).formatToParts(d);
          const h = parts.find((p) => p.type === 'hour')?.value;
          const m = parts.find((p) => p.type === 'minute')?.value;
          if (h != null && m != null) return `${h}:${m}`;
        }
      } catch { /* fall through */ }
    }
    return `${hh}:00`;
  }
  if (t.posted_at) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Argentina/Buenos_Aires',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(t.posted_at));
    } catch { /* ignore */ }
  }
  return '—';
}
function currentMonthAR() {
  // YYYY-MM in America/Argentina/Buenos_Aires
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}`;
}
function ensureGastosMonthDefaults() {
  const cur = currentMonthAR();
  if ($('#gFiltroMes') && !$('#gFiltroMes').value) $('#gFiltroMes').value = cur;
  if ($('#gResMes') && !$('#gResMes').value) $('#gResMes').value = cur;
}
const MOMENTO_LABEL = { manana: 'Mañana', mediodia: 'Mediodía', noche: 'Noche' };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== '') n.append(k.nodeType ? k : String(k));
  return n;
}
function svgIcon(paths, viewBox = '0 0 24 24') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
const ICONS = {
  // power — activar
  power: 'M13 3a1 1 0 1 0-2 0v8a1 1 0 1 0 2 0V3zm4.66 2.34a1 1 0 0 0-1.41 1.41 6 6 0 1 1-8.5 0 1 1 0 1 0-1.41-1.41 8 8 0 1 0 11.32 0z',
  // pause — desactivar
  pause: 'M8 5a1 1 0 0 0-1 1v12a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1zm8 0a1 1 0 0 0-1 1v12a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1z',
  trash: 'M9 3a1 1 0 0 0-.894.553L7.382 5H5a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2h-2.382l-.724-1.447A1 1 0 0 0 15 3H9zm-3 6a1 1 0 0 1 1 1v8a1 1 0 1 0 2 0v-8a1 1 0 1 1-2 0zm5 0a1 1 0 0 1 1 1v8a1 1 0 1 0 2 0v-8a1 1 0 1 1-2 0zm5 1a1 1 0 1 0-2 0v8a1 1 0 1 0 2 0v-8z',
  // pencil — editar
  edit: 'M4 17.25V20h2.75l8.13-8.13-2.75-2.75L4 17.25zm14.71-9.04a1 1 0 0 0 0-1.41l-2.51-2.51a1 1 0 0 0-1.41 0l-1.83 1.83 3.92 3.92 1.83-1.83z',
};
function iconBtn({ label, onclick, danger, icon }) {
  return el('button', {
    type: 'button',
    class: 'icon-btn' + (danger ? ' danger' : ''),
    'aria-label': label,
    title: label,
    onclick,
  }, svgIcon(ICONS[icon]));
}
function tabLink(label, url, tab) {
  return el('a', { href: url, target: tab || '_blank', onclick: (e) => {
    const w = window.open(url, tab || '_blank');
    if (w) { e.preventDefault(); try { w.focus(); } catch {} }
  } }, label);
}
function setSync(t) { $('#sync').textContent = t; }

/** Focus without hard jump; smooth-scroll the field into view so edit target is obvious. */
function softFocusEdit(el) {
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* ignore */ } }
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } catch {
    try { el.scrollIntoView(true); } catch { /* ignore */ }
  }
}

/** Keep window scroll across list re-renders (expand/save/delete). */
function withPreservedScroll(fn) {
  const y = window.scrollY || window.pageYOffset || 0;
  const x = window.scrollX || window.pageXOffset || 0;
  fn();
  requestAnimationFrame(() => {
    window.scrollTo(x, y);
  });
}

// ---------- estado de tildes ----------
const pending = () => LS.get('mb_pending', {});
function effectiveDone(it) {
  const p = pending();
  if (it.id in p) return p[it.id];
  const r = LS.get('mb_recent', {})[it.id];
  if (r && Date.now() - r.t < RECENT_MS) return r.done;
  return it.done;
}
function toggle(id, done) {
  const p = pending(); p[id] = done; LS.set('mb_pending', p);
  document.querySelectorAll(`[data-item="${CSS.escape(id)}"]`).forEach((n) => n.classList.toggle('done', done));
  setSync('Guardando…');
  clearTimeout(timer); timer = setTimeout(flush, DEBOUNCE_MS);
}
async function flush() {
  clearTimeout(timer); timer = null;
  const p = pending(); const changes = Object.entries(p).map(([id, done]) => ({ id, done }));
  if (!changes.length) return;
  try {
    const r = await fetch('/api/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }), keepalive: true, credentials: 'same-origin' });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    const now = pending(), recent = LS.get('mb_recent', {});
    for (const c of changes) { if (now[c.id] === c.done) delete now[c.id]; recent[c.id] = { done: c.done, t: Date.now() }; }
    for (const k of Object.keys(recent)) if (Date.now() - recent[k].t > RECENT_MS) delete recent[k];
    LS.set('mb_pending', now); LS.set('mb_recent', recent);
    setSync('Guardado');
  } catch { setSync('Sin conexión: se guarda al volver'); }
}
function beacon() {
  const changes = Object.entries(pending()).map(([id, done]) => ({ id, done }));
  if (!changes.length || !navigator.sendBeacon) return;
  navigator.sendBeacon('/api/toggle', new Blob([JSON.stringify({ changes })], { type: 'text/plain' }));
  // se deja en pending: la próxima carga lo reenvía (idempotente) y lo limpia
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && timer) { clearTimeout(timer); timer = null; beacon(); } });
window.addEventListener('pagehide', () => { if (timer) beacon(); });

// ---------- render ----------
function itemRow(it) {
  const done = effectiveDone(it);
  const links = (it.links || []).map((l) => tabLink(l.label, l.url, l.tab));
  return el('li', { class: done ? 'done' : '', 'data-item': it.id },
    el('input', { type: 'checkbox', class: 'chk', checked: done, 'aria-label': 'Hecho: ' + it.titulo, onchange: (e) => toggle(it.id, e.target.checked) }),
    el('div', { class: 'body' },
      el('div', { class: 't' }, it.titulo),
      it.detalle ? el('div', { class: 'd' }, it.detalle) : null,
      links.length ? el('div', { class: 'links' }, links) : null,
      el('div', { class: 'id' }, it.id)),
    it.etiqueta ? el('span', { class: 'tag ' + (it.tono || '') }, it.etiqueta) : null);
}
function ofertaRow(it) {
  const done = effectiveDone(it), x = it.extra || {}, l = (it.links || [])[0];
  const sc = it.score == null ? '' : it.score;
  return el('tr', { class: done ? 'done' : '', 'data-item': it.id },
    el('td', {}, el('input', { type: 'checkbox', class: 'chk', checked: done, 'aria-label': 'Hecho: ' + it.titulo, onchange: (e) => toggle(it.id, e.target.checked) })),
    el('td', {}, el('span', { class: 'score ' + (sc >= 65 ? 'hi' : 'lo') }, sc)),
    el('td', {}, el('strong', {}, it.titulo), el('div', { class: 'muted' }, it.detalle || ''), el('div', { class: 'id' }, it.id)),
    el('td', {}, x.modalidad || ''), el('td', {}, x.publicada || ''), el('td', {}, x.sueldo || ''),
    el('td', {}, l ? tabLink(l.label, l.url, l.tab) : ''));
}
function renderBrief() {
  const m = brief.meta || {};
  $('#corrida').textContent = m.corrida || '';
  $('#titular').textContent = m.titular || '';
  $('#agenda').textContent = m.agenda_texto || '';
  $('#procesos').textContent = m.procesos_texto || '';
  $('#fuera').textContent = m.fuera_busqueda_texto || '';
  $('#descartadas').textContent = m.descartadas_texto || '';
  $('#fuentes').textContent = m.fuentes_texto || '';
  const by = { atencion: [], listos: [], ofertas: [], resuelto: [] };
  for (const it of brief.items) (by[it.seccion] || by.atencion).push(it);
  // abiertos primero, tildados al final
  const ord = (a) => a.slice().sort((x, y) => effectiveDone(x) - effectiveDone(y));
  for (const s of ['atencion', 'listos', 'resuelto']) {
    const ul = $('#sec-' + s); ul.replaceChildren(...ord(by[s]).map(itemRow));
    if (!by[s].length) ul.append(el('li', { class: 'muted' }, 'Nada por ahora.'));
  }
  const tb = $('#sec-ofertas tbody'); tb.replaceChildren(...ord(by.ofertas).map(ofertaRow));
  if (!by.ofertas.length) tb.append(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'Sin ofertas nuevas que pasen el corte.')));
}

// ---------- agregar pendiente (items.atencion) ----------
$('#addPendiente').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!brief) return;
  const titulo = $('#pTitulo').value.trim();
  if (!titulo) return;
  const detalle = $('#pDetalle').value.trim() || null;
  const etiqueta = $('#pEtiqueta').value.trim() || null;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  setSync('Agregando…');
  try {
    const r = await fetch('/api/item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo, detalle, etiqueta }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    const it = await r.json();
    brief.items.push(it);
    e.target.reset();
    renderBrief();
    setSync('Agregado');
    $('#pTitulo').focus();
  } catch {
    setSync('No se pudo agregar');
  } finally {
    btn.disabled = false;
  }
});

// ---------- medicación ----------
const medPending = () => LS.get('mb_med_pending', {});
function medEffective(it) {
  const p = medPending();
  if (it.id in p) return p[it.id];
  const r = LS.get('mb_med_recent', {})[it.id];
  if (r && Date.now() - r.t < RECENT_MS) return r.tomado;
  return !!it.tomado;
}
function medToggle(id, tomado) {
  const p = medPending(); p[id] = tomado; LS.set('mb_med_pending', p);
  document.querySelectorAll(`[data-med="${CSS.escape(id)}"]`).forEach((n) => n.classList.toggle('done', tomado));
  setSync('Guardando…');
  clearTimeout(medTimer); medTimer = setTimeout(flushMeds, DEBOUNCE_MS);
}
async function flushMeds() {
  clearTimeout(medTimer); medTimer = null;
  const p = medPending();
  const changes = Object.entries(p);
  if (!changes.length) return;
  try {
    for (const [id, tomado] of changes) {
      const r = await fetch('/api/med-dose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, tomado }),
        keepalive: true,
        credentials: 'same-origin',
      });
      if (r.status === 401) return showLogin();
      if (!r.ok) throw new Error(r.status);
      const now = medPending(), recent = LS.get('mb_med_recent', {});
      if (now[id] === tomado) delete now[id];
      recent[id] = { tomado, t: Date.now() };
      LS.set('mb_med_pending', now); LS.set('mb_med_recent', recent);
      if (meds) {
        const it = meds.items.find((m) => m.id === id);
        if (it) it.tomado = tomado;
      }
    }
    setSync('Guardado');
  } catch { setSync('Sin conexión: se guarda al volver'); }
}
function formatHoy(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function medHoyRow(it) {
  const tomado = medEffective(it);
  return el('li', { class: tomado ? 'done' : '', 'data-med': it.id },
    el('input', { type: 'checkbox', class: 'chk', checked: tomado, 'aria-label': 'Tomé: ' + it.nombre, onchange: (e) => medToggle(it.id, e.target.checked) }),
    el('div', { class: 'body' },
      el('div', { class: 't' }, it.nombre),
      it.notas ? el('div', { class: 'd' }, it.notas) : null),
    it.momento ? el('span', { class: 'tag' }, MOMENTO_LABEL[it.momento] || it.momento) : null);
}
function medCatalogRow(it) {
  const toggleLabel = it.activo ? 'Desactivar' : 'Activar';
  return el('li', { class: it.activo ? '' : 'done', 'data-med-cat': it.id },
    el('div', { class: 'body' },
      el('div', { class: 't' }, it.nombre),
      it.notas ? el('div', { class: 'd' }, it.notas) : null,
      el('div', { class: 'id' }, it.id)),
    it.momento ? el('span', { class: 'tag' }, MOMENTO_LABEL[it.momento] || it.momento) : null,
    el('div', { class: 'row-actions' },
      iconBtn({
        label: toggleLabel,
        icon: it.activo ? 'pause' : 'power',
        onclick: () => patchMed(it.id, { activo: !it.activo }),
      }),
      iconBtn({
        label: 'Borrar',
        icon: 'trash',
        danger: true,
        onclick: () => deleteMed(it.id, it.nombre),
      })));
}
function renderMeds() {
  if (!meds) return;
  $('#medHoy').textContent = `Hoy · ${formatHoy(meds.hoy)} (${meds.tz || 'America/Argentina/Buenos_Aires'})`;
  const activos = meds.items.filter((m) => m.activo);
  const ul = $('#medHoyList');
  ul.replaceChildren(...activos.map(medHoyRow));
  if (!activos.length) ul.append(el('li', { class: 'muted' }, 'Sin medicamentos activos. Agregá uno abajo.'));
  const cat = $('#medCatalog');
  cat.replaceChildren(...meds.items.map(medCatalogRow));
  if (!meds.items.length) cat.append(el('li', { class: 'muted' }, 'Catálogo vacío.'));
}
async function loadMeds(force) {
  if (meds && !force) return renderMeds();
  setSync('Cargando medicación…');
  const r = await fetch('/api/meds', { credentials: 'same-origin', cache: force ? 'reload' : 'default' });
  if (r.status === 401) return showLogin();
  if (!r.ok) { setSync('Error medicación (' + r.status + ')'); return; }
  meds = await r.json();
  setSync('');
  renderMeds();
  if (Object.keys(medPending()).length) flushMeds();
}
async function patchMed(id, patch) {
  setSync('Guardando…');
  try {
    const r = await fetch('/api/meds', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...patch }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    const updated = await r.json();
    const it = meds.items.find((m) => m.id === id);
    if (it) Object.assign(it, updated);
    renderMeds();
    setSync('Guardado');
  } catch { setSync('No se pudo actualizar'); }
}
async function deleteMed(id, nombre) {
  if (!confirm(`¿Borrar «${nombre || id}» del catálogo? Se pierden también las tomas registradas.`)) return;
  setSync('Borrando…');
  try {
    const r = await fetch('/api/meds', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    if (meds) meds.items = meds.items.filter((m) => m.id !== id);
    const p = medPending(); delete p[id]; LS.set('mb_med_pending', p);
    const recent = LS.get('mb_med_recent', {}); delete recent[id]; LS.set('mb_med_recent', recent);
    renderMeds();
    setSync('Borrado');
  } catch { setSync('No se pudo borrar'); }
}
$('#addMed').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('#mNombre').value.trim();
  if (!nombre) return;
  const notas = $('#mNotas').value.trim() || null;
  const momento = $('#mMomento').value.trim() || null;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  setSync('Agregando…');
  try {
    const r = await fetch('/api/meds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, notas, momento }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    const it = await r.json();
    if (!meds) meds = { hoy: '', tz: 'America/Argentina/Buenos_Aires', items: [] };
    meds.items.push(it);
    meds.items.sort((a, b) => (a.orden - b.orden) || a.id.localeCompare(b.id));
    e.target.reset();
    renderMeds();
    setSync('Agregado');
    $('#mNombre').focus();
  } catch { setSync('No se pudo agregar'); }
  finally { btn.disabled = false; }
});

// ---------- compras ----------
const shopPending = () => LS.get('mb_shop_pending', {});
function shopEffective(it) {
  const p = shopPending();
  if (it.id in p) return p[it.id];
  const r = LS.get('mb_shop_recent', {})[it.id];
  if (r && Date.now() - r.t < RECENT_MS) return r.comprado;
  return !!it.comprado;
}
function shopToggle(id, comprado) {
  const p = shopPending(); p[id] = comprado; LS.set('mb_shop_pending', p);
  document.querySelectorAll(`[data-shop="${CSS.escape(id)}"]`).forEach((n) => n.classList.toggle('done', comprado));
  setSync('Guardando…');
  clearTimeout(shopTimer); shopTimer = setTimeout(flushShop, DEBOUNCE_MS);
}
async function flushShop() {
  clearTimeout(shopTimer); shopTimer = null;
  const p = shopPending();
  const changes = Object.entries(p);
  if (!changes.length) return;
  try {
    for (const [id, comprado] of changes) {
      const r = await fetch('/api/shopping', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, comprado }),
        keepalive: true,
        credentials: 'same-origin',
      });
      if (r.status === 401) return showLogin();
      if (!r.ok) throw new Error(r.status);
      const now = shopPending(), recent = LS.get('mb_shop_recent', {});
      if (now[id] === comprado) delete now[id];
      recent[id] = { comprado, t: Date.now() };
      LS.set('mb_shop_pending', now); LS.set('mb_shop_recent', recent);
      if (shopping) {
        const it = shopping.items.find((s) => s.id === id);
        if (it) { it.comprado = comprado; if (comprado) it.comprado_en = new Date().toISOString(); else it.comprado_en = null; }
      }
    }
    setSync('Guardado');
    renderShopping();
  } catch { setSync('Sin conexión: se guarda al volver'); }
}
function shopRow(it) {
  const comprado = shopEffective(it);
  const detalle = [it.cantidad, it.notas].filter(Boolean).join(' · ');
  return el('li', { class: comprado ? 'done' : '', 'data-shop': it.id },
    el('input', { type: 'checkbox', class: 'chk', checked: comprado, 'aria-label': 'Comprado: ' + it.nombre, onchange: (e) => shopToggle(it.id, e.target.checked) }),
    el('div', { class: 'body' },
      el('div', { class: 't' }, it.nombre),
      detalle ? el('div', { class: 'd' }, detalle) : null),
    el('div', { class: 'row-actions' },
      iconBtn({
        label: 'Borrar',
        icon: 'trash',
        danger: true,
        onclick: () => deleteShop(it.id),
      })));
}
function renderShopping() {
  if (!shopping) return;
  const open = shopping.items.filter((s) => !shopEffective(s));
  const bought = shopping.items.filter((s) => shopEffective(s));
  $('#shopMeta').textContent = `${open.length} pendiente${open.length === 1 ? '' : 's'} · ${bought.length} comprado${bought.length === 1 ? '' : 's'}`;
  const ulOpen = $('#shopOpen');
  ulOpen.replaceChildren(...open.map(shopRow));
  if (!open.length) ulOpen.append(el('li', { class: 'muted' }, 'Nada pendiente. Agregá algo arriba.'));
  const ulBought = $('#shopBought');
  ulBought.replaceChildren(...bought.map(shopRow));
  if (!bought.length) ulBought.append(el('li', { class: 'muted' }, 'Todavía no marcaste nada como comprado.'));
  $('#clearBought').disabled = !bought.length;
}
async function loadShopping(force) {
  if (shopping && !force) return renderShopping();
  setSync('Cargando compras…');
  const r = await fetch('/api/shopping', { credentials: 'same-origin', cache: force ? 'reload' : 'default' });
  if (r.status === 401) return showLogin();
  if (!r.ok) { setSync('Error compras (' + r.status + ')'); return; }
  shopping = await r.json();
  setSync('');
  renderShopping();
  if (Object.keys(shopPending()).length) flushShop();
}
async function deleteShop(id) {
  setSync('Borrando…');
  try {
    const r = await fetch('/api/shopping', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    if (shopping) shopping.items = shopping.items.filter((s) => s.id !== id);
    const p = shopPending(); delete p[id]; LS.set('mb_shop_pending', p);
    renderShopping();
    setSync('Borrado');
  } catch { setSync('No se pudo borrar'); }
}
$('#addShop').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('#sNombre').value.trim();
  if (!nombre) return;
  const cantidad = $('#sCantidad').value.trim() || null;
  const notas = $('#sNotas').value.trim() || null;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  setSync('Agregando…');
  try {
    const r = await fetch('/api/shopping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, cantidad, notas }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    const it = await r.json();
    if (!shopping) shopping = { items: [] };
    shopping.items.push(it);
    shopping.items.sort((a, b) => (a.comprado - b.comprado) || (a.orden - b.orden) || a.id.localeCompare(b.id));
    e.target.reset();
    renderShopping();
    setSync('Agregado');
    $('#sNombre').focus();
  } catch { setSync('No se pudo agregar'); }
  finally { btn.disabled = false; }
});
$('#clearBought').addEventListener('click', async () => {
  if (!$('#clearBought').disabled && !confirm('¿Borrar todos los comprados?')) return;
  setSync('Limpiando…');
  try {
    const r = await fetch('/api/shopping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear_bought' }),
      credentials: 'same-origin',
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    LS.set('mb_shop_pending', {});
    LS.set('mb_shop_recent', {});
    shopping = null;
    await loadShopping(true);
    setSync('Comprados limpiados');
  } catch { setSync('No se pudo limpiar'); }
});

// ---------- gastos ----------
const moneyFmt = (n, cur = 'ARS') => {
  if (n == null || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: cur === 'USD' ? 'USD' : 'ARS', maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v} ${cur}`;
  }
};
function fillAccountSelects() {
  if (!gastos?.accounts) return;
  renderAcctChips();
  for (const sel of [$('#gResCuenta'), $('#rAccount')]) {
    if (!sel) continue;
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '' }, 'Todas las cuentas'));
    for (const a of gastos.accounts) sel.append(el('option', { value: a.id }, a.nombre));
    // Prefer current selection; for rAccount fall back to all accounts ('').
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
  }
  const catSel = $('#rCategory');
  if (catSel) {
    const cur = catSel.value;
    catSel.replaceChildren(el('option', { value: '' }, 'Elegir categoría'));
    for (const c of gastos.categories || []) catSel.append(el('option', { value: c.id }, c.nombre));
    catSel.value = [...catSel.options].some((o) => o.value === cur) ? cur : '';
  }
  const filtroCat = $('#gFiltroCategoria');
  if (filtroCat) {
    const cur = filtroCat.value || '';
    filtroCat.replaceChildren(
      el('option', { value: '' }, 'Todas las categorías'),
      el('option', { value: '__none__' }, 'Sin clasificar'),
    );
    for (const c of gastos.categories || []) filtroCat.append(el('option', { value: c.id }, c.nombre));
    if ([...filtroCat.options].some((o) => o.value === cur)) filtroCat.value = cur;
  }
}

function acctSelectionSet() {
  const all = (gastos?.accounts || []).map((a) => a.id);
  if (gastosAcctSelected == null) return new Set(all);
  return new Set(gastosAcctSelected);
}

function renderAcctChips() {
  const wrap = $('#gAcctChips');
  if (!wrap || !gastos?.accounts) return;
  const selected = acctSelectionSet();
  wrap.replaceChildren(...gastos.accounts.map((a) => {
    const on = selected.has(a.id);
    return el('button', {
      type: 'button',
      class: 'acct-chip' + (on ? ' on' : ''),
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => {
        const next = acctSelectionSet();
        if (next.has(a.id)) next.delete(a.id);
        else next.add(a.id);
        const allIds = gastos.accounts.map((x) => x.id);
        gastosAcctSelected = next.size === allIds.length ? null : [...next];
        renderAcctChips();
        if (gastosSub === 'movimientos') loadGastosMov();
      },
    }, a.nombre);
  }));
}

/** Partial selection → account_ids. All selected → []. None → null (caller shows empty). */
function selectedAccountIds() {
  const all = gastos?.accounts || [];
  if (!all.length) return [];
  if (gastosAcctSelected == null) return [];
  if (!gastosAcctSelected.length) return null;
  if (gastosAcctSelected.length === all.length) return [];
  return gastosAcctSelected.slice();
}

$('#gAcctAll')?.addEventListener('click', () => {
  gastosAcctSelected = null;
  renderAcctChips();
  if (gastosSub === 'movimientos') loadGastosMov();
});
$('#gAcctNone')?.addEventListener('click', () => {
  gastosAcctSelected = [];
  renderAcctChips();
  if (gastosSub === 'movimientos') loadGastosMov();
});
function showGastosSub(sub) {
  gastosSub = sub;
  ensureGastosMonthDefaults();
  for (const s of ['movimientos', 'reglas', 'resumen', 'importar']) {
    const n = $('#gastos-' + s);
    if (n) n.hidden = s !== sub;
  }
  document.querySelectorAll('#gastosSubtabs button').forEach((b) => b.classList.toggle('on', b.dataset.gview === sub));
  if (sub === 'movimientos') loadGastosMov();
  if (sub === 'reglas') { renderGastosCats(); renderGastosRules(); }
  if (sub === 'resumen') loadGastosResumen();
}
document.querySelectorAll('#gastosSubtabs button').forEach((b) => b.addEventListener('click', () => showGastosSub(b.dataset.gview)));

async function loadGastosMeta(force) {
  if (gastos && !force) { fillAccountSelects(); return gastos; }
  setSync('Cargando gastos…');
  const r = await fetch('/api/gastos?view=meta', { credentials: 'same-origin', cache: force ? 'reload' : 'default' });
  if (r.status === 401) return showLogin();
  if (!r.ok) { setSync('Error gastos (' + r.status + ')'); return null; }
  gastos = await r.json();
  fillAccountSelects();
  setSync('');
  return gastos;
}

function renderGastosPreview() {
  const wrap = $('#gastosPreviewWrap');
  const meta = $('#gastosImportMeta');
  if (!gastosPreview) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const s = gastosPreview.summary || {};
  const warns = (gastosPreview.warnings || []).join(', ');
  meta.textContent = `${gastosPreview.account_id} · ${gastosPreview.source_format} · ${gastosPreview.txs.length} movs` +
    (s.balance_check_ok === false ? ' · ⚠ summary mismatch' : s.balance_check_ok ? ' · summary OK' : '') +
    (warns ? ' · ' + warns : '');
  const tb = $('#gastosPreview tbody');
  tb.replaceChildren(...gastosPreview.txs.slice(0, 200).map((t) => {
    const flags = [];
    if (t.is_internal_transfer) flags.push(el('span', { class: 'flag' }, 'interna'));
    if (t.is_excluded) flags.push(el('span', { class: 'flag warn' }, 'excluida'));
    if (t.double_count_guard) flags.push(el('span', { class: 'flag guard' }, 'merpago'));
    return el('tr', {},
      el('td', {}, t.fecha),
      el('td', { class: 'muted' }, formatGastosHora(t)),
      el('td', {}, t.descripcion || t.merchant || ''),
      el('td', { class: 'amt ' + (t.amount < 0 ? 'neg' : 'pos') }, moneyFmt(t.amount, t.currency)),
      el('td', {}, t.currency),
      el('td', {}, ...flags));
  }));
}

async function fileToB64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

$('#gastosUpload').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('#gFile').files?.[0];
  if (!file) return;
  const settFile = $('#gSettlement')?.files?.[0] || null;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  setSync('Parseando…');
  try {
    gastosFileB64 = await fileToB64(file);
    gastosFileName = file.name;
    gastosSettlementB64 = settFile ? await fileToB64(settFile) : null;
    const account_id = $('#gAccountHint').value || null;
    const body = { action: 'preview', filename: file.name, content_base64: gastosFileB64, account_id };
    if (gastosSettlementB64) body.settlement_base64 = gastosSettlementB64;
    const r = await fetch('/api/gastos-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (r.status === 401) return showLogin();
    if (r.status === 409) {
      const err = await r.json();
      setSync('Archivo ya importado');
      $('#gastosImportMeta').textContent = 'Duplicado: ' + (err.filename || err.import_id);
      gastosPreview = null;
      renderGastosPreview();
      return;
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setSync('No se pudo parsear');
      $('#gastosImportMeta').textContent = err.error || ('HTTP ' + r.status);
      return;
    }
    gastosPreview = await r.json();
    renderGastosPreview();
    setSync('Vista previa lista');
  } catch {
    setSync('Error al leer archivo');
  } finally {
    btn.disabled = false;
  }
});

$('#gastosConfirm').addEventListener('click', async () => {
  if (!gastosFileB64 || !gastosPreview) return;
  if (!confirm(`¿Confirmar import de ${gastosPreview.txs.length} movimientos?`)) return;
  setSync('Confirmando…');
  $('#gastosConfirm').disabled = true;
  try {
    const body = {
      action: 'confirm',
      filename: gastosFileName,
      content_base64: gastosFileB64,
      account_id: gastosPreview.account_id,
    };
    if (gastosSettlementB64) body.settlement_base64 = gastosSettlementB64;
    const r = await fetch('/api/gastos-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      setSync(err.error === 'duplicate_file' ? 'Ya importado' : 'No se pudo confirmar');
      return;
    }
    const out = await r.json();
    const joined = out.summary?.settlement_joined;
    setSync(`Import OK · ${out.upserted} upsert` + (joined != null ? ` · settlement ${joined}` : ''));
    gastosPreview = null;
    gastosFileB64 = null;
    gastosSettlementB64 = null;
    renderGastosPreview();
    $('#gastosImportMeta').textContent = `Confirmado ${out.import_id} · ${out.upserted} movimientos` +
      (joined != null ? ` · join ${joined}` : '');
    await loadGastosMeta(true);
  } catch {
    setSync('Error al confirmar');
  } finally {
    $('#gastosConfirm').disabled = false;
  }
});

async function loadGastosMov() {
  await loadGastosMeta(false);
  const accountIds = selectedAccountIds();
  if (accountIds === null) {
    fillAccountSelects();
    $('#gMovCount').textContent = '0 filas';
    $('#gastosMov tbody')?.replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'Elegí al menos una cuenta.')));
    setSync('');
    return;
  }
  const month = $('#gFiltroMes').value;
  const include = $('#gIncluirExcluidos').checked ? '1' : '0';
  const catVal = $('#gFiltroCategoria')?.value || '';
  const flow = $('#gFiltroFlow')?.value || '';
  const textQ = ($('#gFiltroTexto')?.value || '').trim();
  const qs = new URLSearchParams({ view: 'movimientos', include_excluded: include });
  if (accountIds.length) qs.set('account_ids', accountIds.join(','));
  if (month) qs.set('month', month);
  if (catVal === '__none__') qs.set('uncategorized', '1');
  else if (catVal) qs.set('category_id', catVal);
  if (flow === 'ingresos' || flow === 'gastos') qs.set('flow', flow);
  if (textQ) qs.set('q', textQ);
  setSync('Cargando movimientos…');
  const r = await fetch('/api/gastos?' + qs, { credentials: 'same-origin' });
  if (r.status === 401) return showLogin();
  if (!r.ok) { setSync('Error movimientos'); return; }
  const data = await r.json();
  gastos = { ...gastos, ...data };
  fillAccountSelects();
  gastosMovRows = data.transactions || [];
  $('#gMovCount').textContent = `${gastosMovRows.length} filas`;
  renderGastosMovTable();
  setSync('');
}

function movSortValue(t, key) {
  switch (key) {
    case 'fecha': return String(t.fecha || '');
    case 'hora': {
      if (typeof t.hora_local === 'number') return t.hora_local;
      if (t.posted_at) return new Date(t.posted_at).getTime();
      return -1;
    }
    case 'cuenta': return String(t.account_nombre || t.account_id || '').toLowerCase();
    case 'desc': return String(t.descripcion || t.merchant || '').toLowerCase();
    case 'monto': return Number(t.amount) || 0;
    case 'categoria': return String(catNombre(t.category_id) || '').toLowerCase();
    default: return '';
  }
}

function sortedGastosMovRows() {
  const { key, dir } = gastosMovSort;
  const mul = dir === 'asc' ? 1 : -1;
  return gastosMovRows.slice().sort((a, b) => {
    const va = movSortValue(a, key);
    const vb = movSortValue(b, key);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return String(a.id).localeCompare(String(b.id)) * mul;
  });
}

function updateMovSortHeaders() {
  for (const btn of document.querySelectorAll('#gastosMov .th-sort')) {
    const on = btn.dataset.sort === gastosMovSort.key;
    btn.classList.toggle('on', on);
    if (on) btn.dataset.dir = gastosMovSort.dir === 'asc' ? '↑' : '↓';
    else btn.removeAttribute('data-dir');
  }
}

function renderGastosMovTable() {
  const tb = $('#gastosMov tbody');
  if (!tb) return;
  updateMovSortHeaders();
  const cats = gastos?.categories || [];
  tb.replaceChildren(...sortedGastosMovRows().map((t) => {
    const sel = el('select', {
      onchange: async (e) => {
        const category_id = e.target.value || null;
        let learn = false;
        if (category_id) {
          const label = String(t.merchant || t.descripcion || 'este movimiento').trim().slice(0, 80);
          learn = confirm(`¿Aplicar siempre a «${label}»?\n\nAceptar = crear regla para futuros iguales.\nCancelar = solo este movimiento.`);
        }
        setSync('Guardando…');
        const r2 = await fetch('/api/gastos', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ id: t.id, category_id, learn }),
        });
        if (!r2.ok) { setSync('Error'); return; }
        const out = await r2.json();
        t.category_id = out.category_id;
        t.category_source = out.category_source;
        if (out.learned_rule) {
          setSync(`Guardado · regla “${out.learned_rule.pattern}”` + (out.propagated ? ` · +${out.propagated} iguales` : ''));
          await loadGastosMeta(true);
          if (out.propagated) loadGastosMov();
        } else {
          setSync(learn === false && category_id ? 'Guardado · solo este movimiento' : 'Guardado');
          loadGastosMov();
        }
      },
    }, el('option', { value: '' }, '—'));
    for (const c of cats) sel.append(el('option', { value: c.id, selected: c.id === t.category_id }, c.nombre));
    const flags = [];
    if (t.category_source === 'history') flags.push(el('span', { class: 'flag', title: 'Heredada de merchant previo' }, 'hist'));
    if (t.is_excluded) flags.push(el('span', { class: 'flag warn' }, 'excl'));
    if (t.double_count_guard) flags.push(el('span', { class: 'flag guard' }, 'mp'));
    return el('tr', {},
      el('td', {}, String(t.fecha).slice(0, 10)),
      el('td', { class: 'muted' }, formatGastosHora(t)),
      el('td', {}, t.account_nombre || t.account_id),
      el('td', {}, t.descripcion || t.merchant || '', flags.length ? el('div', {}, ...flags) : null),
      el('td', { class: 'amt ' + (Number(t.amount) < 0 ? 'neg' : 'pos') }, moneyFmt(t.amount, t.currency)),
      el('td', {}, sel),
      el('td', {}, el('button', {
        type: 'button',
        class: 'ghost',
        onclick: async () => {
          const r2 = await fetch('/api/gastos', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ id: t.id, is_excluded: !t.is_excluded, learn: false }),
          });
          if (r2.ok) loadGastosMov();
        },
      }, t.is_excluded ? 'Incluir' : 'Excluir')));
  }));
}

for (const id of ['#gFiltroCategoria', '#gFiltroFlow', '#gFiltroMes', '#gIncluirExcluidos']) {
  $(id)?.addEventListener('change', () => { if (gastosSub === 'movimientos') loadGastosMov(); });
}
$('#gFiltroTexto')?.addEventListener('input', () => {
  if (gastosSub !== 'movimientos') return;
  clearTimeout(gastosMovSearchTimer);
  gastosMovSearchTimer = setTimeout(() => loadGastosMov(), 300);
});
$('#gFiltroTexto')?.addEventListener('search', () => {
  if (gastosSub !== 'movimientos') return;
  clearTimeout(gastosMovSearchTimer);
  loadGastosMov();
});
$('#gastosMov')?.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.th-sort');
  if (!btn || !$('#gastosMov').contains(btn)) return;
  const key = btn.dataset.sort;
  if (!key) return;
  if (gastosMovSort.key === key) {
    gastosMovSort.dir = gastosMovSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    gastosMovSort = { key, dir: key === 'fecha' || key === 'monto' || key === 'hora' ? 'desc' : 'asc' };
  }
  renderGastosMovTable();
});

function catNombre(id) {
  if (!id) return null;
  return (gastos?.categories || []).find((c) => c.id === id)?.nombre || id;
}
function accountNombre(id) {
  if (!id) return null;
  return (gastos?.accounts || []).find((a) => a.id === id)?.nombre || id;
}

function clearCategoriaEdit() {
  const form = $('#addCategoria');
  if (!form) return;
  form.reset();
  if ($('#cEditId')) $('#cEditId').value = '';
  if ($('#cSubmit')) $('#cSubmit').textContent = 'Crear';
  if ($('#cCancelEdit')) $('#cCancelEdit').hidden = true;
}

function startCategoriaEdit(c) {
  if (!c) return;
  if ($('#cEditId')) $('#cEditId').value = c.id;
  if ($('#cNombre')) $('#cNombre').value = c.nombre || '';
  if ($('#cSubmit')) $('#cSubmit').textContent = 'Guardar';
  if ($('#cCancelEdit')) $('#cCancelEdit').hidden = false;
  softFocusEdit($('#cNombre'));
  setSync('Editando categoría');
}

function renderGastosCats() {
  withPreservedScroll(() => {
    if (!gastos) return;
    const ul = $('#gastosCats');
    if (!ul) return;
    const cats = gastos.categories || [];
    ul.replaceChildren(...cats.map((c) => el('li', {},
      el('div', { class: 'body' },
        el('div', { class: 't' }, c.nombre)),
      el('div', { class: 'row-actions' },
        iconBtn({
          label: 'Editar categoría',
          icon: 'edit',
          onclick: () => startCategoriaEdit(c),
        })))));
    if (!cats.length) ul.append(el('li', { class: 'muted' }, 'Todavía no hay categorías.'));
  });
}
function parseUiNamePartsPattern(pattern) {
  const m = /^nameparts:(?:(\d+):)?(.+)$/i.exec(String(pattern || '').trim());
  if (!m) return null;
  return { min: m[1] ? parseInt(m[1], 10) || 2 : 2, tokens: m[2].trim() };
}

function rulePatternLabel(pattern) {
  const np = parseUiNamePartsPattern(pattern);
  if (np) return `partes≥${np.min}: ${np.tokens}`;
  return pattern || '';
}

function clearReglaEdit() {
  const form = $('#addRegla');
  if (!form) return;
  form.reset();
  if ($('#rEditId')) $('#rEditId').value = '';
  if ($('#rAccount')) $('#rAccount').value = ''; // default: todas las cuentas
  if ($('#rMatchType')) $('#rMatchType').value = 'contains';
  if ($('#rSubmit')) $('#rSubmit').textContent = 'Agregar';
  if ($('#rCancelEdit')) $('#rCancelEdit').hidden = true;
}

function startReglaEdit(r) {
  if (!r) return;
  if ($('#rEditId')) $('#rEditId').value = r.id;
  const np = parseUiNamePartsPattern(r.pattern);
  if ($('#rMatchType')) $('#rMatchType').value = np ? 'nameparts' : 'contains';
  if ($('#rPattern')) $('#rPattern').value = np ? np.tokens : (r.pattern || '');
  if ($('#rCategory')) $('#rCategory').value = r.category_id || '';
  if ($('#rAccount')) $('#rAccount').value = r.account_id || '';
  if ($('#rExclude')) $('#rExclude').checked = !!r.exclude_expense;
  if ($('#rSubmit')) $('#rSubmit').textContent = 'Guardar';
  if ($('#rCancelEdit')) $('#rCancelEdit').hidden = false;
  softFocusEdit($('#rPattern'));
  setSync('Editando regla');
}

function ruleSearchHay(r) {
  const cat = catNombre(r.category_id) || '';
  const acct = accountNombre(r.account_id) || '';
  return `${r.pattern || ''} ${cat} ${acct}`.toLowerCase();
}

function ruleGroupKey(r) {
  if (r.category_id) return `cat:${r.category_id}`;
  if (r.exclude_expense) return 'exclude';
  return 'none';
}

function ruleGroupMeta(key) {
  if (key === 'exclude') {
    return { title: 'No contar como gasto', orden: 9500 };
  }
  if (key === 'none') {
    return { title: 'Sin categoría', orden: 9600 };
  }
  const id = key.slice(4);
  const cat = (gastos?.categories || []).find((c) => c.id === id);
  return {
    title: cat?.nombre || catNombre(id) || id,
    orden: typeof cat?.orden === 'number' ? cat.orden : 5000,
  };
}

function deleteRegla(r) {
  return async () => {
    if (!confirm(`¿Borrar la regla «${r.pattern}»?`)) return;
    setSync('Borrando…');
    const res = await fetch('/api/gastos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ entity: 'rule', id: r.id }),
    });
    if (!res.ok) { setSync('No se pudo borrar'); return; }
    if ($('#rEditId')?.value === r.id) clearReglaEdit();
    await loadGastosMeta(true);
    renderGastosRules();
    setSync('Regla borrada');
  };
}

function renderGastosRules() {
  withPreservedScroll(() => {
    if (!gastos) return;
    const ul = $('#gastosRules');
    if (!ul) return;
    const q = ($('#rFilter')?.value || '').trim().toLowerCase();
    const all = gastos.rules || [];
    const rules = q ? all.filter((r) => ruleSearchHay(r).includes(q)) : all;
    if ($('#rFilterCount')) {
      $('#rFilterCount').textContent = q
        ? `${rules.length} de ${all.length}`
        : (all.length ? `${all.length} reglas` : '');
    }

    const byGroup = new Map();
    for (const r of rules) {
      const key = ruleGroupKey(r);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(r);
    }
    const groups = [...byGroup.entries()]
      .map(([key, list]) => {
        const meta = ruleGroupMeta(key);
        list.sort((a, b) =>
          (a.priority - b.priority)
          || String(a.pattern || '').localeCompare(String(b.pattern || ''), 'es')
          || String(a.id).localeCompare(String(b.id)));
        return { key, ...meta, rules: list };
      })
      .sort((a, b) => (a.orden - b.orden) || a.title.localeCompare(b.title, 'es'));

    // Auto-expand groups that match search so hits are visible.
    if (q) {
      for (const g of groups) gastosRuleGroupsOpen.add(g.key);
    }

    ul.replaceChildren(...groups.map((g) => {
      const open = gastosRuleGroupsOpen.has(g.key);
      const preview = g.rules.slice(0, 6).map((r) => rulePatternLabel(r.pattern)).filter(Boolean);
      const more = g.rules.length > preview.length ? ` +${g.rules.length - preview.length}` : '';
      const head = el('button', {
        type: 'button',
        class: 'rule-group-head',
        'aria-expanded': open ? 'true' : 'false',
        onclick: () => {
          if (gastosRuleGroupsOpen.has(g.key)) gastosRuleGroupsOpen.delete(g.key);
          else gastosRuleGroupsOpen.add(g.key);
          renderGastosRules();
        },
      },
        el('span', { class: 'rule-group-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        el('span', { class: 'rule-group-title' }, g.title),
        el('span', { class: 'rule-group-count muted small' },
          `${g.rules.length} regla${g.rules.length === 1 ? '' : 's'}`),
        (!open && preview.length
          ? el('span', { class: 'rule-group-preview muted small' },
            `Si el texto contiene: ${preview.join(', ')}${more}`)
          : null));

      const body = el('div', {
        class: 'rule-group-body',
        hidden: !open,
      },
        el('p', { class: 'rule-group-lead muted small' }, 'Si el texto contiene:'),
        el('div', { class: 'rule-tag-list' },
          ...g.rules.map((r) => {
            const acct = accountNombre(r.account_id);
            const bits = [];
            if (acct) bits.push(`solo ${acct}`);
            if (r.exclude_expense) bits.push('excluir gasto');
            return el('div', { class: 'rule-tag-row' },
              el('span', { class: 'rule-tag', title: r.pattern }, rulePatternLabel(r.pattern)),
              bits.length ? el('span', { class: 'rule-tag-meta muted small' }, bits.join(' · ')) : null,
              el('div', { class: 'row-actions' },
                iconBtn({
                  label: `Editar «${r.pattern}»`,
                  icon: 'edit',
                  onclick: () => startReglaEdit(r),
                }),
                iconBtn({
                  label: `Borrar «${r.pattern}»`,
                  icon: 'trash',
                  danger: true,
                  onclick: deleteRegla(r),
                })));
          })));

      return el('li', { class: 'rule-group' + (open ? ' open' : '') }, head, body);
    }));

    if (!all.length) ul.append(el('li', { class: 'muted' }, 'Todavía no hay reglas.'));
    else if (!rules.length) ul.append(el('li', { class: 'muted' }, 'Ninguna regla coincide con la búsqueda.'));
  });
}
$('#cCancelEdit')?.addEventListener('click', () => {
  clearCategoriaEdit();
  setSync('');
});
$('#addCategoria')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = $('#cNombre').value.trim();
  if (!nombre) return;
  const editId = ($('#cEditId')?.value || '').trim();
  const existing = editId ? (gastos?.categories || []).find((x) => x.id === editId) : null;
  const btn = $('#cSubmit') || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const payload = { entity: 'category', nombre };
    if (editId) {
      payload.id = editId;
      if (existing && typeof existing.orden === 'number') payload.orden = existing.orden;
    }
    const r = await fetch('/api/gastos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    clearCategoriaEdit();
    await loadGastosMeta(true);
    renderGastosCats();
    renderGastosRules();
    fillAccountSelects();
    setSync(editId ? 'Categoría guardada' : 'Categoría creada');
  } catch { setSync(editId ? 'No se pudo guardar' : 'No se pudo crear categoría'); }
  finally { btn.disabled = false; }
});
$('#addRegla').addEventListener('submit', async (e) => {
  e.preventDefault();
  let pattern = $('#rPattern').value.trim();
  if (!pattern) return;
  const matchType = $('#rMatchType')?.value || 'contains';
  if (matchType === 'nameparts') {
    if (!/^nameparts:/i.test(pattern)) {
      const tokens = pattern.replace(/^nameparts:(?:\d+:)?/i, '').trim();
      if (tokens.split(/\s+/).filter(Boolean).length < 2) {
        setSync('Partes de nombre: poné al menos 2 palabras');
        return;
      }
      pattern = `nameparts:2:${tokens}`;
    }
  }
  const editId = ($('#rEditId')?.value || '').trim();
  const existing = editId ? (gastos?.rules || []).find((x) => x.id === editId) : null;
  const btn = $('#rSubmit') || e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const acctVal = ($('#rAccount')?.value || '').trim();
    const payload = {
      entity: 'rule',
      pattern,
      category_id: $('#rCategory').value || null,
      account_id: acctVal || null, // null = todas las cuentas
      exclude_expense: $('#rExclude').checked,
      priority: matchType === 'nameparts' && !editId ? 45 : undefined,
    };
    if (payload.priority === undefined) delete payload.priority;
    if (editId) {
      payload.id = editId;
      if (existing && typeof existing.priority === 'number') payload.priority = existing.priority;
    }
    const r = await fetch('/api/gastos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (r.status === 401) return showLogin();
    if (!r.ok) throw new Error(r.status);
    clearReglaEdit();
    await loadGastosMeta(true);
    renderGastosRules();
    setSync(editId ? 'Regla guardada' : 'Regla agregada');
  } catch { setSync(editId ? 'No se pudo guardar' : 'No se pudo agregar regla'); }
  finally { btn.disabled = false; }
});
$('#rCancelEdit')?.addEventListener('click', () => {
  clearReglaEdit();
  setSync('');
});
$('#rFilter')?.addEventListener('input', () => renderGastosRules());

async function loadGastosResumen() {
  await loadGastosMeta(false);
  const account_id = $('#gResCuenta').value;
  const month = $('#gResMes').value;
  const qs = new URLSearchParams({ view: 'resumen' });
  if (account_id) qs.set('account_id', account_id);
  if (month) qs.set('month', month);
  setSync('Cargando resumen…');
  const r = await fetch('/api/gastos?' + qs, { credentials: 'same-origin' });
  if (r.status === 401) return showLogin();
  if (!r.ok) { setSync('Error resumen'); return; }
  const data = await r.json();
  const rows = data.resumen || [];
  let spendArs = 0, spendUsd = 0, incomeArs = 0, incomeUsd = 0;
  for (const row of rows) {
    const spend = Math.abs(Number(row.spend) || 0);
    const income = Number(row.income) || 0;
    if (row.currency === 'USD') { spendUsd += spend; incomeUsd += income; }
    else { spendArs += spend; incomeArs += income; }
  }
  $('#gastosResumenCards').replaceChildren(
    el('div', { class: 'card' }, el('h3', {}, 'Gasto ARS'), el('p', {}, moneyFmt(-spendArs, 'ARS'))),
    el('div', { class: 'card' }, el('h3', {}, 'Gasto USD'), el('p', {}, moneyFmt(-spendUsd, 'USD'))),
    el('div', { class: 'card' }, el('h3', {}, 'Ingresos ARS'), el('p', {}, moneyFmt(incomeArs, 'ARS'))),
  );
  $('#gastosResumenTbl tbody').replaceChildren(...rows.map((row) => el('tr', {},
    el('td', {}, row.month),
    el('td', {}, row.currency),
    el('td', { class: 'amt neg' }, moneyFmt(row.spend, row.currency)),
    el('td', { class: 'amt pos' }, moneyFmt(row.income, row.currency)),
    el('td', {}, moneyFmt(row.excluded, row.currency)),
    el('td', {}, moneyFmt(row.guarded_merpago, row.currency)),
    el('td', {}, row.n))));
  $('#gastosCatTbl tbody').replaceChildren(...(data.by_category || []).map((row) => el('tr', {},
    el('td', {}, row.category),
    el('td', {}, row.currency),
    el('td', { class: 'amt' }, moneyFmt(row.total, row.currency)),
    el('td', {}, row.n))));
  setSync('');
}
for (const id of ['#gResCuenta', '#gResMes']) {
  $(id)?.addEventListener('change', () => { if (gastosSub === 'resumen') loadGastosResumen(); });
}

// ---------- tracker (a demanda, cacheado por versión) ----------
async function loadTracker() {
  if (tracker) return renderTracker();
  const v = brief && brief.tracker_v;
  const c = LS.get('mb_tracker', null);
  if (c && c.v === v) { tracker = c.data; return renderTracker(); }
  setSync('Cargando tracker…');
  const r = await fetch('/api/tracker?v=' + encodeURIComponent(v || ''), { credentials: 'same-origin' });
  if (r.status === 401) return showLogin();
  tracker = await r.json(); LS.set('mb_tracker', { v, data: tracker }); setSync('');
  renderTracker();
}
function renderTracker() {
  const C = Object.fromEntries(tracker.cols.map((c, i) => [c, i]));
  const sel = $('#fEstado');
  if (sel.options.length === 1) {
    const counts = {}; for (const r of tracker.rows) counts[r[C.estado_corto]] = (counts[r[C.estado_corto]] || 0) + 1;
    for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) sel.append(el('option', { value: k }, `${k} (${n})`));
  }
  const q = $('#fEmpresa').value.trim().toLowerCase(), est = sel.value, sec = $('#fSeccion').value;
  const rows = tracker.rows.filter((r) => (est === '*' || (est ? r[C.estado_corto] === est : r[C.estado_corto] !== 'Registro')) && (!sec || r[C.seccion] === sec) &&
    (!q || (r[C.empresa] || '').toLowerCase().includes(q) || (r[C.rol] || '').toLowerCase().includes(q)));
  $('#tCount').textContent = `${rows.length} de ${tracker.rows.length}`;
  $('#tTable tbody').replaceChildren(...rows.map((r) => {
    const link = r[C.link] ? (/^https?:/.test(r[C.link]) ? r[C.link] : 'https://' + r[C.link]) : null;
    return el('tr', {},
      el('td', {}, r[C.fecha] || ''),
      el('td', {}, el('div', { class: 'clamp', title: r[C.empresa] || '' }, r[C.empresa] || '')),
      el('td', {}, el('div', { class: 'clamp', title: r[C.rol] || '' }, r[C.rol] || ''), link ? el('div', {}, tabLink('aviso', link, 'tracker-' + r[C.id])) : null),
      el('td', { title: r[C.estado] || '' }, el('span', { class: 'est' }, r[C.estado_corto] || ''), el('div', { class: 'muted small clamp' }, r[C.estado] || '')),
      el('td', {}, r[C.score] ?? ''),
      el('td', {}, r[C.fuente] || ''));
  }));
}
let ft; for (const id of ['#fEmpresa', '#fEstado', '#fSeccion']) $(id).addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(renderTracker, 150); });

// ---------- vistas / login ----------
function show(view) {
  $('#login').hidden = true;
  for (const v of ['brief', 'meds', 'compras', 'gastos', 'tracker']) $('#view-' + v).hidden = v !== view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'tracker') loadTracker();
  if (view === 'meds') loadMeds(false);
  if (view === 'compras') loadShopping(false);
  if (view === 'gastos') { loadGastosMeta(false).then(() => showGastosSub(gastosSub)); }
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => brief && show(b.dataset.view)));
function showLogin() {
  for (const v of ['brief', 'meds', 'compras', 'gastos', 'tracker']) $('#view-' + v).hidden = true;
  $('#login').hidden = false; $('#pw').focus();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }), credentials: 'same-origin' });
  if (r.ok) { $('#pw').value = ''; $('#loginErr').hidden = true; start(true); } else $('#loginErr').hidden = false;
});

async function start(fresh) {
  setSync('');
  let r;
  try { r = await fetch('/api/brief', { credentials: 'same-origin', cache: fresh ? 'reload' : 'default', redirect: 'manual' }); }
  catch { setSync('Sin conexión'); return; }
  if (r.type === 'opaqueredirect') { if (!sessionStorage.getItem('mb_rl')) { sessionStorage.setItem('mb_rl', '1'); location.reload(); } else setSync('Entrá de nuevo a Vercel y recargá'); return; }
  sessionStorage.removeItem('mb_rl'); // sesión de Vercel vencida: recarga para volver a entrar
  if (r.status === 401) return showLogin();
  if (!r.ok) { setSync('Error al cargar (' + r.status + ')'); return; }
  brief = await r.json();
  renderBrief();
  const hash = (location.hash || '').slice(1);
  show(['tracker', 'meds', 'compras', 'gastos'].includes(hash) ? hash : 'brief');
  if (Object.keys(pending()).length) flush(); // reenvía lo que quedó de una sesión anterior
}
start(false);
