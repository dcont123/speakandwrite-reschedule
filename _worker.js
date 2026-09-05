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


/**
 * Speak & Write logo, inlined as base64 rather than fetched from a URL.
 *
 * Deliberate: the Worker serves the client page from our own domain and
 * nothing else, so an external image would mean an extra host to depend
 * on (and another thing that can fail or get blocked on a phone). Source
 * PNG was 418px/124KB; resized to 280px (2x the largest on-screen use)
 * and palette-reduced to 17KB, which is small enough to inline without
 * hurting page load.
 */
const LOGO_DATA_URI = 'data:image/png;base64,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';

const TARGET_URL = 'https://script.google.com/macros/s/AKfycbxe4e7faxYOTe4OHxaROHx8Y2cghG4FQOBel5HN8GBeHVQ2nKU7pSqQs3X006lbCH9U/exec';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Confirmation + decline pings from the gate screens. Proxied like any
    // other API call so the browser only ever talks to our own domain.
    if (url.pathname === '/api/confirmed') {
      return proxyJsonApi_(url, 'confirmed', ['t']);
    }
    if (url.pathname === '/api/declined') {
      return proxyJsonApi_(url, 'declined', ['t']);
    }
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
    // Hidden until the client reaches the calendar. The two gate screens
    // ask one plain question each; the full context (who, when, why) only
    // matters once they're actually choosing a time.
    '  <div id="pageHeader" style="display:none;">\n' +
    '    <div class="sw-logo corner-logo" role="img" aria-label="Speak &amp; Write Speech Pathology"></div>\n' +
    '    <div class="eyebrow">' + escapeHtml_(eyebrow) + '</div>\n' +
    '    <h1 class="pagetitle">' + title + '</h1>\n' +
    '    <p class="pagesub">' + sub + '</p>\n' +
    '    <span class="badge ' + badgeClass + '">' + escapeHtml_(badgeText) + '</span>\n' +
    '    <div class="wave"><svg viewBox="0 0 600 20" preserveAspectRatio="none"><path d="M0,10 C50,2 100,18 150,10 C200,2 250,18 300,10 C350,2 400,18 450,10 C500,2 550,18 600,10"/></svg></div>\n' +
    '  </div>\n' +

    // ---- Screen 1: acknowledge the cancellation ----
    // The client must confirm they've seen this before anything else is
    // shown. Confirmation is the signal the practice actually needs; the
    // rebooking is secondary to it.
    '  <div class="gate card" id="screenConfirm">\n' +
    '    <div class="sw-logo gate-logo" role="img" aria-label="Speak &amp; Write Speech Pathology"></div>\n' +
    '    <h2 class="gate-title">Please confirm that you understand that your session with ' + escapeHtml_(data.practitionerName) + ' has been cancelled.</h2>\n' +
    '    <button class="btn gate-btn" id="confirmSeenBtn">Confirm</button>\n' +
    '  </div>\n' +

    // ---- Screen 2: offer the rebooking ----
    '  <div class="gate card" id="screenChoice" style="display:none;">\n' +
    '    <div class="sw-logo gate-logo" role="img" aria-label="Speak &amp; Write Speech Pathology"></div>\n' +
    '    <h2 class="gate-title">Please reschedule your cancelled appointment with ' + escapeHtml_(data.practitionerName) + ' below to maintain therapy consistency for ' + escapeHtml_(data.patientFirstName) + '.</h2>\n' +
    '    <button class="btn gate-btn" id="goRebookBtn">Reschedule Appointment Now</button>\n' +
    '    <button class="btn gate-btn ghost" id="noThanksBtn">No Thanks</button>\n' +
    '  </div>\n' +

    // ---- Screen 3: the calendar (hidden until they choose to rebook) ----
    '  <div class="client-wrap" id="clientMain" style="display:none;">\n' +
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
    '  <div class="modal-backdrop" id="declineModal">\n' +
    '    <div class="modal-box">\n' +
    '      <div class="modal-tick"><svg viewBox="0 0 24 24"><path d="M4 12l5 5 11-11"/></svg></div>\n' +
    '      <p class="modal-text">Thank you for your confirmation. ' + escapeHtml_(data.practitionerFirstName) + ' will see you at your next appointment.</p>\n' +
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
    // Data URI declared once here rather than per <img>, so the ~23KB of
    // base64 appears a single time in the page instead of three times.
    '.sw-logo{background-image:url(' + LOGO_DATA_URI + ');background-size:contain;background-repeat:no-repeat;background-position:center;}' +
    '.gate-logo{display:block;width:120px;height:120px;margin:0 auto 22px;}' +
    '@media (max-width:480px){.gate-logo{width:96px;height:96px;margin-bottom:18px;}}' +
    '.corner-logo{float:right;width:60px;height:60px;margin:0 0 10px 16px;}' +
    '@media (max-width:480px){.corner-logo{width:46px;height:46px;}}' +
    '.gate{padding:38px 30px;text-align:center;max-width:560px;margin:40px auto 0;}' +
    '.gate-title{font-family:\'Fraunces\',serif;font-size:20px;font-weight:600;color:var(--purple-dark);line-height:1.4;margin:0 0 24px;}' +
    '.gate-btn{max-width:340px;margin:0 auto 10px;}' +
    '.btn.ghost{background:transparent;color:var(--purple);border:1.6px solid var(--purple-border);}' +
    '.btn.ghost:hover{background:var(--purple-bg);}' +
    '.modal-backdrop{position:fixed;inset:0;background:rgba(43,34,51,.55);z-index:100;display:none;align-items:center;justify-content:center;padding:22px;}' +
    '.modal-backdrop.show{display:flex;}' +
    '.modal-box{background:#fff;border-radius:16px;max-width:400px;width:100%;padding:32px 28px;text-align:center;box-shadow:0 24px 60px rgba(43,34,51,.35);}' +
    '.modal-tick{width:60px;height:60px;border-radius:50%;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;background:#e6f0ea;}' +
    '.modal-tick svg{width:28px;height:28px;}' +
    '.modal-tick path{stroke:var(--success);stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:40;stroke-dashoffset:40;animation:draw .5s .15s ease forwards;}' +
    '.modal-text{font-size:15px;color:var(--ink);line-height:1.55;margin:0;}' +
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
    '  // Hide the whole header, not just the wave — "let\'s find a make-up\n' +
    '  // time" reads oddly above a booking that has just been confirmed.\n' +
    '  document.getElementById("pageHeader").style.display = "none";\n' +
    '  document.getElementById("confirmScreen").classList.add("show");\n' +
    '}\n' +
    '// ---- Gate flow: confirm -> choose -> (calendar | done) ----\n' +
    'function recordEvent(action) {\n' +
    '  // Fire-and-forget: the client should never wait on tracking, and a\n' +
    '  // tracking failure must never block them from rebooking.\n' +
    '  fetch("/api/" + action + "?t=" + encodeURIComponent(TOKEN)).catch(function () {});\n' +
    '}\n' +
    'document.getElementById("confirmSeenBtn").addEventListener("click", function () {\n' +
    '  recordEvent("confirmed");\n' +
    '  document.getElementById("screenConfirm").style.display = "none";\n' +
    '  document.getElementById("screenChoice").style.display = "";\n' +
    '});\n' +
    'document.getElementById("goRebookBtn").addEventListener("click", function () {\n' +
    '  document.getElementById("screenChoice").style.display = "none";\n' +
    '  document.getElementById("pageHeader").style.display = "";\n' +
    '  document.getElementById("clientMain").style.display = "";\n' +
    '  loadSlots(); // deliberately not loaded earlier — no point fetching availability they may never look at\n' +
    '});\n' +
    'document.getElementById("noThanksBtn").addEventListener("click", function () {\n' +
    '  recordEvent("declined");\n' +
    '  document.getElementById("screenChoice").style.display = "none";\n' +
    '  document.getElementById("declineModal").classList.add("show");\n' +
    '});';
}
