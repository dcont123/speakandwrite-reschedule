/**
 * ============================================================================
 * Speak & Write — Reschedule Portal Reverse Proxy (Cloudflare Worker)
 * ============================================================================
 * Rebuilt 31 Aug 2026 after discovering the real cause of the client-side
 * loading failures: Apps Script's HtmlService doesn't serve pages
 * directly — it serves a bootstrap wrapper whose real content loads in a
 * Google-hosted SANDBOXED IFRAME (script.googleusercontent.com), which
 * the browser loads directly, completely bypassing any reverse proxy no
 * matter what the outer page's domain is. A simple fetch-and-relay Worker
 * (the previous version of this file) could not work around that — the
 * page rendered blank because the iframe's own direct request to Google
 * is exactly the kind of request that's been failing on certain devices.
 *
 * THE FIX: don't proxy Apps Script's HTML at all. Apps Script now exposes
 * a plain JSON API instead (see handleClientApiRequest_ in
 * ClientPortal.gs). This Worker:
 *   1. Renders the entire client-facing page itself, using data fetched
 *      server-to-server from that JSON API.
 *   2. Proxies the two things the page needs to do interactively —
 *      loading available times, and booking one — as JSON API calls to
 *      OUR OWN domain, which this Worker then relays to Apps Script.
 * The browser's only-ever destination, for the page itself and every
 * subsequent request, is this Worker's own domain. No Google domain is
 * ever contacted directly by the browser, at any point, in any form.
 *
 * DEPLOYMENT: Cloudflare Workers & Pages → this Worker → paste this in,
 * replacing whatever's currently deployed → Deploy.
 *
 * ⚠️ If the Apps Script deployment is ever replaced with a genuinely new
 * one, TARGET_URL below needs updating — same as RESCHEDULE_PORTAL_URL
 * in ClinicianCancellations.gs. Keep both in sync.
 * ============================================================================
 */

const TARGET_URL = 'https://script.google.com/macros/s/AKfycbxe4e7faxYOTe4OHxaROHx8Y2cghG4FQOBel5HN8GBeHVQ2nKU7pSqQs3X006lbCH9U/exec';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/slots') {
      return proxyJsonApi_(url, 'slots', ['t']);
    }
    if (url.pathname === '/api/book') {
      return proxyJsonApi_(url, 'book', ['t', 'start', 'end']);
    }
    return servePage_(url);
  },
};

/** Relays a JSON API call to Apps Script, forwarding only the specific params each action needs. */
async function proxyJsonApi_(url, action, paramNames) {
  const upstreamParams = new URLSearchParams();
  upstreamParams.set('api', action);
  paramNames.forEach(function (name) {
    const value = url.searchParams.get(name);
    if (value !== null) upstreamParams.set(name, value);
  });

  try {
    const upstream = await fetch(TARGET_URL + '?' + upstreamParams.toString());
    const body = await upstream.text();
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/** Fetches the page's real data server-to-server, then renders the whole page itself. */
async function servePage_(url) {
  const token = url.searchParams.get('t');
  if (!token) {
    return htmlResponse_(errorPageHtml_('This link is missing some details and can\'t be opened.'));
  }

  let data;
  try {
    const upstream = await fetch(TARGET_URL + '?api=page&t=' + encodeURIComponent(token));
    data = await upstream.json();
  } catch (err) {
    return htmlResponse_(errorPageHtml_('Something went wrong loading this page. Please try again in a moment.'));
  }

  if (data.error) {
    return htmlResponse_(errorPageHtml_(data.error));
  }

  // Record that the client genuinely opened their link — this ping is the
  // only reason "viewed" is knowable at all. Deliberately NOT awaited: the
  // client's page should never wait on tracking, and a tracking failure
  // must never stop the page rendering. Fired only for a real page render,
  // never for the error paths above.
  fetch(TARGET_URL + '?api=view&t=' + encodeURIComponent(token)).catch(function () {});

  return htmlResponse_(pageHtml_(data, token));
}

function htmlResponse_(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}

function errorPageHtml_(message) {
  return '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">' +
    '<p>' + escapeHtml_(message) + ' Please contact the practice.</p></body></html>';
}

function escapeHtml_(str) {
  return String(str)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

/** Builds the full client-facing page — same brand design as the original ClientPortal.html, fetch() instead of google.script.run. */
function pageHtml_(data, token) {
  const isClient = data.type === 'client';
  const eyebrow = isClient ? 'Rebooking your session' : 'Rebooking a cancelled session';
  const title = "Hi " + escapeHtml_(data.patientFirstName) + " — " + (isClient ? "let's get you rebooked" : "let's find a make-up time for your missed session");
  const sub = isClient
    ? "You let us know your session with " + escapeHtml_(data.practitionerName) + " wasn't going to work. Whenever you're ready, pick a new time below and it's locked in straight away."
    : "Your session with " + escapeHtml_(data.practitionerName) + " couldn't go ahead — " + escapeHtml_(data.practitionerName) + " is unavailable. Pick any time below and it's locked in straight away, no need to call.";
  const badgeClass = isClient ? 'gold' : 'purple';
  const badgeText = isClient ? 'You cancelled this session' : 'Cancelled by the clinic';

  return '<!DOCTYPE html>\n<html>\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">\n' +
    '<title>Speak &amp; Write — Reschedule</title>\n' +
    '<style>' + pageCss_() + '</style>\n' +
    '</head>\n<body>\n' +
    '<div class="stage">\n' +
    '  <div class="eyebrow">' + escapeHtml_(eyebrow) + '</div>\n' +
    '  <h1 class="pagetitle">' + title + '</h1>\n' +
    '  <p class="pagesub">' + sub + '</p>\n' +
    '  <span class="badge ' + badgeClass + '">' + escapeHtml_(badgeText) + '</span>\n' +
    '  <div class="wave"><svg viewBox="0 0 600 20" preserveAspectRatio="none"><path d="M0,10 C50,2 100,18 150,10 C200,2 250,18 300,10 C350,2 400,18 450,10 C500,2 550,18 600,10"/></svg></div>\n' +
    '  <div class="client-wrap" id="clientMain">\n' +
    '    <div class="clinician-card card">\n' +
    '      <div class="avatar">' + escapeHtml_(data.practitionerInitials) + '</div>\n' +
    '      <h3>' + escapeHtml_(data.practitionerName) + '</h3>\n' +
    '      <div class="role">' + escapeHtml_(data.practitionerProfession) + '</div>\n' +
    (data.locationName ? '      <div class="meta-row"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 12h18M3 6h18M3 18h18" stroke="#9B6FC5" stroke-width="2" stroke-linecap="round"/></svg>' + escapeHtml_(data.locationName) + '</div>\n' : '') +
    (data.serviceDuration ? '      <div class="meta-row"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#9B6FC5" stroke-width="2"/><path d="M12 7v5l3 3" stroke="#9B6FC5" stroke-width="2" stroke-linecap="round"/></svg>' + escapeHtml_(data.serviceDuration) + '-minute session</div>\n' : '') +
    (data.serviceName ? '      <div class="meta-row"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 12c1.5-4 2.5-4 4 0s2.5 4 4 0 2.5-4 4 0 2.5 4 4 0" stroke="#9B6FC5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' + escapeHtml_(data.serviceName) + '</div>\n' : '') +
    (data.originalTimeDisplay ?
      '      <div class="original-time-box">' +
        '<div class="otb-label">' + escapeHtml_(data.patientFirstName) + '\'s cancelled time was</div>' +
        '<div class="otb-value">' + escapeHtml_(data.originalTimeDisplay) + '</div>' +
      '</div>\n' +
      '      <p class="otb-instruction">Choose a make-up time from the calendar.</p>\n'
    : '') +
    '      <div style="margin-top:14px;"><span class="badge purple">This link is just for ' + escapeHtml_(data.patientFirstName) + '</span></div>\n' +
    '    </div>\n' +
    '    <div class="slots-card card">\n' +
    '      <div id="loadingState" class="state">Finding available times…</div>\n' +
    '      <div id="emptyState" class="state" style="display:none;">No times available in the next 7 days — please contact the practice directly.</div>\n' +
    '      <div id="pickerArea" style="display:none;">\n' +
    '        <div class="slots-head"><h3>Choose a session make-up time</h3></div>\n' +
    '        <div class="day-tabs" id="dayTabs"></div>\n' +
    '        <div class="slot-grid" id="slotGrid"></div>\n' +
    '        <div class="legend">\n' +
    '          <span><i style="background:#fff; border:1.4px solid #ece4f3;"></i> Standard opening</span>\n' +
    '          <span><i style="background:var(--gold-soft); border:1.4px solid var(--gold);"></i> Extra availability</span>\n' +
    '          <span><i style="background:#e6f5ec; border:1.4px solid #5ba97a;"></i> Usual time</span>\n' +
    '        </div>\n' +
    '        <div class="cta-row">\n' +
    '          <button class="btn" id="confirmBtn" disabled>Confirm new time</button>\n' +
    '          <span class="hint" id="pickedHint">Select a time above</span>\n' +
    '        </div>\n' +
    '        <div class="error-box" id="errorBox"></div>\n' +
    '      </div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="card confirm" id="confirmScreen">\n' +
    '    <div class="ring"><svg viewBox="0 0 24 24"><path d="M4 12l5 5 11-11"/></svg></div>\n' +
    '    <h3>You\'re booked in</h3>\n' +
    '    <p>A confirmation has been sent. This slot is now reserved for ' + escapeHtml_(data.patientFirstName) + ' — nothing else to do.</p>\n' +
    '    <div class="detail"><b id="confDetail">—</b><span>with ' + escapeHtml_(data.practitionerName) + (data.locationName ? ' · ' + escapeHtml_(data.locationName) : '') + '</span></div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<script>' + pageJs_(token) + '</script>\n' +
    '</body>\n</html>';
}

function pageCss_() {
  return ':root{--purple:#653494;--purple-dark:#4A2470;--purple-bg:#EEE5F7;--purple-border:#9B6FC5;--gold:#b29d66;--ink:#2b2233;--ink-soft:#6b5f77;--paper:#FBF9FC;--white:#ffffff;--success:#4a8f6b;--shadow:0 1px 2px rgba(74,36,112,0.06),0 8px 24px rgba(74,36,112,0.08);}' +
    '*{box-sizing:border-box;}html,body{margin:0;padding:0;}body{font-family:"Plus Jakarta Sans",sans-serif;background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased;}' +
    '.stage{max-width:680px;margin:0 auto;padding:32px 20px 64px;}@media (max-width:480px){.stage{padding:20px 14px 48px;}}' +
    '.eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);}' +
    '.pagetitle{font-family:"Fraunces",serif;font-size:27px;font-weight:600;color:var(--purple-dark);margin:4px 0 0;}' +
    '.pagesub{color:var(--ink-soft);font-size:14px;margin-top:8px;line-height:1.55;}' +
    '.badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;letter-spacing:.02em;padding:4px 9px;border-radius:99px;margin-top:10px;}' +
    '.badge.gold{background:#efe6d3;color:#7a6636;}.badge.purple{background:var(--purple-bg);color:var(--purple-dark);}' +
    '.wave{width:100%;height:20px;margin:20px 0 26px;overflow:hidden;}.wave svg{display:block;width:100%;height:20px;}.wave path{stroke:var(--gold);stroke-width:1.6;fill:none;opacity:.85;}' +
    '.card{background:var(--white);border:1px solid #ece4f3;border-radius:14px;box-shadow:var(--shadow);}' +
    '.client-wrap{display:grid;grid-template-columns:1fr;gap:18px;}@media (min-width:560px){.client-wrap{grid-template-columns:220px 1fr;}}' +
    '.clinician-card{padding:20px;text-align:left;}' +
    '.avatar{width:52px;height:52px;border-radius:50%;flex:none;background:linear-gradient(135deg,var(--purple),var(--purple-dark));color:#fff;display:flex;align-items:center;justify-content:center;font-family:"Fraunces",serif;font-weight:600;font-size:19px;margin-bottom:12px;}' +
    '.clinician-card h3{font-family:"Fraunces",serif;font-size:18px;margin:0 0 2px;color:var(--purple-dark);}.clinician-card .role{font-size:12.5px;color:var(--ink-soft);margin-bottom:14px;}' +
    '.meta-row{display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--ink-soft);padding:7px 0;border-top:1px solid #f1eaf7;}.meta-row:first-of-type{border-top:none;}.meta-row svg{flex:none;opacity:.6;}' +
    '.original-time-box{background:#e6f5ec;border:1.4px solid #a8d9bc;border-radius:10px;padding:11px 13px;margin-top:12px;}' +
    '.original-time-box .otb-label{font-size:11.5px;font-weight:600;color:#3d7a58;}' +
    '.original-time-box .otb-value{font-family:\'Fraunces\',serif;font-size:16px;font-weight:600;color:#2d5f42;margin-top:2px;}' +
    '.otb-instruction{font-size:12px;color:var(--ink-soft);margin:8px 0 0;}' +
    '.slots-card{padding:20px 22px 24px;}.slots-head h3{font-family:"Fraunces",serif;font-size:18px;margin:0;color:var(--purple-dark);}' +
    '.day-tabs{display:flex;gap:6px;margin:16px 0 18px;overflow-x:auto;padding-bottom:2px;}' +
    '.day-tab{all:unset;box-sizing:border-box;cursor:pointer;text-align:center;flex:none;padding:9px 14px;border-radius:10px;font-size:12.5px;font-weight:600;color:var(--ink-soft);border:1px solid #ece4f3;min-width:56px;transition:all .15s ease;}' +
    '.day-tab .d{display:block;font-size:10px;opacity:.75;font-weight:600;text-transform:uppercase;}.day-tab .n{display:block;font-family:"Fraunces",serif;font-size:16px;margin-top:2px;color:var(--purple-dark);}' +
    '.day-tab.sel{background:var(--purple);border-color:var(--purple);}.day-tab.sel .d,.day-tab.sel .n{color:#fff;}' +
    '.slot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));column-gap:9px;row-gap:22px;}' +
    '.slot{all:unset;box-sizing:border-box;cursor:pointer;padding:12px 8px;border-radius:10px;text-align:center;border:1.4px solid #ece4f3;font-weight:700;font-size:13.5px;color:var(--purple-dark);position:relative;transition:transform .12s ease,border-color .12s ease,background .12s ease;}' +
    '.slot:hover{border-color:var(--purple-border);transform:translateY(-1px);}.slot.opened{border-color:var(--gold);background:#efe6d3;}' +
    '.slot.opened::after{content:"";position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--gold);}.slot.sel{background:var(--purple);border-color:var(--purple);color:#fff;}' +
    '.slot.preferred{border-color:#5ba97a;background:#e6f5ec;color:#2d5f42;overflow:visible;}' +
    '.slot.preferred::before{content:"Usual time";position:absolute;top:-9px;left:50%;transform:translateX(-50%);font-size:8.5px;font-weight:700;background:#4a8f6b;color:#fff;padding:2px 7px;border-radius:99px;white-space:nowrap;}' +
    '.slot.preferred.sel{background:#4a8f6b;border-color:#4a8f6b;color:#fff;}' +
    '.legend{display:flex;gap:16px;margin-top:16px;font-size:12px;color:var(--ink-soft);flex-wrap:wrap;}.legend span{display:inline-flex;align-items:center;gap:6px;}.legend i{width:9px;height:9px;border-radius:3px;display:inline-block;}' +
    '.cta-row{margin-top:22px;}.btn{all:unset;box-sizing:border-box;cursor:pointer;font-family:"Plus Jakarta Sans",sans-serif;font-weight:700;font-size:13.5px;padding:13px 22px;border-radius:10px;text-align:center;display:block;width:100%;background:var(--purple);color:#fff;transition:background .15s ease,transform .1s ease,opacity .15s;}' +
    '.btn:hover{background:var(--purple-dark);}.btn:active{transform:scale(.98);}.btn[disabled]{opacity:.4;pointer-events:none;}' +
    '.hint{font-size:12px;color:var(--ink-soft);text-align:center;display:block;margin-top:10px;}' +
    '.state{text-align:center;padding:50px 20px;color:var(--ink-soft);font-size:14px;}' +
    '.error-box{background:#fbeee9;border:1px solid #e3b9a4;color:#8a4632;border-radius:10px;padding:14px 16px;font-size:13.5px;margin-top:14px;display:none;}.error-box.show{display:block;}' +
    '.confirm{display:none;text-align:center;padding:46px 20px 30px;}.confirm.show{display:block;}' +
    '.confirm .ring{width:74px;height:74px;border-radius:50%;margin:0 auto 20px;position:relative;display:flex;align-items:center;justify-content:center;background:#e6f0ea;}.confirm .ring svg{width:32px;height:32px;}' +
    '.confirm .ring path{stroke:var(--success);stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:40;stroke-dashoffset:40;animation:draw .5s .25s ease forwards;}@keyframes draw{to{stroke-dashoffset:0;}}' +
    '.confirm h3{font-family:"Fraunces",serif;font-size:22px;color:var(--purple-dark);margin:0 0 8px;}.confirm p{color:var(--ink-soft);font-size:13.5px;max-width:340px;margin:0 auto 22px;}' +
    '.confirm .detail{display:inline-flex;flex-direction:column;gap:2px;background:var(--purple-bg);border-radius:12px;padding:14px 26px;margin-bottom:10px;}' +
    '.confirm .detail b{font-family:"Fraunces",serif;font-size:16px;color:var(--purple-dark);}.confirm .detail span{font-size:12px;color:var(--ink-soft);}';
}

function pageJs_(token) {
  // token is a base64url string (safe alphanumerics + - _) — safe to inline directly, but JSON.stringify anyway for a hard guarantee against any injection.
  return 'const TOKEN = ' + JSON.stringify(token) + ';\n' +
    'let daysData = []; let activeDayIdx = 0; let selectedSlot = null;\n' +
    'function loadSlots() {\n' +
    '  fetch("/api/slots?t=" + encodeURIComponent(TOKEN))\n' +
    '    .then(function (r) { return r.json(); })\n' +
    '    .then(onSlotsLoaded)\n' +
    '    .catch(onLoadError);\n' +
    '}\n' +
    'function onLoadError(err) {\n' +
    '  document.getElementById("loadingState").textContent = "Something went wrong loading available times. Please contact the practice.";\n' +
    '  console.error(err);\n' +
    '}\n' +
    'function onSlotsLoaded(days) {\n' +
    '  daysData = days || [];\n' +
    '  document.getElementById("loadingState").style.display = "none";\n' +
    '  if (daysData.length === 0) { document.getElementById("emptyState").style.display = "block"; return; }\n' +
    '  document.getElementById("pickerArea").style.display = "block";\n' +
    '  renderDayTabs(); renderSlots();\n' +
    '}\n' +
    'function renderDayTabs() {\n' +
    '  const el = document.getElementById("dayTabs");\n' +
    '  el.innerHTML = daysData.map(function (d, i) {\n' +
    '    return \'<button class="day-tab \' + (i === activeDayIdx ? "sel" : "") + \'" data-i="\' + i + \'"><span class="d">\' + d.dayOfWeek + \'</span><span class="n">\' + d.dayNumber + \'</span></button>\';\n' +
    '  }).join("");\n' +
    '  Array.prototype.forEach.call(el.querySelectorAll(".day-tab"), function (btn) {\n' +
    '    btn.addEventListener("click", function () {\n' +
    '      activeDayIdx = Number(btn.dataset.i); selectedSlot = null;\n' +
    '      renderDayTabs(); renderSlots(); updateCta();\n' +
    '    });\n' +
    '  });\n' +
    '}\n' +
    'function formatTime(iso) { return new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }); }\n' +
    'function renderSlots() {\n' +
    '  const el = document.getElementById("slotGrid");\n' +
    '  const slots = daysData[activeDayIdx].slots;\n' +
    '  el.innerHTML = slots.map(function (s, i) {\n' +
    '    const isOverride = s.source === "override"; const isSel = selectedSlot === s; const isPreferred = !!s.isPreferredTime;\n' +
    '    const cls = (isOverride ? "opened " : "") + (isPreferred ? "preferred " : "") + (isSel ? "sel" : "");\n' +
    '    const title = isPreferred ? \' title="Your usual time"\' : "";\n' +
    '    return \'<button class="slot \' + cls + \'" data-i="\' + i + \'"\' + title + \'>\' + formatTime(s.start) + "</button>";\n' +
    '  }).join("");\n' +
    '  Array.prototype.forEach.call(el.querySelectorAll(".slot"), function (btn) {\n' +
    '    btn.addEventListener("click", function () { selectedSlot = slots[Number(btn.dataset.i)]; renderSlots(); updateCta(); });\n' +
    '  });\n' +
    '}\n' +
    'function updateCta() {\n' +
    '  const btn = document.getElementById("confirmBtn"); const hint = document.getElementById("pickedHint");\n' +
    '  if (selectedSlot) {\n' +
    '    btn.disabled = false;\n' +
    '    hint.textContent = daysData[activeDayIdx].dayOfWeek + " " + daysData[activeDayIdx].dayNumber + " · " + formatTime(selectedSlot.start) + " selected";\n' +
    '  } else { btn.disabled = true; hint.textContent = "Select a time above"; }\n' +
    '}\n' +
    'document.getElementById("confirmBtn").addEventListener("click", function () {\n' +
    '  if (!selectedSlot) return;\n' +
    '  const btn = this; btn.disabled = true; btn.textContent = "Booking…";\n' +
    '  document.getElementById("errorBox").classList.remove("show");\n' +
    '  const params = new URLSearchParams({ t: TOKEN, start: selectedSlot.start, end: selectedSlot.end });\n' +
    '  fetch("/api/book?" + params.toString())\n' +
    '    .then(function (r) { return r.json(); })\n' +
    '    .then(function (result) {\n' +
    '      if (!result.success) throw new Error(result.error || "booking failed");\n' +
    '      onBooked(selectedSlot);\n' +
    '    })\n' +
    '    .catch(function (err) {\n' +
    '      btn.disabled = false; btn.textContent = "Confirm new time";\n' +
    '      const box = document.getElementById("errorBox");\n' +
    '      box.textContent = "That time couldn\'t be booked — it may have just been taken. Refreshing available times…";\n' +
    '      box.classList.add("show");\n' +
    '      console.error(err);\n' +
    '      selectedSlot = null;\n' +
    '      loadSlots();\n' +
    '    });\n' +
    '});\n' +
    'function onBooked(slot) {\n' +
    '  document.getElementById("confDetail").textContent = new Date(slot.start).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) + " · " + formatTime(slot.start);\n' +
    '  document.getElementById("clientMain").style.display = "none";\n' +
    '  document.querySelector(".wave").style.display = "none";\n' +
    '  document.getElementById("confirmScreen").classList.add("show");\n' +
    '}\n' +
    'loadSlots();';
}
