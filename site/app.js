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
function tabLink(label, url, tab) {
  return el('a', { href: url, target: tab || '_blank', onclick: (e) => {
    const w = window.open(url, tab || '_blank');
    if (w) { e.preventDefault(); try { w.focus(); } catch {} }
  } }, label);
}
function setSync(t) { $('#sync').textContent = t; }

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
  return el('li', { class: it.activo ? '' : 'done', 'data-med-cat': it.id },
    el('div', { class: 'body' },
      el('div', { class: 't' }, it.nombre),
      it.notas ? el('div', { class: 'd' }, it.notas) : null,
      el('div', { class: 'id' }, it.id)),
    it.momento ? el('span', { class: 'tag' }, MOMENTO_LABEL[it.momento] || it.momento) : null,
    el('button', {
      type: 'button',
      class: 'ghost',
      onclick: () => patchMed(it.id, { activo: !it.activo }),
    }, it.activo ? 'Desactivar' : 'Activar'),
    el('button', {
      type: 'button',
      class: 'ghost',
      onclick: () => deleteMed(it.id, it.nombre),
    }, 'Borrar'));
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
  const momento = $('#mMomento').value || null;
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
    el('button', {
      type: 'button',
      class: 'ghost',
      onclick: () => deleteShop(it.id),
    }, 'Borrar'));
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
  for (const v of ['brief', 'meds', 'compras', 'tracker']) $('#view-' + v).hidden = v !== view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (view === 'tracker') loadTracker();
  if (view === 'meds') loadMeds(false);
  if (view === 'compras') loadShopping(false);
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => brief && show(b.dataset.view)));
function showLogin() {
  for (const v of ['brief', 'meds', 'compras', 'tracker']) $('#view-' + v).hidden = true;
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
  show(['tracker', 'meds', 'compras'].includes(hash) ? hash : 'brief');
  if (Object.keys(pending()).length) flush(); // reenvía lo que quedó de una sesión anterior
}
start(false);
