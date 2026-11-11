// Kairo frontend: SSE chat client, collapsible reasoning trace, Markdown renderer, memory sidebar,
// and the Timeline / Time-Travel drawer.
const $ = (sel) => document.querySelector(sel);
const chat = $("#chat"), input = $("#input"), form = $("#form"), sendBtn = $("#send");

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
let sessionId = store.get("kairo.session") || crypto.randomUUID();
store.set("kairo.session", sessionId);
let asOf = null; // "YYYY-MM-DDTHH:mm" or null
let busy = false;

const SUGGESTIONS = [
  { tag: "CRM · pricing diff", text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" },
  { tag: "Recall + verify", text: "What did I ask you on 3 November? Is your answer still correct today?" },
  { tag: "Postgres hosting", text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" },
];

// ───────────────────────── Markdown ─────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inlineMd(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => (codes.push(c), `\u0000${codes.length - 1}\u0000`));
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
    const cite = /^(source|src|\[?\d+\]?|link)\b/i.test(text) || text.length <= 3;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer"${cite ? ' class="cite"' : ""}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function renderMarkdown(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || "");
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const head = cells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${inlineMd(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</${tag}>`); continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s)/.test(lines[i]) && !(lines[i].includes("|") && isTableSep(lines[i + 1]))) para.push(lines[i++]);
    out.push(`<p>${inlineMd(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("");
}

// ───────────────────────── Chat ─────────────────────────
function scrollDown() { chat.scrollTop = chat.scrollHeight; }

function renderEmpty() {
  chat.innerHTML = `<section id="empty" class="empty">
    <div class="mark">◐</div>
    <h1>Ask about things that <span>may have changed.</span></h1>
    <p class="muted">Kairo remembers your past conversations by date, then checks them against the live web, with one tool and one batched search.</p>
    <div class="cards" id="cards"></div>
  </section>`;
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "card"; b.type = "button";
    b.innerHTML = `<span class="tag">${esc(s.tag)}</span><span class="q">${esc(s.text)}</span>`;
    b.addEventListener("click", () => send(s.text));
    $("#cards").appendChild(b);
  }
}

function addUser(text) {
  $("#empty")?.remove();
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `${asOf ? `<div class="stamp">⏪ sent as of ${esc(asOf.replace("T", " "))}</div>` : ""}<div class="bubble"></div>`;
  el.querySelector(".bubble").textContent = text;
  chat.appendChild(el);
  return el;
}

function addAssistant() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="avatar">◐</div><div class="body">
    <details class="tracebox running" open><summary>Working…</summary><div class="trace"></div></details>
    <div class="answer"></div><div class="srcs"></div><div class="meta"></div></div>`;
  chat.appendChild(el);
  return el;
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true; sendBtn.disabled = true;
  addUser(text);
  const el = addAssistant();
  const box = el.querySelector(".tracebox"), trace = el.querySelector(".trace"), answer = el.querySelector(".answer");
  let raw = "", lastPill = null, steps = 0, searches = 0;
  const pill = (icon, textContent) => {
    lastPill?.classList.remove("live");
    const p = document.createElement("div");
    p.className = "pill live";
    p.innerHTML = `<span class="ic">${icon}</span><span class="tx"></span>`;
    p.querySelector(".tx").textContent = textContent;
    trace.appendChild(p); steps++; lastPill = p; scrollDown();
  };
  pill("⏳", "Hydrating memory…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId, asOf }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        handle(JSON.parse(data.slice(6)));
      }
    }
  } catch (err) {
    answer.innerHTML += `<p class="err">Error: ${esc(err.message)}</p>`;
  } finally {
    lastPill?.classList.remove("live");
    if (trace.firstChild?.textContent.includes("Hydrating") && trace.children.length > 1) { trace.firstChild.remove(); steps--; }
    box.classList.remove("running");
    if (trace.firstChild?.textContent.includes("Hydrating")) { trace.firstChild.remove(); steps--; }
    if (trace.children.length) {
      box.querySelector("summary").textContent = `Reasoning trace · ${steps} step${steps === 1 ? "" : "s"}${searches ? ` · ${searches} search call${searches === 1 ? "" : "s"}` : ""}`;
      if (raw) box.open = false; // collapse once there is an answer to read
    } else box.remove();
    busy = false; sendBtn.disabled = false; input.focus();
    setTimeout(refreshTimeline, 5000); // background fact extraction lands a few seconds later
    refreshTimeline();
  }

  function handle(e) {
    if (e.type === "status") {
      if (trace.firstChild?.textContent.includes("Hydrating")) { trace.firstChild.remove(); steps--; }
      pill(e.icon, e.text);
      box.querySelector("summary").textContent = e.kind === "memory" ? "Recalling memory…" : e.kind === "info" ? "Working…" : "Searching the web…";
    } else if (e.type === "delta") {
      raw += e.text; answer.innerHTML = renderMarkdown(raw);
      box.querySelector("summary").textContent = "Writing answer…"; scrollDown();
    } else if (e.type === "sources") {
      el.querySelector(".srcs").innerHTML = `<div class="sources">${e.sources.slice(0, 12).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.url)}">${esc(s.title || s.url)}</a>`).join("")}</div>`;
    } else if (e.type === "done") {
      searches = e.searches;
      const t = e.timings;
      el.querySelector(".meta").textContent = `memory ${t.memoryMs}ms · first token ${t.firstTokenMs ?? "–"}ms · total ${(t.totalMs / 1000).toFixed(1)}s · ${e.searches} search call${e.searches === 1 ? "" : "s"}${e.prefetched ? " (⚡ prefetched)" : ""} · fact ledger updating in background`;
    } else if (e.type === "error") {
      answer.innerHTML += `<p class="err">${esc(e.message)}</p>`;
    }
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value; input.value = ""; autosize();
  send(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
});
function autosize() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }
input.addEventListener("input", autosize);

async function loadHistory() {
  const rows = await (await fetch(`/api/sessions/${sessionId}/messages`)).json();
  if (!rows.length) return;
  $("#empty")?.remove();
  for (const m of rows) {
    if (m.role === "user") addUser(m.content);
    else {
      const el = addAssistant();
      el.querySelector(".tracebox").remove();
      el.querySelector(".answer").innerHTML = renderMarkdown(m.content);
    }
  }
  scrollDown();
}

$("#newChat").addEventListener("click", () => {
  sessionId = crypto.randomUUID(); store.set("kairo.session", sessionId);
  renderEmpty(); input.focus();
});
$("#toggleSide").addEventListener("click", () => $(".app").classList.toggle("collapsed"));

// ───────────────────────── Drawer ─────────────────────────
const drawer = $("#drawer"), scrim = $("#scrim");
function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${name}`));
}
function openDrawer(tab = "timeline") {
  drawer.classList.remove("hidden"); scrim.classList.remove("hidden");
  selectTab(tab); refreshTimeline(); refreshStatus();
}
function closeDrawer() { drawer.classList.add("hidden"); scrim.classList.add("hidden"); input.focus(); }
const drawerOpen = () => !drawer.classList.contains("hidden");
$("#openDrawer").addEventListener("click", () => openDrawer());
$("#goSimulate").addEventListener("click", () => openDrawer("simulate"));
$("#goManage").addEventListener("click", () => openDrawer("manage"));
$("#closeDrawer").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); drawerOpen() ? closeDrawer() : openDrawer(); }
  if (e.key === "Escape" && drawerOpen()) closeDrawer();
});
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => selectTab(b.dataset.tab));

async function refreshTimeline() {
  const days = await (await fetch("/api/timeline")).json();

  const side = $("#sideDays");
  side.innerHTML = days.length ? "" : `<p class="muted small" style="padding:0 8px">No memory yet. Chat, or seed the benchmark.</p>`;
  for (const d of days) {
    const b = document.createElement("button");
    b.className = "sideday";
    b.innerHTML = `<div class="sd-top"><span><span class="dot ${d.seeded ? "" : "live"}"></span>${esc(d.date)}</span><span class="muted small">${d.messageCount} msg · ${d.factCount} facts</span></div><div class="sd-q">${esc(d.firstQuestion)}</div>`;
    b.addEventListener("click", () => { openDrawer("timeline"); showDay(d.date); });
    side.appendChild(b);
  }

  const list = $("#days");
  list.innerHTML = days.length ? "" : `<p class="muted">Memory is empty. Seed the benchmark or chat to create episodes.</p>`;
  for (const d of days) {
    const b = document.createElement("button");
    b.className = "day"; b.dataset.date = d.date;
    b.innerHTML = `<div><span class="d">${esc(d.date)}</span><span class="badge ${d.seeded ? "seed" : ""}">${d.seeded ? "seeded" : "live"}</span><span class="badge">${d.messageCount} msgs</span><span class="badge">${d.factCount} facts</span></div><div class="q">${esc(d.firstQuestion)}</div>`;
    b.addEventListener("click", () => showDay(d.date));
    list.appendChild(b);
  }
}

async function showDay(date) {
  document.querySelectorAll(".day").forEach((x) => x.classList.toggle("active", x.dataset.date === date));
  const { messages, facts } = await (await fetch(`/api/timeline/${date}`)).json();
  const msgs = messages.map((m) => `<div class="dmsg ${m.role}"><b>${m.role === "user" ? "You asked" : "Kairo answered"} · ${new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>${esc(m.content)}</div>`).join("");
  const rows = facts.map((f) => `<tr><td>${esc(f.entity)}</td><td>${esc(f.attribute)}</td><td>${esc(f.valueThen)}</td></tr>`).join("");
  $("#dayDetail").innerHTML = `<h3>${esc(date)}</h3>${msgs}<h3>Fact snapshots (${facts.length})</h3>${facts.length ? `<div class="tablewrap"><table><thead><tr><th>Entity</th><th>Attribute</th><th>Value then</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">None recorded (the background extractor may still be running).</p>`}`;
}

// Simulate date
const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function setAsOf(v) {
  asOf = v || null;
  const banner = $("#simBanner");
  if (asOf) {
    banner.classList.remove("hidden");
    banner.innerHTML = `<span>⏪ Simulated clock: messages are sent as of <b>${esc(asOf.replace("T", " "))}</b></span><button class="ghost" id="bannerClear" type="button">Clear</button>`;
    $("#bannerClear").addEventListener("click", () => setAsOf(null));
  } else banner.classList.add("hidden");
}
$("#asOfApply").addEventListener("click", () => { const v = $("#asOfInput").value; if (v) { setAsOf(v); closeDrawer(); } });
$("#asOfClear").addEventListener("click", () => { setAsOf(null); $("#asOfInput").value = ""; });
for (const [label, days] of [["Yesterday", 1], ["3 days ago", 3], ["7 days ago", 7], ["14 days ago", 14]]) {
  const b = document.createElement("button");
  b.className = "ghost"; b.type = "button"; b.textContent = label;
  b.addEventListener("click", () => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(10, 0, 0, 0); $("#asOfInput").value = toLocalInput(d); setAsOf(toLocalInput(d)); closeDrawer(); });
  $("#asOfQuick").appendChild(b);
}

// Manage
async function refreshStatus() {
  const s = await (await fetch("/api/status")).json();
  $("#engine").textContent = s.llm ? `${s.llm.provider} · ${s.llm.model}\nsearch: ${s.search}` : "⚠ No LLM key configured. Add one to .env";
  $("#engine").style.whiteSpace = "pre-line";
  $("#statusBox").textContent = `today        ${s.today} (${s.timezone})\nllm          ${s.llm ? `${s.llm.provider}/${s.llm.model}` : "not configured"}\nsearch       ${s.search}\nmessages     ${s.messages}\nfact ledger  ${s.facts}`;
}
async function post(url, body) {
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  await Promise.all([refreshTimeline(), refreshStatus()]);
  $("#dayDetail").innerHTML = "";
}
$("#reseed").addEventListener("click", () => post("/api/seed"));
$("#resetSeed").addEventListener("click", () => post("/api/reset", { seed: true }));
$("#resetAll").addEventListener("click", () => { if (confirm("Delete ALL stored conversations and fact snapshots?")) post("/api/reset", { seed: false }); });

renderEmpty();
refreshStatus();
refreshTimeline();
loadHistory().catch(() => {});
