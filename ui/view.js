// Shared views: the history timeline and a request/response detail panel.
// Used by the full GUI, the MCP App view inside the agent's reply, and the
// self-contained HTML report. No dependencies, no storage, no network.
(function () {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const parsed = (b) => { try { return JSON.parse(b); } catch { return undefined; } };
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  const size = (n) => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`;
  const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const hm = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dur = (ms) => ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`;
  const gapText = (ms) => ms < 3600000 ? `${Math.round(ms / 60000)} min later` : ms < 86400000 ? `${(ms / 3600000).toFixed(ms < 36000000 ? 1 : 0)} h later` : `${Math.round(ms / 86400000)} days later`;
  const REASON = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 422: "Unprocessable", 429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Unavailable", 504: "Gateway Timeout" };
  const failed = (c) => !!c.error || c.status >= 400 || (c.expect_status && c.status !== c.expect_status);
  const mismatch = (c) => c.validation && c.validation.checked && !c.validation.valid;
  const stClass = (c) => (c.error ? "st-fail" : c.status ? "st-" + String(c.status)[0] : "");
  const nameOf = (c) => (c.item_name ? c.item_name.split(" / ").slice(1).join(" / ") || c.item_name : pathOf(c.url));
  const dayKey = (ts) => new Date(ts).toDateString();
  function dayLabel(ts) {
    const d = new Date(ts), today = new Date(), y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  }
  const SEGMENT_GAP = 30 * 60 * 1000; // a run with a gap longer than this is shown as separate sessions
  const SHOW_GAP = 5 * 60 * 1000;     // gaps worth marking inside a session

  // Group calls into days, then sessions (consecutive calls of one run).
  function group(calls, runs) {
    const asc = [...calls].sort((a, b) => new Date(a.ts) - new Date(b.ts) || a.id - b.id);
    const segments = [];
    const open = new Map();
    for (const c of asc) {
      const t = new Date(c.ts).getTime();
      let seg = open.get(c.run_id ?? "none");
      if (!seg || t - seg.end > SEGMENT_GAP || dayKey(seg.start) !== dayKey(t)) {
        const r = runs[c.run_id] || {};
        seg = { run: c.run_id, name: r.name || (c.source === "agent" ? "Agent" : "Requests"), source: r.source || c.source, calls: [], start: t, end: t, continued: !!open.get(c.run_id ?? "none") };
        open.set(c.run_id ?? "none", seg);
        segments.push(seg);
      }
      seg.calls.push(c);
      seg.end = Math.max(seg.end, t + (c.duration_ms || 0));
    }
    segments.sort((a, b) => b.start - a.start);
    const days = [];
    for (const s of segments) {
      const k = dayKey(s.start);
      let d = days[days.length - 1];
      if (!d || d.key !== k) { d = { key: k, label: dayLabel(s.start), segments: [] }; days.push(d); }
      d.segments.push(s);
    }
    return days;
  }

  // Histogram of the visible range: one column per bucket, split ok/failed.
  function overview(calls) {
    if (calls.length < 2) return "";
    const ts = calls.map((c) => new Date(c.ts).getTime());
    const min = Math.min(...ts), max = Math.max(...ts);
    if (max - min < 120000) return ""; // all within a couple of minutes: nothing to show
    const span = Math.max(max - min, 60000);
    const n = 60;
    const buckets = Array.from({ length: n }, () => ({ ok: 0, bad: 0, first: null }));
    calls.forEach((c, i) => {
      const b = buckets[Math.min(n - 1, Math.floor(((ts[i] - min) / span) * n))];
      failed(c) ? b.bad++ : b.ok++;
      if (b.first === null || c.id < b.first) b.first = c.id;
    });
    const peak = Math.max(...buckets.map((b) => b.ok + b.bad), 1);
    const cols = buckets.map((b, i) => {
      const tot = b.ok + b.bad;
      if (!tot) return `<span class="av-col empty"></span>`;
      const h = 6 + (tot / peak) * 34;
      const at = new Date(min + (i / n) * span);
      return `<button class="av-col" data-jump="${b.first}" title="${tot} request${tot === 1 ? "" : "s"} around ${esc(hm(at))}${b.bad ? `, ${b.bad} failed` : ""}" style="height:${h}px">${b.bad ? `<i class="bad" style="height:${(b.bad / tot) * 100}%"></i>` : ""}</button>`;
    }).join("");
    const label = (t) => (dayKey(t) === dayKey(Date.now()) ? hm(t) : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + hm(t));
    return `<div class="av-overview" aria-label="Requests over time"><div class="av-cols">${cols}</div><div class="av-axis"><span>${esc(label(min))}</span><span>${esc(label(max))}</span></div></div>`;
  }

  function row(c, slowest, opts) {
    const bad = failed(c);
    const w = Math.max(2, Math.round(((c.duration_ms || 0) / slowest) * 100));
    const chips = [
      c.source === "agent" && opts.markAgent ? `<span class="av-chip agent">Agent</span>` : "",
      c.expect_status && c.status !== c.expect_status ? `<span class="av-chip bad">expected ${c.expect_status}</span>` : "",
      mismatch(c) ? `<span class="av-chip schema">schema</span>` : "",
    ].join("");
    return `<button class="av-row${bad ? " is-bad" : ""}" data-call="${c.id}" aria-expanded="false" title="${esc(c.method + " " + c.url)}">
      <span class="av-time">${esc(clock(c.ts))}</span>
      <span class="av-m m-${esc(c.method)}">${esc(c.method)}</span>
      <span class="av-name"><span class="av-n">${esc(nameOf(c))}</span><span class="av-host">${esc(hostOf(c.url))}${c.note ? ", " + esc(c.note) : ""}</span></span>
      <span class="av-chips">${chips}</span>
      <span class="av-st ${stClass(c)}">${c.error ? "Failed" : esc(c.status)}</span>
      <span class="av-track" aria-hidden="true"><i class="${bad ? "bad" : stClass(c)}" style="width:${w}%"></i></span>
      <span class="av-ms">${c.duration_ms != null ? esc(dur(c.duration_ms)) : ""}</span>
    </button><div class="av-detail" data-detail="${c.id}" hidden></div>`;
  }

  function segmentCard(s, opts) {
    const fails = s.calls.filter(failed).length;
    const slowest = Math.max(...s.calls.map((c) => c.duration_ms || 0), 1);
    const kind = s.source === "agent" ? "Agent" : /^Run:/.test(s.name) ? "Collection run" : "You";
    const limit = opts.rowsPerSession ?? 8;
    let html = "", prev = null;
    s.calls.forEach((c, i) => {
      const t = new Date(c.ts).getTime();
      if (prev !== null && t - prev > SHOW_GAP) html += `<div class="av-gap${i >= limit ? " av-more" : ""}"${i >= limit ? " hidden" : ""}>${esc(gapText(t - prev))}</div>`;
      const r = row(c, slowest, { ...opts, markAgent: opts.markAgent && s.source !== "agent" });
      html += i >= limit ? `<div class="av-more" hidden>${r}</div>` : r;
      prev = t;
    });
    const more = s.calls.length - limit;
    return `<section class="av-seg${fails ? " has-bad" : ""}" data-seg>
      <span class="av-dot" aria-hidden="true"></span>
      <header class="av-seg-h">
        <div><span class="av-kind k-${kind === "Agent" ? "agent" : kind === "You" ? "you" : "run"}">${kind}</span> <strong>${esc(s.name)}</strong>${s.continued ? ` <span class="av-faint">(continued)</span>` : ""}</div>
        <div class="av-faint">${esc(hm(s.start))}${s.end - s.start > 60000 ? "–" + esc(hm(s.end)) : ""}, ${s.calls.length} request${s.calls.length === 1 ? "" : "s"}${fails ? `, <span class="av-badtext">${fails} failed</span>` : ""}</div>
      </header>
      <div class="av-rows">${html}</div>
      ${more > 0 ? `<button class="av-showmore" data-showmore>Show ${more} more</button>` : ""}
    </section>`;
  }

  // Timeline. opts: { onSelect(id, rowEl, detailEl), filters: true, markAgent: true, title, actions: html, emptyText }
  function timeline(el, data, opts = {}) {
    const state = el.__av || (el.__av = { range: opts.range || "all", who: "all", q: "" });
    const runs = data.runs || {};
    const now = Date.now();
    const since = { hour: now - 3600000, today: new Date(new Date().toDateString()).getTime(), week: now - 7 * 86400000, all: 0 }[state.range];
    const q = state.q.toLowerCase().trim();
    const calls = (data.calls || []).filter((c) => {
      if (new Date(c.ts).getTime() < since) return false;
      if (state.who === "agent" && c.source !== "agent") return false;
      if (state.who === "you" && c.source === "agent") return false;
      if (state.who === "failed" && !failed(c)) return false;
      if (q && ![c.url, c.item_name, c.note, c.method, c.status].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const total = calls.length, bad = calls.filter(failed).length;
    const pill = (group, k, l) => `<button class="av-pill" data-${group}="${k}" aria-pressed="${state[group === "range" ? "range" : "who"] === k}">${l}</button>`;
    const head = `<div class="av-head">
      <div class="av-title"><h2>${esc(opts.title || "Request history")}</h2><span class="av-faint">${total} request${total === 1 ? "" : "s"}${bad ? `, <span class="av-badtext">${bad} failed</span>` : ""}</span>${opts.actions || ""}</div>
      ${opts.filters === false ? "" : `<div class="av-filters">
        <div class="av-pills" role="group" aria-label="Time range">${pill("range", "hour", "Last hour")}${pill("range", "today", "Today")}${pill("range", "week", "7 days")}${pill("range", "all", "All")}</div>
        <div class="av-pills" role="group" aria-label="Who">${pill("who", "all", "Everyone")}${pill("who", "agent", "Agent")}${pill("who", "you", "You")}${pill("who", "failed", "Failed")}</div>
        <input class="av-search" type="search" placeholder="Filter by URL, name or status" aria-label="Filter" value="${esc(state.q)}">
      </div>`}
      ${overview(calls)}
    </div>`;
    const days = group(calls, runs);
    const body = days.length ? days.map((d) => `<div class="av-day"><h3 class="av-day-h"><span>${esc(d.label)} <span class="av-count">(${d.segments.reduce((n, x) => n + x.calls.length, 0)})</span></span></h3>${d.segments.map((s) => segmentCard(s, { markAgent: opts.markAgent !== false, rowsPerSession: opts.rowsPerSession })).join("")}</div>`).join("")
      : `<div class="av-empty">${esc(opts.emptyText || (data.calls?.length ? "No requests match these filters." : "No requests yet. Everything you or your agent send will appear here."))}</div>`;
    const focused = document.activeElement?.classList?.contains("av-search");
    el.classList.add("av");
    el.innerHTML = head + `<div class="av-line">${body}</div>`;
    if (focused) { const s = el.querySelector(".av-search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }

    el.onclick = (e) => {
      const p = e.target.closest("[data-range],[data-who]");
      if (p) { if (p.dataset.range) state.range = p.dataset.range; if (p.dataset.who) state.who = p.dataset.who; return timeline(el, data, opts); }
      const more = e.target.closest("[data-showmore]");
      if (more) { more.closest("[data-seg]").querySelectorAll(".av-more").forEach((n) => (n.hidden = false)); more.remove(); return; }
      const jump = e.target.closest("[data-jump]");
      if (jump) {
        const r = el.querySelector(`[data-call="${jump.dataset.jump}"]`);
        if (r) { r.closest(".av-more")?.removeAttribute("hidden"); r.scrollIntoView({ block: "center", behavior: "smooth" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 1200); }
        return;
      }
      const r = e.target.closest("[data-call]");
      if (r && opts.onSelect) {
        const id = Number(r.dataset.call);
        const det = el.querySelector(`[data-detail="${id}"]`);
        opts.onSelect(id, r, det);
      }
    };
    const s = el.querySelector(".av-search");
    if (s) s.oninput = () => { state.q = s.value; clearTimeout(state.t); state.t = setTimeout(() => timeline(el, data, opts), 150); };
  }

  // Toggle an inline detail panel under a row (report and agent views).
  function toggleInline(rowEl, detEl, call) {
    const open = detEl.hidden;
    detEl.hidden = !open;
    rowEl.setAttribute("aria-expanded", String(open));
    if (open && call) detail(detEl, call, {});
  }

  /* ---------- request / response detail ---------- */
  function tree(data, depth = 0, key = null, path = "", marks = new Set()) {
    const k = key !== null ? `<span class="j-k">${esc(key)}</span>: ` : "";
    const mark = path && marks.has(path) ? " j-err" : "";
    if (data === null || typeof data !== "object") {
      const cls = data === null ? "j-null" : typeof data === "string" ? "j-str" : typeof data === "number" ? "j-num" : "j-bool";
      return `<div class="j-leaf${mark}">${k}<span class="${cls}">${esc(typeof data === "string" ? JSON.stringify(data) : String(data))}</span></div>`;
    }
    const arr = Array.isArray(data);
    const entries = arr ? data.map((v, i) => [i, v]) : Object.entries(data);
    const label = arr ? `[${entries.length}]` : `{${entries.length}}`;
    const inner = entries.slice(0, 300).map(([ck, cv]) => tree(cv, depth + 1, ck, `${path}/${ck}`, marks)).join("") + (entries.length > 300 ? `<div class="j-leaf av-faint">… ${entries.length - 300} more</div>` : "");
    return `<details class="j${mark}" ${depth < 2 || marks.size ? "open" : ""}><summary>${k}<span class="av-faint">${label}</span></summary>${inner}</details>`;
  }
  const body = (b, marks) => { if (!b) return `<p class="av-faint">Empty</p>`; const p = parsed(b); return p !== undefined ? `<div class="j-tree">${tree(p, 0, null, "", marks)}</div>` : `<pre class="av-pre">${esc(b)}</pre>`; };
  const kv = (h) => { const e = Object.entries(h || {}); return e.length ? `<dl class="av-kv">${e.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join("\n") : v)}</dd>`).join("")}</dl>` : `<p class="av-faint">None</p>`; };

  // opts: { tab, onOpenGui }
  function detail(el, c, opts = {}) {
    const tab = el.__tab || opts.tab || "response";
    const marks = new Set((c.validation?.errors || []).map((e) => e.path));
    const head = `<div class="av-dhead">
      <div class="av-dline"><span class="av-m m-${esc(c.method)}">${esc(c.method)}</span> <span class="av-url">${esc(c.url)}</span></div>
      <div class="av-dmeta">${c.error ? `<span class="av-st st-fail">Failed</span>` : `<span class="av-st ${stClass(c)}">${esc(c.status)} ${esc(REASON[c.status] || "")}</span>`}
        <span>${esc(dur(c.duration_ms || 0))}</span>${c.res_size != null ? `<span>${esc(size(c.res_size))}</span>` : ""}
        ${c.expect_status ? `<span class="av-chip ${c.status === c.expect_status ? "good" : "bad"}">${c.status === c.expect_status ? "Expected " + c.expect_status : `Expected ${c.expect_status}`}</span>` : ""}
        ${mismatch(c) ? `<span class="av-chip schema">${c.validation.errors.length} schema mismatch${c.validation.errors.length === 1 ? "" : "es"}</span>` : ""}
        <span class="av-faint">#${c.id}</span><span class="av-faint">${esc(new Date(c.ts).toLocaleString("en-GB"))}${c.source === "agent" ? ", by agent" : ""}</span></div>
      ${c.item_name ? `<div class="av-faint">${esc(c.item_name)}</div>` : ""}
      ${c.note ? `<div class="av-note">${c.source === "agent" ? "Agent's note: " : ""}${esc(c.note)}</div>` : ""}
      ${c.captured ? `<div class="av-faint">Saved ${Object.keys(c.captured).map((k) => `{{${esc(k.replace(/^(header|var):/, ""))}}}`).join(", ")}</div>` : ""}
    </div>`;
    const tabs = [["response", "Response"], ["request", "Request sent"], ["headers", "Headers"], ...(mismatch(c) ? [["schema", "Schema"]] : [])];
    const nav = `<div class="av-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="av-tab" data-tab="${k}" aria-selected="${k === tab}">${l}</button>`).join("")}${opts.onOpenGui ? `<button class="av-link" data-gui>Open in jodrell</button>` : ""}</div>`;
    let pane = "";
    if (tab === "response") pane = c.error ? `<p class="av-badtext">${esc(c.error)}</p>` : body(c.res_body, marks) + (c.truncated ? `<p class="av-faint">Body shortened for this view.</p>` : "");
    if (tab === "request") pane = `<pre class="av-pre">${esc(c.method + " " + c.url)}</pre><h4>Headers</h4>${kv(c.req_headers)}${c.req_body ? `<h4>Body</h4>${body(c.req_body)}` : ""}`;
    if (tab === "headers") pane = kv(c.res_headers);
    if (tab === "schema") pane = `<ul class="av-issues">${c.validation.errors.map((e) => `<li><code>${esc(e.path)}</code> ${esc(e.message)}</li>`).join("")}</ul>`;
    el.innerHTML = head + nav + `<div class="av-pane">${pane}</div>`;
    el.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); el.__tab = b.dataset.tab; detail(el, c, opts); }));
    el.querySelector("[data-gui]")?.addEventListener("click", (e) => { e.stopPropagation(); opts.onOpenGui(c); });
  }

  // Collection run summary: list of results using the timeline rows.
  function runSummary(el, data, opts = {}) {
    const s = data.summary;
    const pct = s.total ? Math.round((s.passed / s.total) * 100) : 0;
    el.classList.add("av");
    el.innerHTML = `<div class="av-head"><div class="av-title"><h2>${esc(s.name)}</h2><span class="${s.passed === s.total ? "av-goodtext" : "av-badtext"}">${s.passed} of ${s.total} passed</span>${opts.actions || ""}</div>
      <div class="av-progress" aria-hidden="true"><i class="ok" style="width:${pct}%"></i><i class="bad" style="width:${100 - pct}%"></i></div></div>
      <div class="av-line">${segmentCard({ name: s.name, source: "ui", calls: data.calls, start: new Date(data.calls[0]?.ts || Date.now()).getTime(), end: Date.now(), continued: false }, { markAgent: false, rowsPerSession: 50 })}</div>`;
    el.onclick = (e) => { const r = e.target.closest("[data-call]"); if (r && opts.onSelect) opts.onSelect(Number(r.dataset.call), r, el.querySelector(`[data-detail="${r.dataset.call}"]`)); };
  }

  window.JodrellView = { timeline, detail, runSummary, toggleInline, failed };
})();
