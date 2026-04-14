// Car Dealer AI Dashboard
const state = {
  cars: [],
  leads: [],
  live: [],
  logs: [],
  selectedLeadId: null,
  selectedCarId: null,
  view: 'leads',
  logFilter: { level: '', source: '' },
  invFilter: { q: '', available: '' },
};

// ---- helpers ----
const $ = (sel) => document.querySelector(sel);
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])));
const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleString(); };
const fmtShort = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + d.toLocaleDateString(); };
const fmtNum = (n) => (n == null || n === '' || isNaN(Number(n))) ? '—' : Number(n).toLocaleString();
const yesNo = (v) => v === true ? 'Yes' : v === false ? 'No' : '—';

// ---- car schema helpers (Blocket vehicle_ad) ----
const ad = (c) => (c && c.vehicle_ad) ? c.vehicle_ad : null;
const carId = (c) => { const a = ad(c); return a ? String(a.id) : ''; };
const carHeading = (c) => { const a = ad(c); return a ? (a.heading || '') : ''; };
const carVehicle = (c) => { const a = ad(c); return (a && a.vehicle) ? a.vehicle : {}; };
const carPriceText = (c) => {
  const a = ad(c); if (!a || !a.price) return '—';
  const { amount, currency, suffix } = a.price;
  if (suffix) return `${fmtNum(amount)} ${suffix}`;
  if (currency) return `${fmtNum(amount)} ${currency}`;
  return fmtNum(amount);
};
const carPrimaryImage = (c) => {
  const a = ad(c); if (!a || !a.media || !a.media.images || !a.media.images.length) return '';
  const primary = a.media.images.find(i => i.is_primary) || a.media.images[0];
  return primary.url || '';
};
const carLabel = (c) => {
  const v = carVehicle(c);
  return [v.year, v.color, v.make, v.model, v.variant].filter(Boolean).join(' ') || carHeading(c) || 'Unknown vehicle';
};
const carShortLabel = (c) => {
  const v = carVehicle(c);
  return [v.year, v.make, v.model].filter(Boolean).join(' ') || carHeading(c) || 'Unknown vehicle';
};
const carLocationText = (c) => {
  const a = ad(c); if (!a || !a.location) return '—';
  const l = a.location;
  return [l.postal_name || l.municipality, l.county].filter(Boolean).join(', ') || '—';
};
const statusChip = (c) => {
  const a = ad(c); if (!a) return '';
  switch (a.ad_status) {
    case 'active':   return '<span class="chip green">Available</span>';
    case 'reserved': return '<span class="chip amber">Reserved</span>';
    case 'sold':     return '<span class="chip red">Sold</span>';
    default:         return `<span class="chip">${esc(a.ad_status || 'unknown')}</span>`;
  }
};

// ---- navigation ----
document.querySelectorAll('.nav-item').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    el.classList.add('active');
    const view = el.dataset.view;
    $('#view-' + view).classList.add('active');
    state.view = view;
  });
});

// ---- data loading ----
async function loadAll() {
  const [cars, leads, live, logs] = await Promise.all([
    fetch('/api/cars').then(r => r.json()),
    fetch('/api/leads').then(r => r.json()),
    fetch('/api/live').then(r => r.json()),
    fetch('/api/logs').then(r => r.json()),
  ]);
  state.cars = cars;
  state.leads = leads;
  state.live = live;
  state.logs = logs;
  renderAll();
}

function renderAll() {
  renderLeads();
  renderInventory();
  renderLive();
  renderLogs();
  renderBadges();
}

function renderBadges() {
  const unread = state.leads.filter(l => !l.read).length;
  $('#badge-leads').textContent = unread || state.leads.length;
  $('#badge-inventory').textContent = state.cars.length;
  const liveBadge = $('#badge-live');
  liveBadge.textContent = state.live.length;
  if (state.live.length > 0) liveBadge.classList.add('pulsing'); else liveBadge.classList.remove('pulsing');
}

// ---- leads ----
function renderLeads() {
  const list = $('#leads-list');
  if (state.leads.length === 0) {
    list.innerHTML = '<div class="empty">No leads yet. Incoming calls will appear here.</div>';
    return;
  }
  list.innerHTML = state.leads.map(l => {
    const title = l.requested_car_label || 'Unknown vehicle';
    const intent = l.intent ? `<span class="chip blue">${esc(l.intent)}</span>` : '';
    const cb = l.callback_requested ? `<span class="chip amber">Callback</span>` : '';
    const appt = l.appointment_request ? `<span class="chip purple">Visit</span>` : '';
    const unread = !l.read ? '<span class="unread-dot"></span>' : '';
    const phone = l.phone_number ? esc(l.phone_number) : '—';
    const selected = l.id === state.selectedLeadId ? 'selected' : '';
    return `
      <div class="list-item ${selected}" data-lead-id="${l.id}">
        <div class="list-item-title">${unread}${esc(title)}</div>
        <div class="list-item-sub">${fmtShort(l.created_at)} · ${phone}</div>
        <div class="pill-row">${intent}${cb}${appt}</div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-lead-id]').forEach(el => {
    el.addEventListener('click', () => openLead(el.dataset.leadId));
  });
}

async function openLead(id) {
  state.selectedLeadId = id;
  renderLeads();
  const data = await fetch(`/api/leads/${id}`).then(r => r.json());
  const { lead, call, car } = data;
  if (!lead.read) {
    fetch(`/api/leads/${id}/read`, { method: 'POST' }).catch(() => {});
  }
  const pane = $('#lead-detail');
  const transcript = call && call.transcript ? call.transcript.map(t => `
    <div class="transcript-line">
      <span class="speaker-${t.speaker === 'caller' ? 'caller' : 'ai'}">${t.speaker === 'caller' ? 'Caller' : 'AI'}:</span>
      ${esc(t.text)}
      <span class="ts">${fmtShort(t.ts)}</span>
    </div>`).join('') : '<div class="empty">No transcript</div>';

  pane.innerHTML = `
    <div class="detail-title">${esc(lead.requested_car_label || 'Unknown vehicle')}</div>
    <div class="detail-sub">${fmtTime(lead.created_at)}</div>

    <div class="detail-section">
      <h3>Matched Car</h3>
      ${car ? (() => {
        const v = carVehicle(car);
        return `
        <dl class="kv-grid">
          <dt>Listing</dt><dd>${esc(carHeading(car) || '—')}</dd>
          <dt>Make</dt><dd>${esc(v.make || '—')}</dd>
          <dt>Model</dt><dd>${esc(v.model || '—')}</dd>
          <dt>Variant</dt><dd>${esc(v.variant || '—')}</dd>
          <dt>Year</dt><dd>${esc(v.year || '—')}</dd>
          <dt>Color</dt><dd>${esc(v.color || '—')}</dd>
          <dt>Price</dt><dd>${esc(carPriceText(car))}</dd>
          <dt>Registration</dt><dd>${esc(v.registration_number || '—')}</dd>
          <dt>Mileage</dt><dd>${v.mileage_km != null ? fmtNum(v.mileage_km) + ' km' : '—'}</dd>
          <dt>Fuel</dt><dd>${esc(v.fuel || '—')}</dd>
          <dt>Location</dt><dd>${esc(carLocationText(car))}</dd>
          <dt>Status</dt><dd>${statusChip(car)}</dd>
        </dl>
      `; })() : '<div class="empty">No car matched for this enquiry</div>'}
    </div>

    <div class="detail-section">
      <h3>Lead Info</h3>
      <dl class="kv-grid">
        <dt>Customer name</dt><dd>${esc(lead.customer_name) || '—'}</dd>
        <dt>Phone</dt><dd>${esc(lead.phone_number) || '—'}</dd>
        <dt>Intent</dt><dd>${esc(lead.intent) || '—'}</dd>
        <dt>Callback requested</dt><dd>${lead.callback_requested ? 'Yes' : 'No'}</dd>
        <dt>Appointment</dt><dd>${esc(lead.appointment_request) || '—'}</dd>
        <dt>Asked availability</dt><dd>${lead.availability_question ? 'Yes' : 'No'}</dd>
        <dt>Asked damages</dt><dd>${lead.damage_question ? 'Yes' : 'No'}</dd>
        <dt>Asked price</dt><dd>${lead.price_question ? 'Yes' : 'No'}</dd>
      </dl>
    </div>

    ${lead.questions && lead.questions.length ? `
      <div class="detail-section">
        <h3>Customer Questions</h3>
        <ul class="question-list">${lead.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>
      </div>` : ''}

    ${lead.notes ? `
      <div class="detail-section">
        <h3>Notes</h3>
        <div>${esc(lead.notes)}</div>
      </div>` : ''}

    <div class="detail-section">
      <h3>Full Transcript</h3>
      <div class="transcript">${transcript}</div>
    </div>
  `;
}

// ---- inventory ----
function renderInventory() {
  const q = state.invFilter.q.toLowerCase().trim();
  const avail = state.invFilter.available;
  let filtered = state.cars;
  if (q) filtered = filtered.filter(c => {
    const v = carVehicle(c);
    const hay = [v.make, v.model, v.variant, v.registration_number, v.color, v.vin, carHeading(c)]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (avail === 'true')  filtered = filtered.filter(c => ad(c) && ad(c).ad_status === 'active');
  if (avail === 'false') filtered = filtered.filter(c => ad(c) && ad(c).ad_status !== 'active');

  const list = $('#inv-list');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">No cars match your filters</div>';
    return;
  }
  list.innerHTML = filtered.map(c => {
    const id = carId(c);
    const v = carVehicle(c);
    const selected = id === state.selectedCarId ? 'selected' : '';
    const img = carPrimaryImage(c);
    return `
      <div class="list-item inv ${selected}" data-car-id="${esc(id)}">
        <div class="inv-thumb" style="background-image:url('${esc(img)}')"></div>
        <div class="inv-body">
          <div class="list-item-title">${esc(carShortLabel(c))}</div>
          <div class="list-item-sub">${esc(v.color || '')} · ${esc(v.registration_number || '')} · ${esc(carPriceText(c))}</div>
          <div class="pill-row">
            ${statusChip(c)}
            ${v.fuel ? `<span class="chip">${esc(v.fuel)}</span>` : ''}
            ${v.transmission ? `<span class="chip">${esc(v.transmission)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-car-id]').forEach(el => {
    el.addEventListener('click', () => openCar(el.dataset.carId));
  });
}

async function openCar(id) {
  state.selectedCarId = id;
  renderInventory();
  const data = await fetch(`/api/cars/${encodeURIComponent(id)}`).then(r => r.json());
  const { car, leads: cLeads } = data;
  const pane = $('#car-detail');

  const a = ad(car) || {};
  const v = a.vehicle || {};
  const loc = a.location || {};
  const meta = a.seller_metadata || {};
  const adv = a.advertiser || {};
  const store = a.store || {};
  const img = carPrimaryImage(car);

  const leadsHtml = cLeads.length ? cLeads.map(l => `
    <div class="list-item" data-lead-id="${l.id}" style="border-radius:8px; margin-bottom:6px; border:1px solid var(--border);">
      <div class="list-item-title">${esc(l.customer_name || 'Unknown caller')} · ${esc(l.phone_number || 'no number')}</div>
      <div class="list-item-sub">${fmtShort(l.created_at)} · ${esc(l.intent || '—')}</div>
      ${l.questions?.length ? `<div style="margin-top:6px; font-size:12px;">${esc(l.questions.join(' · '))}</div>` : ''}
    </div>`).join('') : '<div class="empty">No enquiries yet</div>';

  pane.innerHTML = `
    <div class="detail-title">${esc(a.heading || carLabel(car))}</div>
    <div class="detail-sub">${esc(v.registration_number || '')} · ${esc(carLocationText(car))} · ${statusChip(car)}</div>

    ${img ? `<div style="margin:16px 0;"><img src="${esc(img)}" alt="" style="width:100%; max-height:280px; object-fit:cover; border-radius:8px; background:var(--bg-elevated-2);" onerror="this.style.display='none'"></div>` : ''}

    <div class="detail-section">
      <h3>Price</h3>
      <div style="font-size:22px; font-weight:700;">${esc(carPriceText(car))}</div>
      ${a.price && a.price.price_type ? `<div class="list-item-sub">${esc(a.price.price_type)}</div>` : ''}
    </div>

    <div class="detail-section">
      <h3>Vehicle</h3>
      <dl class="kv-grid">
        <dt>Make</dt><dd>${esc(v.make || '—')}</dd>
        <dt>Model</dt><dd>${esc(v.model || '—')}</dd>
        <dt>Variant</dt><dd>${esc(v.variant || '—')}</dd>
        <dt>Year</dt><dd>${esc(v.year || '—')}</dd>
        <dt>Color</dt><dd>${esc(v.color || '—')}</dd>
        <dt>Body type</dt><dd>${esc(v.body_type || '—')}</dd>
        <dt>Doors / Seats</dt><dd>${esc(v.doors || '—')} / ${esc(v.seats || '—')}</dd>
        <dt>Registration</dt><dd>${esc(v.registration_number || '—')}</dd>
        <dt>VIN</dt><dd style="font-family:monospace; font-size:12px;">${esc(v.vin || '—')}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <h3>Powertrain</h3>
      <dl class="kv-grid">
        <dt>Fuel</dt><dd>${esc(v.fuel || '—')}</dd>
        <dt>Transmission</dt><dd>${esc(v.transmission || '—')}</dd>
        <dt>Drivetrain</dt><dd>${esc(v.drivetrain || '—')}</dd>
        <dt>Power</dt><dd>${v.engine_power_hp != null ? esc(v.engine_power_hp) + ' hp' : '—'} ${v.engine_power_kw != null ? '(' + esc(v.engine_power_kw) + ' kW)' : ''}</dd>
        <dt>Engine size</dt><dd>${v.engine_size_cc != null ? fmtNum(v.engine_size_cc) + ' cc' : '—'}</dd>
        <dt>Mileage</dt><dd>${v.mileage_km != null ? fmtNum(v.mileage_km) + ' km' : '—'}</dd>
        <dt>Consumption</dt><dd>${v.consumption_l_100km != null ? esc(v.consumption_l_100km) + ' L/100km' : '—'}</dd>
        <dt>CO₂</dt><dd>${v.co2_g_km != null ? esc(v.co2_g_km) + ' g/km' : '—'}</dd>
        <dt>Emission class</dt><dd>${esc(v.emission_class || '—')}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <h3>Ownership & condition</h3>
      <dl class="kv-grid">
        <dt>Previous owners</dt><dd>${meta.owners_count != null ? esc(meta.owners_count) : '—'}</dd>
        <dt>Imported</dt><dd>${yesNo(meta.imported)}</dd>
        <dt>Accident-free</dt><dd>${yesNo(meta.accident_free)}</dd>
        <dt>Service book</dt><dd>${yesNo(v.service_book)}</dd>
        <dt>Inspection valid until</dt><dd>${esc(v.inspection_valid_until || '—')}</dd>
        <dt>Annual tax</dt><dd>${v.tax_annual_sek != null ? fmtNum(v.tax_annual_sek) + ' SEK' : '—'}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <h3>Equipment</h3>
      <div class="pill-row">
        ${v.towbar ? '<span class="chip blue">Towbar</span>' : ''}
        ${v.winter_tires ? '<span class="chip blue">Winter tires</span>' : ''}
        ${v.summer_tires ? '<span class="chip blue">Summer tires</span>' : ''}
        ${v.service_book ? '<span class="chip blue">Service book</span>' : ''}
      </div>
    </div>

    <div class="detail-section">
      <h3>Location</h3>
      <dl class="kv-grid">
        <dt>Postal area</dt><dd>${esc(loc.postal_code || '—')} ${esc(loc.postal_name || '')}</dd>
        <dt>Municipality</dt><dd>${esc(loc.municipality || '—')}</dd>
        <dt>County</dt><dd>${esc(loc.county || '—')}</dd>
      </dl>
    </div>

    <div class="detail-section">
      <h3>Seller</h3>
      <dl class="kv-grid">
        <dt>Name</dt><dd>${esc(adv.name || store.store_name || '—')} ${adv.is_verified ? '<span class="chip green">Verified</span>' : ''}</dd>
        <dt>Type</dt><dd>${esc(adv.type || '—')}</dd>
        <dt>Phone</dt><dd>${esc(adv.phone || '—')}</dd>
        <dt>Email</dt><dd>${esc(adv.email || '—')}</dd>
        ${store.store_url ? `<dt>Store</dt><dd><a href="${esc(store.store_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(store.store_name || store.store_url)}</a></dd>` : ''}
      </dl>
    </div>

    ${a.body ? `
    <div class="detail-section">
      <h3>Description</h3>
      <div>${esc(a.body)}</div>
    </div>` : ''}

    <div class="detail-section">
      <h3>Listing</h3>
      <dl class="kv-grid">
        <dt>Ad ID</dt><dd style="font-family:monospace;">${esc(a.id || '—')}</dd>
        <dt>Status</dt><dd>${statusChip(car)}</dd>
        <dt>Published</dt><dd>${fmtShort(a.published_at) || '—'}</dd>
        <dt>Updated</dt><dd>${fmtShort(a.updated_at) || '—'}</dd>
        ${a.canonical_url ? `<dt>Link</dt><dd><a href="${esc(a.canonical_url)}" target="_blank" rel="noopener" style="color:var(--accent)">View original listing</a></dd>` : ''}
      </dl>
    </div>

    <div class="detail-section">
      <h3>Enquiries (${cLeads.length})</h3>
      ${leadsHtml}
    </div>
  `;

  pane.querySelectorAll('[data-lead-id]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelector('.nav-item[data-view="leads"]').click();
      openLead(el.dataset.leadId);
    });
  });
}

$('#inv-search').addEventListener('input', (e) => { state.invFilter.q = e.target.value; renderInventory(); });
$('#inv-available').addEventListener('change', (e) => { state.invFilter.available = e.target.value; renderInventory(); });

// ---- live ----
function renderLive() {
  const container = $('#live-container');
  if (state.live.length === 0) {
    container.innerHTML = '<div class="no-live">No active calls right now.<br><br>When a customer calls, the live transcript will appear here in real time.</div>';
    return;
  }
  container.innerHTML = state.live.map(s => renderLiveCard(s)).join('');
}
function renderLiveCard(s) {
  const turnClass = s.turn || 'idle';
  const transcript = (s.transcript || []).slice(-12).map(t => `
    <div class="transcript-line">
      <span class="speaker-${t.speaker === 'caller' ? 'caller' : 'ai'}">${t.speaker === 'caller' ? 'Caller' : 'AI'}:</span>
      ${esc(t.text)}
    </div>`).join('');
  return `
    <div class="live-card active" data-session-id="${s.id}">
      <div class="live-header">
        <div>
          <div class="live-title">${esc(s.from)} → ${esc(s.to)}</div>
          <div class="list-item-sub">Started ${fmtShort(s.started_at)} · Call ${esc(s.id)}</div>
        </div>
        <div class="turn-indicator ${turnClass}">
          <span class="turn-dot"></span>${s.turn}
        </div>
      </div>
      <div class="detail-section">
        <h3>Matched Car</h3>
        <div>${s.matched_car_label ? esc(s.matched_car_label) : '<span style="color:var(--text-muted)">Not identified yet…</span>'}</div>
      </div>
      <div class="detail-section">
        <h3>Live Transcript</h3>
        <div class="transcript">${transcript || '<div class="empty">Waiting for caller…</div>'}
          ${s.interim ? `<div class="interim">${esc(s.interim)}…</div>` : ''}
        </div>
      </div>
    </div>`;
}

// ---- logs ----
function renderLogs() {
  const box = $('#logs-output');
  const { level, source } = state.logFilter;
  let filtered = state.logs;
  if (level) filtered = filtered.filter(l => l.level === level);
  if (source) filtered = filtered.filter(l => l.source === source);
  box.innerHTML = filtered.map(l => {
    const extras = { ...l };
    delete extras.timestamp; delete extras.level; delete extras.source; delete extras.message; delete extras.session_id;
    const extraStr = Object.keys(extras).length ? ' ' + JSON.stringify(extras) : '';
    const sid = l.session_id ? ` (session=${l.session_id})` : '';
    const line = `[${l.timestamp}] [${(l.level||'info').toUpperCase()}] [${l.source||'-'}] ${l.message}${sid}${extraStr}`;
    return `<div class="log-line ${l.level}">${esc(line)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

$('#log-level').addEventListener('change', (e) => { state.logFilter.level = e.target.value; renderLogs(); });
$('#log-source').addEventListener('change', (e) => { state.logFilter.source = e.target.value; renderLogs(); });
$('#copy-logs').addEventListener('click', () => {
  const text = $('#logs-output').innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('#copy-logs'); const orig = btn.textContent;
    btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 1200);
  });
});
$('#clear-logs').addEventListener('click', () => { state.logs = []; renderLogs(); });

// ---- SSE ----
function connectSSE() {
  const es = new EventSource('/api/stream');
  const dot = $('#sse-dot');
  const status = $('#sse-status');

  es.onopen = () => { dot.classList.add('ok'); dot.classList.remove('err'); status.textContent = 'Connected'; };
  es.onerror = () => { dot.classList.remove('ok'); dot.classList.add('err'); status.textContent = 'Reconnecting…'; };

  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleEvent(msg);
  };
}

function handleEvent(msg) {
  switch (msg.type) {
    case 'log':
      state.logs.push(msg.entry);
      if (state.logs.length > 1000) state.logs.shift();
      if (state.view === 'logs') renderLogs();
      break;
    case 'session': {
      const idx = state.live.findIndex(s => s.id === msg.session.id);
      if (msg.session.status === 'completed' || msg.session.status === 'failed') {
        if (idx !== -1) state.live.splice(idx, 1);
      } else {
        if (idx === -1) state.live.push(msg.session);
        else state.live[idx] = msg.session;
      }
      if (state.view === 'live') renderLive();
      renderBadges();
      break;
    }
    case 'session_end': {
      state.live = state.live.filter(s => s.id !== msg.call_id);
      if (state.view === 'live') renderLive();
      renderBadges();
      break;
    }
    case 'transcript': {
      const s = state.live.find(s => s.id === msg.call_id);
      if (s) {
        s.transcript = s.transcript || [];
        s.transcript.push(msg.entry);
        if (state.view === 'live') renderLive();
      }
      break;
    }
    case 'interim': {
      const s = state.live.find(s => s.id === msg.call_id);
      if (s) {
        s.interim = msg.text;
        if (state.view === 'live') renderLive();
      }
      break;
    }
    case 'lead': {
      const idx = state.leads.findIndex(l => l.id === msg.lead.id);
      if (idx === -1) state.leads.unshift(msg.lead);
      else state.leads[idx] = msg.lead;
      if (state.view === 'leads') renderLeads();
      renderBadges();
      break;
    }
  }
}

// ---- init ----
loadAll();
connectSSE();
setInterval(loadAll, 30000); // refresh safety net
