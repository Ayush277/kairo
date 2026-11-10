// Kairo frontend: SSE chat client, live trace pills, Markdown renderer, and the Timeline / Time-Travel drawer.
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
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
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
  el.innerHTML = `<div class="trace"></div><div class="answer"></div><div class="srcs"></div><div class="meta"></div>`;
  chat.appendChild(el);
  return el;
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true; sendBtn.disabled = true;
  addUser(text);
  const el = addAssistant();
  const trace = el.querySelector(".trace"), answer = el.querySelector(".answer");
  let raw = "", lastPill = null;
  const pill = (icon, textContent) => {
    lastPill?.classList.remove("live");
    const p = document.createElement("div");
    p.className = "pill live"; p.textContent = `${icon} ${textContent}`; p.title = textContent;
    trace.appendChild(p); lastPill = p; scrollDown();
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
    if (trace.firstChild && trace.firstChild.textContent.includes("Hydrating") && trace.children.length > 1) trace.firstChild.remove();
    busy = false; sendBtn.disabled = false; input.focus();
  }

  function handle(e) {
    if (e.type === "status") {
      if (trace.firstChild?.textContent.includes("Hydrating")) trace.firstChild.remove();
      pill(e.icon, e.text);
    } else if (e.type === "delta") {
      raw += e.text; answer.innerHTML = renderMarkdown(raw); scrollDown();
    } else if (e.type === "sources") {
      el.querySelector(".srcs").innerHTML = `<div class="sources">${e.sources.slice(0, 12).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.url)}">${esc(s.title || s.url)}</a>`).join("")}</div>`;
    } else if (e.type === "done") {
      const t = e.timings;
      el.querySelector(".meta").textContent = `memory ${t.memoryMs}ms · first token ${t.firstTokenMs ?? "–"}ms · total ${(t.totalMs / 1000).toFixed(1)}s · ${e.searches} search call${e.searches === 1 ? "" : "s"} · fact ledger updating in background`;
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

for (const s of SUGGESTIONS) {
  const b = document.createElement("button");
  b.className = "chip"; b.textContent = s; b.type = "button";
  b.addEventListener("click", () => send(s));
  $("#chips").appendChild(b);
}

async function loadHistory() {
  const rows = await (await fetch(`/api/sessions/${sessionId}/messages`)).json();
  if (!rows.length) return;
  $("#empty")?.remove();
  for (const m of rows) {
    if (m.role === "user") addUser(m.content);
    else { const el = addAssistant(); el.querySelector(".answer").innerHTML = renderMarkdown(m.content); }
  }
  scrollDown();
}

$("#newChat").addEventListener("click", () => {
  sessionId = crypto.randomUUID(); store.set("kairo.session", sessionId);
  chat.innerHTML = `<section id="empty" class="empty"><h1>New conversation</h1><div class="chips" id="chips2"></div></section>`;
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button"); b.className = "chip"; b.textContent = s; b.type = "button";
    b.addEventListener("click", () => send(s)); $("#chips2").appendChild(b);
  }
});

// ───────────────────────── Drawer ─────────────────────────
const drawer = $("#drawer");
function openDrawer() { drawer.classList.remove("hidden"); refreshTimeline(); refreshStatus(); }
function closeDrawer() { drawer.classList.add("hidden"); input.focus(); }
$("#openDrawer").addEventListener("click", openDrawer);
$("#closeDrawer").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); drawer.classList.contains("hidden") ? openDrawer() : closeDrawer(); }
  if (e.key === "Escape" && !drawer.classList.contains("hidden")) closeDrawer();
});
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${b.dataset.tab}`));
  });
}

async function refreshTimeline() {
  const days = await (await fetch("/api/timeline")).json();
  $("#days").innerHTML = days.length ? "" : `<p class="muted">Memory is empty. Seed the benchmark or chat to create episodes.</p>`;
  for (const d of days) {
    const b = document.createElement("button");
    b.className = "day";
    b.innerHTML = `<div><span class="d">${esc(d.date)}</span><span class="badge ${d.seeded ? "seed" : ""}">${d.seeded ? "seeded" : "live"}</span><span class="badge">${d.messageCount} msgs</span><span class="badge">${d.factCount} facts</span></div><div class="q">${esc(d.firstQuestion)}</div>`;
    b.addEventListener("click", () => { document.querySelectorAll(".day").forEach((x) => x.classList.remove("active")); b.classList.add("active"); showDay(d.date); });
    $("#days").appendChild(b);
  }
}

async function showDay(date) {
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
  $("#engine").textContent = s.llm ? `${s.llm.provider} · ${s.llm.model} · search: ${s.search}` : "⚠ no LLM key configured";
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

refreshStatus();
loadHistory().catch(() => {});
