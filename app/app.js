/* QuantPrep — coverage-first quant interview trainer (offline, vanilla JS) */
"use strict";

/* ---------------- storage ---------------- */
const SKEY = "qp_state_v2";
const DAY = 86400000;
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const defaultState = () => ({
  v: 2,
  doneCount: 0,            // total questions answered (drives count-based review spacing)
  cards: {},              // slug -> {seen:1, status:'comfy'|'shaky', due:int(doneCount), streak, ts}
  attempts: [],           // {slug, ts, outcome, typed, typedCorrect, secs, fam, diff}
  streak: { count: 0, lastDay: null },
  mm: { best: 0, sessions: 0, totalCorrect: 0 },
  settings: { diff: "mixed", dailyGoal: 15, apiKey: "" },
  daily: { day: today(), done: 0 },
});

let S = load();
function load() {
  try { return Object.assign(defaultState(), JSON.parse(localStorage.getItem(SKEY) || "{}")); }
  catch { return defaultState(); }
}
function save() { localStorage.setItem(SKEY, JSON.stringify(S)); }

/* ---------------- bank ---------------- */
let BANK = null, Q = [], BYSLUG = {}, TAX = null, TECH = {}, FAM = {};
let QBYFAM = {}, FAM_LIST = [];
async function loadBank() {
  const r = await fetch("bank.json", { cache: "no-cache" });
  BANK = await r.json();
  Q = BANK.questions; TAX = BANK.taxonomy;
  Q.forEach(q => BYSLUG[q.slug] = q);
  TAX.techniques.forEach(t => TECH[t.id] = t);
  TAX.families.forEach(f => FAM[f.id] = f);
  // partition every question into exactly one family bucket (via its primary technique)
  FAM_LIST = TAX.families.map(f => f.id);
  Q.forEach(q => { const f = topicOf(q); (QBYFAM[f] = QBYFAM[f] || []).push(q); });
}

/* each question belongs to one "topic" = the family of its primary technique */
function topicOf(q) {
  const p = q.primary || (q.techniques && q.techniques[0]);
  const f = p && TECH[p] ? TECH[p].family : null;
  return f && FAM[f] ? f : "_other";
}
function famName(fid) { return FAM[fid] ? FAM[fid].name : "Other"; }
function famColor(fid) { return FAM[fid] ? FAM[fid].color : "#6b7785"; }

/* ---------------- difficulty + selection ---------------- */
function diffsFor(mode) {
  return mode === "easy" ? ["easy"] : mode === "medium" ? ["medium"]
    : mode === "hard" ? ["hard"] : ["easy", "medium"];     // 'mixed' default
}
function isSeen(q) { const c = S.cards[q.slug]; return !!(c && c.seen); }
function cardOf(q) { return S.cards[q.slug] || null; }

/* per-family aggregates: total / seen / comfortable */
function famAgg() {
  const agg = {};
  FAM_LIST.concat("_other").forEach(f => agg[f] = { total: (QBYFAM[f] || []).length, seen: 0, comfy: 0, shaky: 0 });
  for (const slug in S.cards) {
    const q = BYSLUG[slug]; if (!q) continue;
    const f = topicOf(q), c = S.cards[slug]; if (!agg[f]) continue;
    if (c.seen) agg[f].seen++;
    if (c.status === "comfy") agg[f].comfy++;
    else if (c.status === "shaky") agg[f].shaky++;
  }
  return agg;
}
/* weakness score per family: higher = needs work (used to steer new-question picks) */
function famWeak(agg) {
  const w = {};
  FAM_LIST.concat("_other").forEach(f => {
    const a = agg[f]; if (!a) { w[f] = 0.5; return; }
    w[f] = (a.shaky + 1) / (a.seen + 2);   // Laplace-smoothed shaky rate; unseen ~0.5
  });
  return w;
}
function overallCoverage() {
  // coverage over easy+medium (the default target set)
  const pool = Q.filter(q => q.difficulty !== "hard");
  const seen = pool.filter(isSeen).length;
  return { seen, total: pool.length, pct: pool.length ? Math.round(seen / pool.length * 100) : 0 };
}

/* build a mixed session: mostly NEW (weak-topic-biased), a little far-spaced review */
function buildMix(size, opts = {}) {
  const diffs = opts.diffs || diffsFor(S.settings.diff);
  const famSet = opts.fam ? new Set([opts.fam]) : null;
  const inScope = q => diffs.includes(q.difficulty) && (!famSet || famSet.has(topicOf(q)));
  const dc = S.doneCount;
  const agg = famAgg(), weak = famWeak(agg);

  // 1) reviews that have come due (shaky items whose spacing elapsed)
  const due = Q.filter(q => { const c = cardOf(q); return c && c.status === "shaky" && (c.due || 0) <= dc && inScope(q); })
               .sort((a, b) => (cardOf(a).due || 0) - (cardOf(b).due || 0));
  // 2) brand-new questions in scope, weak-topic & easier biased
  const fresh = Q.filter(q => !isSeen(q) && inScope(q)).map(q => {
    const score = weak[topicOf(q)] * 0.7 + Math.random() * 0.35 + (q.difficulty === "easy" ? 0.12 : 0);
    return { q, score };
  }).sort((a, b) => b.score - a.score).map(x => x.q);

  const out = [], seen = new Set();
  const push = q => { if (q && !seen.has(q.slug)) { seen.add(q.slug); out.push(q); } };
  const reviewCap = Math.min(due.length, Math.round(size * 0.2));   // ≤20% reviews
  due.slice(0, reviewCap).forEach(push);
  fresh.forEach(push);
  // fallbacks if we ran out of new: more due, then seen-not-due (oldest), then anything in scope
  due.forEach(push);
  Q.filter(q => isSeen(q) && inScope(q)).sort((a, b) => (cardOf(a).ts || 0) - (cardOf(b).ts || 0)).forEach(push);
  Q.filter(inScope).forEach(push);
  return out.slice(0, size);
}

/* ---------------- grading (2-button, count-based spacing) ---------------- */
const COMFY_STEPS = [45, 110, 250, 500];   // questions until a comfy item resurfaces (grows w/ streak)
const SHAKY_GAP = 12;                        // questions until a shaky item comes back

function grade(q, outcome, typedCorrect, typed, secs) {
  S.doneCount++;
  const dc = S.doneCount;
  const c = S.cards[q.slug] || { seen: 0, streak: 0 };
  c.seen = 1; c.ts = now();
  if (outcome === "comfy") {
    c.streak = (c.streak || 0) + 1;
    c.status = "comfy";
    c.due = dc + COMFY_STEPS[Math.min(c.streak - 1, COMFY_STEPS.length - 1)];
  } else {
    c.streak = 0; c.status = "shaky";
    c.due = dc + SHAKY_GAP + Math.floor(Math.random() * 5);   // 12–16 away
  }
  S.cards[q.slug] = c;
  S.attempts.push({ slug: q.slug, ts: now(), outcome, typed, typedCorrect, secs, fam: topicOf(q), diff: q.difficulty });
  if (S.attempts.length > 5000) S.attempts = S.attempts.slice(-5000);
  // daily + streak
  if (S.daily.day !== today()) S.daily = { day: today(), done: 0 };
  S.daily.done++;
  const d = today();
  if (S.streak.lastDay !== d) {
    const y = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    S.streak.count = (S.streak.lastDay === y) ? S.streak.count + 1 : 1;
    S.streak.lastDay = d;
  }
  save();
}

/* ---------------- view routing ---------------- */
const view = () => document.getElementById("view");
let CURRENT = "practice";
function go(tab) {
  CURRENT = tab;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  ({ practice: renderPractice, topics: renderTopics, drills: renderDrills, stats: renderStats }[tab] || renderPractice)();
  view().scrollTop = 0;
  refreshBadges();
}
function refreshBadges() {
  document.getElementById("streakBadge").textContent = "🔥 " + (S.streak.count || 0);
  const cov = overallCoverage();
  const b = document.getElementById("readinessBadge");
  b.textContent = cov.pct + "%";
  b.title = "Coverage of easy+medium";
  b.style.color = cov.pct < 33 ? "#7c92ff" : cov.pct < 66 ? "#e3b341" : "#56d364";
}

/* katex + utils */
function mathify(el) {
  if (window.renderMathInElement) {
    try { renderMathInElement(el, { delimiters: [
      { left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false },
      { left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }
    ], throwOnError: false }); } catch {}
  }
}
function esc(s) { return (s || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function toast(msg) {
  let t = document.querySelector(".toast"); if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 1700);
}

/* ---------------- answer checking ---------------- */
function parseNum(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase().replace(/[\s,$]/g, "").replace(/[−–—]/g, "-").replace(/=+$/, "");
  let pct = false; if (s.endsWith("%")) { pct = true; s = s.slice(0, -1); }
  if (!s) return null;
  let v = null;
  const m = s.match(/^(-?\d*\.?\d+)\/(-?\d*\.?\d+)$/);
  if (m) { const d = parseFloat(m[2]); if (!d) return null; v = parseFloat(m[1]) / d; }
  else { const f = parseFloat(s); v = isFinite(f) && /^-?[\d.]+(e-?\d+)?$/.test(s) ? f : null; }
  if (v == null) return null;
  return pct ? v / 100 : v;
}
function answerVariants(ans) { return String(ans == null ? "" : ans).split(";").map(x => x.trim()).filter(Boolean); }
function checkAnswer(userRaw, ans) {
  const u = parseNum(userRaw);
  if (u === null) return null;
  for (const vs of answerVariants(ans)) {
    const v = parseNum(vs); if (v === null) continue;
    const isInt = Number.isInteger(v) && !/[.\/]/.test(vs);
    if (isInt) { if (Math.abs(u - v) < 1e-9) return true; continue; }
    const tol = Math.max(0.01, Math.abs(v) * 0.01);
    if (Math.abs(u - v) <= tol) return true;
  }
  return false;
}

/* ---------------- calculator ---------------- */
function calcEval(expr) {
  if (!expr || !expr.trim()) return "";
  let s = expr.replace(/\s+/g, "");
  s = s.replace(/(\d+)C(\d+)/gi, "comb($1,$2)").replace(/(\d+)P(\d+)/gi, "perm($1,$2)");
  s = s.replace(/\bC\(/gi, "comb(").replace(/\bP\(/gi, "perm(").replace(/\bncr\(/gi, "comb(").replace(/\bnpr\(/gi, "perm(");
  s = s.replace(/\^/g, "**");
  for (let i = 0; i < 8 && /!/.test(s); i++) s = s.replace(/(\d+(?:\.\d+)?)!/g, "fact($1)");
  const bare = s.replace(/comb|perm|fact/g, "");
  if (!/^[\d+\-*/().,e]*$/.test(bare)) return "?";
  try {
    const fact = n => { n = Math.round(n); if (n < 0 || n > 170) return NaN; let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
    const comb = (n, k) => { n = Math.round(n); k = Math.round(k); if (k < 0 || k > n || n < 0) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };
    const perm = (n, k) => { n = Math.round(n); k = Math.round(k); if (k < 0 || k > n || n < 0) return 0; let r = 1; for (let i = 0; i < k; i++) r *= (n - i); return r; };
    const val = Function("comb", "perm", "fact", `"use strict";return (${s});`)(comb, perm, fact);
    if (val == null || Number.isNaN(val) || !isFinite(val)) return "?";
    return (Number.isInteger(val) || Math.abs(val) >= 1e15) ? String(val) : String(Math.round(val * 1e6) / 1e6);
  } catch { return "?"; }
}
function calcPanelHTML(id) {
  return `<div class="calc" id="${id}">
    <input class="calc-in" id="${id}_in" inputmode="text" autocomplete="off" placeholder="e.g. C(52,5)  ·  10!/(3!·7!)  ·  0.5*0.5+0.25">
    <div class="calc-keys">
      ${["C(", "P(", "!", "(", ")", "^", "/", "*", "-", "+"].map(k => `<button class="ck" data-k="${k}">${k === "!" ? "n!" : k}</button>`).join("")}
      <button class="ck wide" data-k="DEL">⌫</button>
    </div>
    <div class="calc-out" id="${id}_out">= </div>
  </div>`;
}
function wireCalc(id) {
  const inp = document.getElementById(id + "_in"), out = document.getElementById(id + "_out");
  if (!inp) return;
  const run = () => { const r = calcEval(inp.value); out.textContent = "= " + (r === "?" ? "…" : r); };
  inp.oninput = run;
  inp.onkeydown = e => { if (e.key === "Enter") e.preventDefault(); };
  document.querySelectorAll("#" + id + " .ck").forEach(b => b.onclick = () => {
    if (b.dataset.k === "DEL") inp.value = inp.value.slice(0, -1);
    else inp.value += b.dataset.k;
    inp.focus(); run();
  });
}

/* ---------------- PRACTICE (home) ---------------- */
function diffToggleHTML() {
  const modes = [["mixed", "Easy + Med"], ["easy", "Easy"], ["medium", "Medium"]];
  return `<div class="seg" id="diffSeg">${modes.map(([k, l]) =>
    `<button class="seg-b ${S.settings.diff === k ? "on" : ""}" data-diff="${k}">${l}</button>`).join("")}</div>`;
}
function renderPractice() {
  const cov = overallCoverage();
  const goal = S.settings.dailyGoal, done = S.daily.day === today() ? S.daily.done : 0;
  const due = Q.filter(q => { const c = cardOf(q); return c && c.status === "shaky" && (c.due || 0) <= S.doneCount; }).length;
  const agg = famAgg(), weak = famWeak(agg);
  const weakNames = FAM_LIST.filter(f => agg[f].seen >= 2)
    .sort((a, b) => weak[b] - weak[a]).slice(0, 3).map(famName);

  view().innerHTML = `
    <div class="card hero">
      <div class="row spread">
        <div><div class="h1">Practice</div><div class="muted">Pick up where you left off — fresh questions across topics.</div></div>
      </div>
      <div class="cov-line"><span>Coverage (easy + medium)</span><b>${cov.seen}/${cov.total} · ${cov.pct}%</b></div>
      <div class="bar big"><i style="width:${cov.pct}%"></i></div>

      <div class="label" style="margin-top:16px">Difficulty</div>
      ${diffToggleHTML()}

      <button class="btn xl" id="mixBtn" style="margin-top:16px">▶ Start practice${due ? ` · ${Math.min(due,3)} review` : ""}</button>
      <div class="mini" style="margin-top:10px;text-align:center">Today: ${done}/${goal} questions · 🔥 ${S.streak.count||0} day streak</div>
    </div>

    ${weakNames.length ? `<div class="section-title">Worth a look</div>
    <div class="card">${weakNames.map(w => `<div class="row" style="padding:5px 0"><span class="dot" style="background:#e3b341"></span><span>${esc(w)}</span></div>`).join("")}
      <button class="btn ghost sm" style="width:100%;margin-top:10px" data-go="topics">Browse all topics →</button></div>` : ""}

    <div class="section-title">Quick start</div>
    <div class="card tap" id="hardBtn"><div class="row spread"><div><div class="h2">Challenge mode</div><div class="muted">Hard questions only.</div></div><span class="diff hard">hard</span></div></div>
    <div class="card tap" data-go="topics"><div class="row spread"><div><div class="h2">By topic</div><div class="muted">See coverage & drill a specific area.</div></div><div class="big">⌗</div></div></div>
  `;
  document.getElementById("mixBtn").onclick = () => startSession(buildMix(12), { mix: true });
  document.getElementById("hardBtn").onclick = () => startSession(buildMix(10, { diffs: ["hard"] }), { mix: true });
  document.querySelectorAll("#diffSeg .seg-b").forEach(b => b.onclick = () => { S.settings.diff = b.dataset.diff; save(); renderPractice(); });
  view().querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  mathify(view());
}

/* ---------------- TOPICS ---------------- */
function renderTopics() {
  const agg = famAgg();
  const cov = overallCoverage();
  const fams = FAM_LIST.map(f => ({ id: f, ...agg[f] })).filter(x => x.total > 0)
    .sort((a, b) => (b.seen / b.total) - (a.seen / a.total));
  view().innerHTML = `
    <div class="card">
      <div class="row spread"><div class="h2">Topics</div><div class="mini">${cov.seen}/${cov.total} easy+med seen</div></div>
      <div class="muted" style="font-size:13px;margin-top:4px">Tap a topic to drill it (new questions first). Bar = coverage; green slice = comfortable.</div>
      <div class="label" style="margin-top:12px">Difficulty for drills</div>
      ${diffToggleHTML()}
    </div>
    ${fams.map(x => {
      const covPct = Math.round(x.seen / x.total * 100);
      const comfyPct = x.seen ? Math.round(x.comfy / x.seen * 100) : 0;
      return `<div class="card tap topic-row" data-fam="${x.id}">
        <div class="row spread"><div class="row" style="gap:8px"><span class="dot" style="background:${famColor(x.id)}"></span><b>${esc(famName(x.id))}</b></div>
          <span class="mini">${x.seen}/${x.total}</span></div>
        <div class="bar2" style="margin-top:9px"><i class="cov" style="width:${covPct}%"></i><i class="comfy" style="width:${comfyPct * covPct / 100}%"></i></div>
        <div class="mini" style="margin-top:6px">${covPct}% covered${x.seen ? ` · ${comfyPct}% comfortable` : ""}${x.shaky ? ` · ${x.shaky} to revisit` : ""}</div>
      </div>`;
    }).join("")}
  `;
  document.querySelectorAll("#diffSeg .seg-b").forEach(b => b.onclick = () => { S.settings.diff = b.dataset.diff; save(); renderTopics(); });
  view().querySelectorAll("[data-fam]").forEach(c => c.onclick = () => {
    const fam = c.dataset.fam;
    const list = buildMix(14, { fam, diffs: diffsFor(S.settings.diff) });
    if (!list.length) { toast("Nothing left here at this difficulty 🎉"); return; }
    startSession(list, { mix: true, famName: famName(fam) });
  });
}

/* ---------------- session runner ---------------- */
let SESSION = null;
function startSession(list, meta = {}) {
  if (!list.length) { toast("No questions match."); return; }
  SESSION = { list, i: 0, meta, comfy: 0, started: now() };
  renderQuestion();
}
function renderQuestion() {
  const s = SESSION; if (!s) return;
  if (s.i >= s.list.length) return renderSessionDone();
  const q = s.list[s.i];
  s.qStart = now(); s.revealed = false; s.hintLevel = 0; s.typed = null; s.typedCorrect = null;
  const hasNumericAns = answerVariants(q.answer).some(v => parseNum(v) !== null);
  const hints = (q.hints && q.hints.length === 3) ? q.hints : (q.hint ? [q.hint] : []);
  const sol = q.genSolution || q.siteSolution || "";
  const fam = topicOf(q);
  const repeat = isSeen(q);

  view().innerHTML = `
    <div class="row spread" style="margin-bottom:8px">
      <span class="mini">${s.i + 1} / ${s.list.length}${s.meta.famName ? " · " + esc(s.meta.famName) : ""}</span>
      <span class="mini" id="timer">0s</span>
    </div>
    <div class="bar" style="margin-bottom:14px"><i style="width:${s.i / s.list.length * 100}%"></i></div>

    <div class="card">
      <div class="qmeta">
        <span class="diff ${q.difficulty}">${q.difficulty}</span>
        <span class="chip" style="border-color:${famColor(fam)}55">${esc(famName(fam))}</span>
        ${repeat ? `<span class="chip" style="opacity:.7">↻ review</span>` : ""}
      </div>
      <div class="qtext">${esc(q.question)}</div>

      <div id="preReveal">
        <div class="label" style="margin-top:16px">Your answer</div>
        <div class="ans-row">
          <input class="ans-input" id="ansIn" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false"
                 placeholder="${hasNumericAns ? "e.g. 3/8, 0.42, 17, 25%" : "type, or just reveal"}">
          <button class="btn sm" id="checkBtn">Check</button>
        </div>
        <div id="verdict"></div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn alt" id="hintBtn">💡 Hint</button>
          <button class="btn alt" id="calcBtn">🧮 Calc</button>
          <button class="btn" id="revealBtn">Reveal</button>
        </div>
        <div id="calcZone"></div>
        <div id="hintZone" style="margin-top:12px"></div>
      </div>
      <div id="reveal"></div>
    </div>
    <button class="btn ghost sm" id="skipBtn" style="width:100%">Skip for now</button>
  `;
  clearInterval(s._tmr);
  s._tmr = setInterval(() => { const el = document.getElementById("timer"); if (el) el.textContent = Math.round((now() - s.qStart) / 1000) + "s"; }, 1000);

  document.getElementById("hintBtn").onclick = () => {
    const z = document.getElementById("hintZone");
    if (s.hintLevel >= hints.length) { toast(hints.length ? "No more hints" : "No hints for this one"); return; }
    const h = document.createElement("div"); h.className = "hint";
    h.innerHTML = `<b>Hint ${s.hintLevel + 1}:</b> ${esc(hints[s.hintLevel])}`;
    z.appendChild(h); mathify(h); s.hintLevel++;
  };
  document.getElementById("calcBtn").onclick = () => {
    const z = document.getElementById("calcZone");
    if (z.innerHTML) { z.innerHTML = ""; return; }
    z.innerHTML = calcPanelHTML("qcalc"); wireCalc("qcalc"); document.getElementById("qcalc_in").focus();
  };
  const checkAndReveal = () => {
    const inp = document.getElementById("ansIn"); if (!inp) return;
    const val = (inp.value || "").trim();
    if (!val) { revealAnswer(q, sol); return; }
    const res = checkAnswer(val, q.answer);
    s.typed = val; s.typedCorrect = res;
    document.getElementById("verdict").innerHTML = res === true ? `<div class="verdict ok">✓ Correct</div>`
      : res === false ? `<div class="verdict no">✗ Not quite — see below</div>`
      : `<div class="verdict warn">Compare with the answer below</div>`;
    document.getElementById("checkBtn").disabled = true; inp.disabled = true;
    setTimeout(() => revealAnswer(q, sol), 550);
  };
  document.getElementById("checkBtn").onclick = checkAndReveal;
  document.getElementById("ansIn").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); checkAndReveal(); } };
  document.getElementById("revealBtn").onclick = () => revealAnswer(q, sol);
  document.getElementById("skipBtn").onclick = () => { s.i++; renderQuestion(); };
  mathify(view());
}

function revealAnswer(q, sol) {
  const s = SESSION; s.revealed = true; s.secs = Math.round((now() - s.qStart) / 1000);
  document.getElementById("preReveal").style.display = "none";
  const paywalled = q.solutionPaywalled && !q.genSolution;
  const rv = document.getElementById("reveal"); rv.className = "reveal";
  const tc = s.typedCorrect;
  const verdictTop = tc === true ? `<div class="verdict ok" style="margin-bottom:12px">✓ Your answer <b>${esc(s.typed)}</b> is correct</div>`
    : tc === false ? `<div class="verdict no" style="margin-bottom:12px">✗ You answered <b>${esc(s.typed)}</b></div>` : "";
  rv.innerHTML = `
    ${verdictTop}
    <div class="label">Answer</div>
    <div class="answer-box">${esc(q.answer) || "—"}</div>
    ${sol ? `<div class="label" style="margin-top:14px">Worked solution</div><div class="solution">${esc(sol)}</div>`
          : (paywalled ? `<div class="mini" style="margin-top:12px">No full solution for this one yet — use the answer + hints.</div>` : "")}
    ${q.similar && q.similar.length ? `<div class="label" style="margin-top:16px">More like this</div>
      <div id="similar">${q.similar.slice(0, 4).map(sl => `<span class="chip" data-sl="${sl}">${esc(BYSLUG[sl]?.title || sl)}</span>`).join("")}</div>` : ""}

    <div class="label" style="margin-top:18px">How did that feel?</div>
    <div class="feel-grid">
      <div class="feel comfy" data-o="comfy">😎 Comfortable<small>won't see for a while</small></div>
      <div class="feel shaky" data-o="shaky">🤔 Not comfortable<small>show again later</small></div>
    </div>`;
  if (tc === true) rv.querySelector('[data-o="comfy"]')?.classList.add("suggest");
  else if (tc === false) rv.querySelector('[data-o="shaky"]')?.classList.add("suggest");
  rv.querySelectorAll("[data-o]").forEach(b => b.onclick = () => {
    grade(q, b.dataset.o, s.typedCorrect, s.typed, s.secs);
    if (b.dataset.o === "comfy") s.comfy++;
    s.i++; renderQuestion(); refreshBadges();
  });
  rv.querySelectorAll("[data-sl]").forEach(b => b.onclick = () => {
    const q2 = BYSLUG[b.dataset.sl];
    if (q2 && !SESSION.list.slice(SESSION.i + 1).some(x => x.slug === q2.slug)) { SESSION.list.splice(SESSION.i + 1, 0, q2); toast("Added next"); }
  });
  mathify(rv);
}

function renderSessionDone() {
  clearInterval(SESSION._tmr);
  const s = SESSION, n = s.list.length;
  const mins = Math.max(1, Math.round((now() - s.started) / 60000));
  const cov = overallCoverage();
  view().innerHTML = `
    <div class="card" style="text-align:center;padding:28px 16px">
      <div class="big" style="font-size:46px">✅</div>
      <div class="h2" style="margin-top:6px">Nice — ${n} done</div>
      <div class="grid2" style="margin-top:18px">
        <div><div class="big">${s.comfy}/${n}</div><div class="mini">comfortable</div></div>
        <div><div class="big">${cov.pct}%</div><div class="mini">easy+med covered</div></div>
      </div>
      <div class="mini" style="margin-top:10px">${mins} min · 🔥 ${S.streak.count} day streak</div>
      <div class="btn-row" style="margin-top:22px">
        <button class="btn" id="again">Keep going</button>
        <button class="btn alt" id="home2">Done</button>
      </div>
    </div>`;
  document.getElementById("again").onclick = () => startSession(buildMix(12, s.meta.famName ? {} : {}), s.meta);
  document.getElementById("home2").onclick = () => go("practice");
  refreshBadges();
}

/* ---------------- DRILLS (mental math + calculator) ---------------- */
let MM = null;
function renderDrills() {
  view().innerHTML = `
    <div class="section-title">Mental math sprint</div>
    <div class="card">
      <div class="muted">60 seconds of fast arithmetic, fractions & %. Interviews test this hard.</div>
      <div class="mm-stat" style="margin:16px 0">
        <div><b>${S.mm.best}</b><span class="mini">best</span></div>
        <div><b>${S.mm.sessions}</b><span class="mini">sprints</span></div>
        <div><b>${S.mm.totalCorrect}</b><span class="mini">total</span></div>
      </div>
      <button class="btn" id="mmStart">Start 60s sprint</button>
    </div>
    <div class="section-title">Calculator</div>
    <div class="card">
      <div class="muted" style="margin-bottom:10px">Combinations, permutations, factorials & arithmetic — handy while solving.</div>
      ${calcPanelHTML("dcalc")}
    </div>`;
  document.getElementById("mmStart").onclick = startMM;
  wireCalc("dcalc");
}
function genMM() {
  const r = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const type = r(1, 5);
  if (type === 1) { const a = r(12, 99), b = r(12, 99); return [`${a} + ${b}`, a + b]; }
  if (type === 2) { const a = r(20, 199), b = r(10, a); return [`${a} − ${b}`, a - b]; }
  if (type === 3) { const a = r(3, 19), b = r(3, 19); return [`${a} × ${b}`, a * b]; }
  if (type === 4) { const b = r(3, 12), q = r(3, 12), a = b * q; return [`${a} ÷ ${b}`, q]; }
  const base = r(40, 400), p = [10, 20, 25, 50, 5][r(0, 4)]; return [`${p}% of ${base}`, base * p / 100];
}
function startMM() { MM = { score: 0, end: now() + 60000, cur: genMM() }; paintMM();
  MM.t = setInterval(() => { if (now() >= MM.end) endMM(); else { const el = document.getElementById("mmTime"); if (el) el.textContent = Math.ceil((MM.end - now()) / 1000) + "s"; } }, 250); }
function paintMM() {
  view().innerHTML = `
    <div class="card" style="text-align:center">
      <div class="row spread"><span class="mini" id="mmTime">60s</span><span class="mini">Score <b id="mmScore">0</b></span></div>
      <div class="mm-display">${MM.cur[0]}</div>
      <input class="mm-input" id="mmIn" inputmode="numeric" autocomplete="off" placeholder="?" />
      <div class="btn-row" style="margin-top:14px"><button class="btn" id="mmGo">Enter</button></div>
    </div>`;
  const inp = document.getElementById("mmIn"); inp.focus();
  const submit = () => {
    if (parseFloat(inp.value) === MM.cur[1]) { MM.score++; document.getElementById("mmScore").textContent = MM.score; }
    else { inp.style.borderColor = "#f85149"; setTimeout(() => inp.style.borderColor = "var(--line)", 200); }
    MM.cur = genMM(); document.querySelector(".mm-display").textContent = MM.cur[0]; inp.value = ""; inp.focus();
  };
  document.getElementById("mmGo").onclick = submit;
  inp.onkeydown = e => { if (e.key === "Enter") submit(); };
}
function endMM() {
  clearInterval(MM.t);
  S.mm.sessions++; S.mm.totalCorrect += MM.score; S.mm.best = Math.max(S.mm.best, MM.score); save();
  view().innerHTML = `<div class="card" style="text-align:center;padding:26px">
    <div class="big" style="font-size:44px">⚡</div>
    <div class="h2">${MM.score} correct</div>
    <div class="mini">${MM.score === S.mm.best ? "New best!" : "Best: " + S.mm.best}</div>
    <div class="btn-row" style="margin-top:20px"><button class="btn" id="mmAgain">Again</button><button class="btn alt" id="mmBack">Back</button></div>
  </div>`;
  document.getElementById("mmAgain").onclick = startMM;
  document.getElementById("mmBack").onclick = () => go("drills");
}

/* ---------------- STATS ---------------- */
function renderStats() {
  const a = S.attempts, n = a.length;
  const cov = overallCoverage();
  const allSeen = Q.filter(isSeen).length;
  const typed = a.filter(x => x.typedCorrect === true || x.typedCorrect === false);
  const typedAcc = typed.length ? Math.round(typed.filter(x => x.typedCorrect === true).length / typed.length * 100) : null;
  const agg = famAgg();
  const fams = FAM_LIST.map(f => ({ id: f, ...agg[f] })).filter(x => x.total > 0).sort((a, b) => (b.seen / b.total) - (a.seen / a.total));
  // activity heatmap
  const byDay = {}; a.forEach(x => { const d = new Date(x.ts).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; });
  let heat = ""; for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); const c = byDay[d] || 0;
    const bg = c === 0 ? "#1c232d" : c < 5 ? "#1f3a2a" : c < 12 ? "#2a6b3f" : "#3fb950"; heat += `<div title="${d}: ${c}" style="width:100%;aspect-ratio:1;border-radius:4px;background:${bg}"></div>`; }

  view().innerHTML = `
    <div class="section-title">Overview</div>
    <div class="card"><div class="grid2">
      <div><div class="big">${allSeen}</div><div class="mini">questions seen</div></div>
      <div><div class="big">${cov.pct}%</div><div class="mini">easy+med covered</div></div>
      <div><div class="big">${typedAcc !== null ? typedAcc + "%" : "—"}</div><div class="mini">typed-answer accuracy</div></div>
      <div><div class="big">${S.streak.count || 0}</div><div class="mini">day streak</div></div>
    </div></div>

    <div class="section-title">Coverage by topic</div>
    <div class="card">
      ${fams.map(x => {
        const covPct = Math.round(x.seen / x.total * 100), comfyPct = x.seen ? Math.round(x.comfy / x.seen * 100) : 0;
        return `<div class="topic-row" style="padding:8px 0;border-bottom:1px solid var(--line)">
          <div class="row spread"><span class="row" style="gap:7px"><span class="dot" style="background:${famColor(x.id)}"></span>${esc(famName(x.id))}</span><span class="mini">${x.seen}/${x.total}${x.seen ? " · " + comfyPct + "% comfy" : ""}</span></div>
          <div class="bar2" style="margin-top:7px"><i class="cov" style="width:${covPct}%"></i><i class="comfy" style="width:${comfyPct * covPct / 100}%"></i></div>
        </div>`;
      }).join("")}
      <div class="mini" style="margin-top:10px">Bar = how much of the topic you've seen · green = of that, how much felt comfortable.</div>
    </div>

    <div class="section-title">Activity (14 days)</div>
    <div class="card"><div style="display:grid;grid-template-columns:repeat(14,1fr);gap:4px">${heat}</div></div>

    <div class="section-title">Settings & data</div>
    <div class="card" id="settings"></div>`;
  renderSettings();
}
function renderSettings() {
  const el = document.getElementById("settings");
  el.innerHTML = `
    <label class="mini">Daily goal (questions)</label>
    <input id="goal" class="ans-input" style="margin:6px 0 14px" inputmode="numeric" value="${S.settings.dailyGoal}">
    <div class="btn-row"><button class="btn alt sm" id="exp">Export progress</button><button class="btn alt sm" id="imp">Import</button></div>
    <button class="btn ghost sm" id="reset" style="width:100%;margin-top:10px;color:#f85149;border-color:#3a1417">Reset all progress</button>`;
  document.getElementById("goal").onchange = e => { S.settings.dailyGoal = clamp(+e.target.value || 15, 1, 200); save(); toast("Saved"); };
  document.getElementById("exp").onclick = exportData;
  document.getElementById("imp").onclick = importData;
  document.getElementById("reset").onclick = () => { if (confirm("Erase all progress?")) { S = defaultState(); save(); go("practice"); } };
}
function exportData() {
  const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "quantprep-progress.json"; a.click(); toast("Exported");
}
function importData() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json";
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const rd = new FileReader();
    rd.onload = () => { try { S = Object.assign(defaultState(), JSON.parse(rd.result)); save(); toast("Imported"); go("practice"); } catch { toast("Bad file"); } }; rd.readAsText(f); };
  inp.click();
}

/* ---------------- boot ---------------- */
async function boot() {
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => go(b.dataset.tab));
  try { await loadBank(); } catch (e) { view().innerHTML = `<div class="empty">Couldn't load question bank.<br><span class="mini">${e}</span></div>`; return; }
  if (S.daily.day !== today()) S.daily = { day: today(), done: 0 };
  go("practice");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
boot();
