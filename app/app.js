/* QuantPrep — adaptive quant interview trainer (offline-first, vanilla JS) */
"use strict";

/* ---------------- storage ---------------- */
const SKEY = "qp_state_v1";
const DAY = 86400000;
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const defaultState = () => ({
  cards: {},            // slug -> {ease,interval,due,reps,lapses,lastTs}
  tech: {},             // techId -> {m, seen, ts}   (m = mastery 0..100)
  topic: {},            // topic  -> {m, seen}
  attempts: [],         // {slug, ts, grade, conf, correct, secs}
  streak: { count: 0, lastDay: null },
  mm: { best: 0, sessions: 0, totalCorrect: 0 },
  settings: { dailyGoal: 15, apiKey: "" },
  daily: { day: today(), done: 0, mm: 0 },
});

let S = load();
function load() {
  try { return Object.assign(defaultState(), JSON.parse(localStorage.getItem(SKEY) || "{}")); }
  catch { return defaultState(); }
}
function save() { localStorage.setItem(SKEY, JSON.stringify(S)); }

/* ---------------- bank ---------------- */
let BANK = null, Q = [], BYSLUG = {}, TAX = null, TECH = {}, FAM = {};
async function loadBank() {
  const r = await fetch("bank.json", { cache: "no-cache" });
  BANK = await r.json();
  Q = BANK.questions; TAX = BANK.taxonomy;
  Q.forEach(q => BYSLUG[q.slug] = q);
  TAX.techniques.forEach(t => TECH[t.id] = t);
  TAX.families.forEach(f => FAM[f.id] = f);
}

/* skills a question trains: enriched techniques, else fall back to site tags/topic */
function skillsOf(q) { return (q.techniques && q.techniques.length) ? q.techniques : []; }
function famOf(techId) { return TECH[techId] ? TECH[techId].family : null; }

/* ---------------- mastery + scheduling ---------------- */
const GRADE = { again: 0, hard: 1, good: 2, easy: 3 };
const gradeBase = [0.15, 0.5, 0.85, 1.0];          // target mastery contribution by grade
const diffMul = { easy: 0.85, medium: 1.0, hard: 1.2 };

function applyAttempt(q, gradeName, conf, secs) {
  const g = GRADE[gradeName];
  const correct = g >= 2;
  // --- SRS card ---
  const c = S.cards[q.slug] || { ease: 2.3, interval: 0, due: 0, reps: 0, lapses: 0 };
  if (g === 0) { c.ease = Math.max(1.3, c.ease - 0.2); c.interval = 0; c.reps = 0; c.lapses++; }
  else if (g === 1) { c.ease = Math.max(1.3, c.ease - 0.05); c.interval = Math.max(1, (c.interval || 1) * 1.2); c.reps++; }
  else if (g === 2) { c.interval = c.reps === 0 ? 1 : c.interval * c.ease; c.reps++; }
  else { c.ease += 0.05; c.interval = c.reps === 0 ? 2 : c.interval * c.ease * 1.3; c.reps++; }
  c.due = now() + Math.round((g === 0 ? 0.007 : c.interval) * DAY);  // 'again' ~10 min
  c.lastTs = now();
  S.cards[q.slug] = c;

  // --- technique mastery (EMA) ---
  const target = gradeBase[g] * 100;
  const dm = diffMul[q.difficulty] || 1;
  const alpha = 0.34;
  const sk = skillsOf(q);
  sk.forEach(tid => {
    const t = S.tech[tid] || { m: 35, seen: 0 };   // start a touch below neutral
    const step = (target - t.m) * alpha * (correct ? dm : 1);
    t.m = clamp(t.m + step, 0, 100); t.seen++; t.ts = now();
    S.tech[tid] = t;
  });
  // --- topic mastery (always, for fallback dashboard) ---
  const tp = S.topic[q.topic] || { m: 35, seen: 0 };
  tp.m = clamp(tp.m + (target - tp.m) * alpha, 0, 100); tp.seen++;
  S.topic[q.topic] = tp;

  // --- log + streak + daily ---
  S.attempts.push({ slug: q.slug, ts: now(), grade: g, conf, correct, secs });
  if (S.attempts.length > 4000) S.attempts = S.attempts.slice(-4000);
  bumpDaily();
  save();
}

function bumpDaily() {
  if (S.daily.day !== today()) S.daily = { day: today(), done: 0, mm: 0 };
  S.daily.done++;
  // streak
  const d = today();
  if (S.streak.lastDay !== d) {
    const y = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    S.streak.count = (S.streak.lastDay === y) ? S.streak.count + 1 : 1;
    S.streak.lastDay = d;
  }
}

/* technique effective mastery (decays toward 0 if not seen for a while) */
function techMastery(tid) {
  const t = S.tech[tid]; if (!t) return 0;
  const days = (now() - (t.ts || now())) / DAY;
  const decay = Math.exp(-days / 90);              // ~3 month half-ish life
  return t.m * (0.5 + 0.5 * decay);                // never decays below half of stored
}
function famMastery(fid) {
  const ts = TAX.techniques.filter(t => t.family === fid);
  if (!ts.length) return 0;
  return ts.reduce((s, t) => s + techMastery(t.id), 0) / ts.length;
}
function isUnlocked(tid) {
  const t = TECH[tid];
  return (t.prereqs || []).every(p => techMastery(p) >= 45);
}

/* readiness: blend of average mastery and coverage */
function readiness() {
  const all = TAX.techniques;
  const avg = all.reduce((s, t) => s + techMastery(t.id), 0) / all.length;
  const coveredTech = all.filter(t => (S.tech[t.id] && S.tech[t.id].seen > 0)).length;
  const coverage = coveredTech / all.length;
  const r = 0.72 * avg + 0.28 * coverage * 100;
  return Math.round(clamp(r, 0, 100));
}

/* ---------------- adaptive picker ---------------- */
function dueCards() {
  const t = now();
  return Q.filter(q => S.cards[q.slug] && S.cards[q.slug].due <= t)
          .sort((a, b) => S.cards[a.slug].due - S.cards[b.slug].due);
}
function weakestTechniques(n = 6) {
  return TAX.techniques
    .filter(t => isUnlocked(t.id))
    .map(t => ({ id: t.id, m: techMastery(t.id), seen: (S.tech[t.id]?.seen || 0) }))
    .sort((a, b) => (a.m - b.m) || (a.seen - b.seen))
    .slice(0, n).map(x => x.id);
}
function diffRank(d) { return d === "easy" ? 0 : d === "hard" ? 2 : 1; }

/* build a session of up to `size` questions */
function buildSession(size = 12, opts = {}) {
  const seen = new Set();
  const out = [];
  const push = q => { if (q && !seen.has(q.slug)) { seen.add(q.slug); out.push(q); } };

  if (opts.filterFn) {
    const pool = Q.filter(opts.filterFn);
    // due first within filter, then new easiest-first
    pool.filter(q => S.cards[q.slug] && S.cards[q.slug].due <= now()).forEach(push);
    pool.filter(q => !S.cards[q.slug]).sort((a,b)=>diffRank(a.difficulty)-diffRank(b.difficulty)).forEach(push);
    pool.forEach(push);
    return out.slice(0, size);
  }

  // 1) reviews due (cap ~half the session)
  dueCards().slice(0, Math.ceil(size / 2)).forEach(push);
  // 2) new questions in weak techniques, easier first
  const weak = new Set(weakestTechniques(8));
  const fresh = Q.filter(q => !S.cards[q.slug]);
  const target = fresh.filter(q => skillsOf(q).some(t => weak.has(t)));
  target.sort((a, b) => diffRank(a.difficulty) - diffRank(b.difficulty) + (Math.random() - .5));
  target.forEach(push);
  // 3) any new question (covers unenriched), easiest first
  fresh.sort((a, b) => diffRank(a.difficulty) - diffRank(b.difficulty) + (Math.random() - .5)).forEach(push);
  // 4) fallback: anything
  Q.slice().sort(() => Math.random() - .5).forEach(push);
  return out.slice(0, size);
}

/* ---------------- view routing ---------------- */
const view = () => document.getElementById("view");
let CURRENT = "home";
function go(tab) {
  CURRENT = tab;
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  ({ home: renderHome, practice: renderPracticeHome, roadmap: renderRoadmap, drills: renderDrills, stats: renderStats }[tab])();
  view().scrollTop = 0;
  refreshBadges();
}
function refreshBadges() {
  document.getElementById("streakBadge").textContent = "🔥 " + (S.streak.count || 0);
  const r = readiness();
  const b = document.getElementById("readinessBadge");
  b.textContent = r + "%";
  b.style.color = r < 33 ? "#ff7b72" : r < 66 ? "#e3b341" : "#56d364";
}

/* katex render helper */
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
  t.textContent = msg; t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 1600);
}

/* ---------------- HOME ---------------- */
function ringSVG(pct, label) {
  const R = 42, C = 2 * Math.PI * R, off = C * (1 - pct / 100);
  const col = pct < 33 ? "#f85149" : pct < 66 ? "#d29922" : "#3fb950";
  return `<div class="ring"><svg width="96" height="96" viewBox="0 0 96 96">
    <circle cx="48" cy="48" r="${R}" stroke="#1c232d" stroke-width="9" fill="none"/>
    <circle cx="48" cy="48" r="${R}" stroke="${col}" stroke-width="9" fill="none"
      stroke-dasharray="${C}" stroke-dashoffset="${off}" stroke-linecap="round"/>
  </svg><div class="val"><b>${pct}%</b><span>${label}</span></div></div>`;
}
function renderHome() {
  const r = readiness();
  const due = dueCards().length;
  const goal = S.settings.dailyGoal, done = S.daily.day === today() ? S.daily.done : 0;
  const tagged = BANK.counts.tagged, total = BANK.counts.total;
  const weak = weakestTechniques(3).map(id => TECH[id]?.name).filter(Boolean);

  view().innerHTML = `
    <div class="card">
      <div class="ring-wrap">
        ${ringSVG(r, "Ready")}
        <div style="flex:1">
          <div class="h2">Interview readiness</div>
          <div class="muted" style="font-size:13.5px">${readinessBlurb(r)}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row spread"><div class="h2">Today's plan</div><div class="mini">${done}/${goal} done</div></div>
      <div class="bar" style="margin:10px 0 14px"><i style="width:${clamp(done/goal*100,0,100)}%"></i></div>
      <div class="btn-row">
        <button class="btn" id="startBtn">${due>0?`Review ${due} + learn`:"Start practicing"}</button>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn alt sm" id="mmBtn">⚡ Mental-math sprint</button>
        <button class="btn alt sm" id="mockBtn">▶ Quick mock</button>
      </div>
    </div>

    <div class="section-title">Focus next</div>
    <div class="card">
      ${weak.length ? weak.map(w=>`<div class="row" style="padding:6px 0"><span class="dot" style="background:var(--ac)"></span><span>${esc(w)}</span></div>`).join("")
        : `<div class="dim">Do a few questions and I'll surface your weak spots here.</div>`}
      <button class="btn ghost sm" style="margin-top:10px;width:100%" data-go="roadmap">See full roadmap →</button>
    </div>

    <div class="section-title">Question bank</div>
    <div class="card">
      <div class="row spread"><span class="muted">Free questions loaded</span><b>${total}</b></div>
      <div class="row spread" style="margin-top:8px"><span class="muted">Technique-tagged</span><b>${tagged} <span class="dim">(${Math.round(tagged/total*100)}%)</span></b></div>
      <div class="row spread" style="margin-top:8px"><span class="muted">With worked solution</span><b>${BANK.counts.withSolution}</b></div>
      ${tagged<total?`<div class="mini" style="margin-top:10px">More tagging & solutions are being added — the app gets smarter automatically as they land.</div>`:""}
    </div>`;

  document.getElementById("startBtn").onclick = () => startSession(buildSession(12));
  document.getElementById("mmBtn").onclick = () => go("drills");
  document.getElementById("mockBtn").onclick = () => startMock();
  view().querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  mathify(view());
}
function readinessBlurb(r){
  if(r<20) return "Just getting started. Build fundamentals first — counting, basic probability, expectation.";
  if(r<40) return "Foundations forming. Keep a daily streak; focus on your weakest techniques.";
  if(r<60) return "Solid core. Start interleaving harder topics and timed drills.";
  if(r<80) return "Strong. Drill speed, edge cases, and run mock interviews.";
  return "Interview-ready. Maintain with reviews and mocks to stay sharp.";
}

/* ---------------- PRACTICE ---------------- */
function renderPracticeHome() {
  const fams = TAX.families.map(f => {
    const m = Math.round(famMastery(f.id));
    const n = Q.filter(q => skillsOf(q).some(t => famOf(t) === f.id)).length;
    return { f, m, n };
  });
  view().innerHTML = `
    <div class="section-title">Practice</div>
    <div class="card tap" id="adaptiveCard">
      <div class="row spread"><div><div class="h2">Adaptive session</div><div class="muted">12 questions picked for you — reviews + weak spots.</div></div><div class="big">→</div></div>
    </div>
    <div class="card tap" data-diff="easy"><div class="row spread"><div class="h2">Warm-up (easy)</div><span class="diff easy">easy</span></div></div>
    <div class="card tap" data-diff="hard"><div class="row spread"><div class="h2">Challenge (hard)</div><span class="diff hard">hard</span></div></div>

    <div class="section-title">By category</div>
    <div class="card">
      ${fams.map(x=>`<div class="tech" data-fam="${x.f.id}">
        <span class="dot" style="background:${x.f.color}"></span>
        <span class="name">${x.f.name}<div class="mini">${x.n} questions</div></span>
        <div style="width:64px"><div class="bar"><i style="width:${x.m}%"></i></div></div>
      </div>`).join("")}
    </div>
    <div class="section-title">Browse by site tag</div>
    <div class="card" id="tagCloud"></div>`;

  document.getElementById("adaptiveCard").onclick = () => startSession(buildSession(12));
  view().querySelectorAll("[data-diff]").forEach(c => c.onclick = () =>
    startSession(buildSession(12, { filterFn: q => q.difficulty === c.dataset.diff })));
  view().querySelectorAll("[data-fam]").forEach(c => c.onclick = () =>
    startSession(buildSession(15, { filterFn: q => skillsOf(q).some(t => famOf(t) === c.dataset.fam) })));

  // tag cloud from site tags (works even before enrichment)
  const tags = {};
  Q.forEach(q => (q.siteTags.length ? q.siteTags : [cap(q.topic)]).forEach(t => tags[t] = (tags[t] || 0) + 1));
  const cloud = document.getElementById("tagCloud");
  cloud.innerHTML = Object.entries(tags).sort((a,b)=>b[1]-a[1])
    .map(([t,n]) => `<span class="chip" data-tag="${esc(t)}">${esc(t)} ${n}</span>`).join("");
  cloud.querySelectorAll("[data-tag]").forEach(ch => ch.onclick = () => {
    const t = ch.dataset.tag;
    startSession(buildSession(20, { filterFn: q => (q.siteTags.includes(t) || cap(q.topic) === t) }));
  });
}
function cap(s){ return (s||"").replace(/\b\w/g, c=>c.toUpperCase()); }

/* ---------- session runner ---------- */
let SESSION = null;
function startSession(list, meta = {}) {
  if (!list.length) { toast("No questions match."); return; }
  SESSION = { list, i: 0, meta, correct: 0, started: now() };
  renderQuestion();
}
function startMock(){
  // quick mock: a spread across difficulties/topics, timed feel
  const easy = buildSession(2, { filterFn:q=>q.difficulty==="easy" });
  const med = buildSession(3, { filterFn:q=>q.difficulty==="medium" });
  const hard = buildSession(1, { filterFn:q=>q.difficulty==="hard" });
  startSession([...easy,...med,...hard], { mock:true });
}

function renderQuestion() {
  const s = SESSION; if (!s) return;
  if (s.i >= s.list.length) return renderSessionDone();
  const q = s.list[s.i];
  s.qStart = now(); s.revealed = false; s.hintLevel = 0; s.conf = null;
  const hints = (q.hints && q.hints.length === 3) ? q.hints : (q.hint ? [q.hint] : []);
  const sol = q.genSolution || q.siteSolution || "";
  const skchips = skillsOf(q).map(t => `<span class="chip">${esc(TECH[t]?.name||t)}</span>`).join("")
                 || (q.siteTags.map(t=>`<span class="chip">${esc(t)}</span>`).join(""));

  view().innerHTML = `
    <div class="row spread" style="margin-bottom:8px">
      <span class="mini">${s.i + 1} / ${s.list.length}${s.meta.mock?" · mock":""}</span>
      <span class="mini" id="timer">0s</span>
    </div>
    <div class="bar" style="margin-bottom:14px"><i style="width:${(s.i)/s.list.length*100}%"></i></div>

    <div class="card">
      <div class="qmeta">
        <span class="diff ${q.difficulty}">${q.difficulty}</span>
        ${skchips}
      </div>
      <div class="qtext">${esc(q.question)}</div>

      <div id="preReveal">
        <div class="label" style="margin-top:16px">How confident are you?</div>
        <div class="conf-row">
          <div class="grade" data-conf="1">Guess</div>
          <div class="grade" data-conf="2">Unsure</div>
          <div class="grade" data-conf="3">Fairly</div>
          <div class="grade" data-conf="4">Certain</div>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn alt" id="hintBtn">💡 Hint</button>
          <button class="btn" id="revealBtn">Reveal answer</button>
        </div>
        <div id="hintZone" style="margin-top:12px"></div>
      </div>

      <div id="reveal"></div>
    </div>

    <button class="btn ghost sm" id="skipBtn" style="width:100%">Skip</button>
  `;
  // timer
  clearInterval(s._tmr);
  s._tmr = setInterval(() => { const el = document.getElementById("timer"); if (el) el.textContent = Math.round((now() - s.qStart) / 1000) + "s"; }, 1000);

  view().querySelectorAll("[data-conf]").forEach(b => b.onclick = () => {
    s.conf = +b.dataset.conf;
    view().querySelectorAll("[data-conf]").forEach(x => x.style.borderColor = "var(--line)");
    b.style.borderColor = "var(--ac)";
  });
  document.getElementById("hintBtn").onclick = () => {
    const z = document.getElementById("hintZone");
    if (s.hintLevel >= hints.length) { toast("No more hints"); return; }
    const h = document.createElement("div"); h.className = "hint";
    h.innerHTML = `<b>Hint ${s.hintLevel + 1}:</b> ${esc(hints[s.hintLevel])}`;
    z.appendChild(h); mathify(h); s.hintLevel++;
  };
  document.getElementById("revealBtn").onclick = () => revealAnswer(q, sol);
  document.getElementById("skipBtn").onclick = () => { s.i++; renderQuestion(); };
  mathify(view());
}

function revealAnswer(q, sol) {
  const s = SESSION; s.revealed = true; s.secs = Math.round((now() - s.qStart) / 1000);
  document.getElementById("preReveal").style.display = "none";
  const paywalled = q.solutionPaywalled && !q.genSolution;
  const rv = document.getElementById("reveal");
  rv.className = "reveal";
  rv.innerHTML = `
    <div class="label">Answer</div>
    <div class="answer-box">${esc(q.answer) || "—"}</div>
    ${sol ? `<div class="label" style="margin-top:14px">Worked solution</div><div class="solution">${esc(sol)}</div>`
          : (paywalled ? `<div class="mini" style="margin-top:12px">Full worked solution coming soon (being generated). Use the answer + hints for now.</div>` : "")}
    ${q.similar && q.similar.length ? `<div class="label" style="margin-top:16px">More like this</div>
      <div id="similar">${q.similar.slice(0,4).map(sl=>`<span class="chip" data-sl="${sl}">${esc(BYSLUG[sl]?.title||sl)}</span>`).join("")}</div>`:""}

    <div class="label" style="margin-top:18px">How did it go?</div>
    <div class="grade-grid">
      <div class="grade again" data-g="again">Missed it<small>see again soon</small></div>
      <div class="grade hard" data-g="hard">Got it, hard<small>shorter interval</small></div>
      <div class="grade good" data-g="good">Solid<small>normal</small></div>
      <div class="grade easy2" data-g="easy">Easy<small>longer interval</small></div>
    </div>`;
  rv.querySelectorAll("[data-g]").forEach(b => b.onclick = () => {
    applyAttempt(q, b.dataset.g, s.conf || 2, s.secs);
    if (b.dataset.g !== "again") s.correct++;
    s.i++; renderQuestion(); refreshBadges();
  });
  rv.querySelectorAll("[data-sl]").forEach(b => b.onclick = () => {
    const q2 = BYSLUG[b.dataset.sl]; if (q2 && !SESSION.list.slice(SESSION.i+1).includes(q2)) SESSION.list.splice(SESSION.i + 1, 0, q2);
    toast("Added to queue");
  });
  mathify(rv);
}

function renderSessionDone() {
  clearInterval(SESSION._tmr);
  const s = SESSION, n = s.list.length, acc = n ? Math.round(s.correct / n * 100) : 0;
  const mins = Math.round((now() - s.started) / 60000);
  view().innerHTML = `
    <div class="card" style="text-align:center;padding:28px 16px">
      <div class="big" style="font-size:46px">🎯</div>
      <div class="h2" style="margin-top:6px">Session complete</div>
      <div class="grid2" style="margin-top:18px">
        <div><div class="big">${s.correct}/${n}</div><div class="mini">solved</div></div>
        <div><div class="big">${acc}%</div><div class="mini">accuracy</div></div>
      </div>
      <div class="mini" style="margin-top:10px">${mins} min · streak 🔥 ${S.streak.count}</div>
      <div class="btn-row" style="margin-top:22px">
        <button class="btn" id="again">Another set</button>
        <button class="btn alt" id="home2">Home</button>
      </div>
    </div>`;
  document.getElementById("again").onclick = () => startSession(buildSession(12));
  document.getElementById("home2").onclick = () => go("home");
  refreshBadges();
}

/* ---------------- ROADMAP ---------------- */
function renderRoadmap() {
  const r = readiness();
  let html = `<div class="card"><div class="row spread"><div class="h2">Your roadmap</div>${ringSVGmini(r)}</div>
    <div class="muted" style="font-size:13.5px;margin-top:6px">Master techniques bottom-up. Locked ones unlock when their prerequisites pass ~45%.</div></div>`;

  // mastery radar
  html += `<div class="card"><div class="label">Mastery by area</div><div class="radar-wrap">${radarSVG()}</div></div>`;

  TAX.families.forEach(f => {
    const ts = TAX.techniques.filter(t => t.family === f.id).sort((a,b)=>a.tier-b.tier);
    const fm = Math.round(famMastery(f.id));
    html += `<div class="section-title" style="display:flex;justify-content:space-between"><span style="color:${f.color}">${f.name}</span><span>${fm}%</span></div><div class="card">`;
    ts.forEach(t => {
      const m = Math.round(techMastery(t.id));
      const unlocked = isUnlocked(t.id);
      const col = m >= 70 ? "#3fb950" : m >= 40 ? "#d29922" : unlocked ? "#6b7785" : "#39414d";
      const n = Q.filter(q => skillsOf(q).includes(t.id)).length;
      html += `<div class="tech" ${unlocked&&n?`data-train="${t.id}"`:""} style="${!unlocked?'opacity:.55':''}">
        <span class="dot" style="background:${col}"></span>
        <span class="name">${t.name}${n?`<div class="mini">${n} questions${unlocked?"":" · 🔒 locked"}</div>`:`<div class="mini dim">no questions yet</div>`}</span>
        <span class="mini" style="width:40px;text-align:right">${m}%</span>
      </div>`;
    });
    html += `</div>`;
  });
  view().innerHTML = html;
  view().querySelectorAll("[data-train]").forEach(el => el.onclick = () => {
    const tid = el.dataset.train;
    startSession(buildSession(12, { filterFn: q => skillsOf(q).includes(tid) }));
  });
}
function ringSVGmini(pct){ const C=2*Math.PI*16,off=C*(1-pct/100),col=pct<33?"#f85149":pct<66?"#d29922":"#3fb950";
  return `<svg width="44" height="44" viewBox="0 0 44 44" style="transform:rotate(-90deg)"><circle cx="22" cy="22" r="16" stroke="#1c232d" stroke-width="5" fill="none"/><circle cx="22" cy="22" r="16" stroke="${col}" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/></svg>`; }
function radarSVG() {
  const fams = TAX.families, n = fams.length, cx = 130, cy = 130, R = 100;
  const pt = (i, rad) => [cx + rad * Math.cos(-Math.PI/2 + i*2*Math.PI/n), cy + rad * Math.sin(-Math.PI/2 + i*2*Math.PI/n)];
  let grid = ""; [0.25,0.5,0.75,1].forEach(g => { grid += `<polygon points="${fams.map((_,i)=>pt(i,R*g).join(",")).join(" ")}" fill="none" stroke="#262d38"/>`; });
  const poly = fams.map((f,i)=>pt(i, R*clamp(famMastery(f.id)/100,0.02,1)).join(",")).join(" ");
  const labels = fams.map((f,i)=>{ const [x,y]=pt(i,R+14); return `<text x="${x}" y="${y}" fill="#6b7785" font-size="8" text-anchor="middle">${f.name.split(" ")[0]}</text>`; }).join("");
  return `<svg width="260" height="260" viewBox="0 0 260 260">${grid}
    <polygon points="${poly}" fill="rgba(79,141,253,.25)" stroke="#4f8dfd" stroke-width="2"/>${labels}</svg>`;
}

/* ---------------- DRILLS (mental math) ---------------- */
let MM = null;
function renderDrills() {
  view().innerHTML = `
    <div class="section-title">Mental math sprint</div>
    <div class="card">
      <div class="muted">60 seconds. Fast arithmetic, fractions, %. Interviews test this hard.</div>
      <div class="mm-stat" style="margin:16px 0">
        <div><b>${S.mm.best}</b><span class="mini">best</span></div>
        <div><b>${S.mm.sessions}</b><span class="mini">sprints</span></div>
        <div><b>${S.mm.totalCorrect}</b><span class="mini">total</span></div>
      </div>
      <button class="btn" id="mmStart">Start 60s sprint</button>
    </div>
    <div class="section-title">Estimation</div>
    <div class="card"><div class="muted">Fermi-style estimation drills — coming in the live-AI layer (needs API key in Settings).</div></div>
    <div class="section-title">Settings</div>
    <div class="card" id="settings"></div>`;
  document.getElementById("mmStart").onclick = startMM;
  renderSettings();
}
function genMM() {
  const r = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const type = r(1, 5);
  if (type === 1) { const a = r(12, 99), b = r(12, 99); return [`${a} + ${b}`, a + b]; }
  if (type === 2) { const a = r(20, 199), b = r(10, a); return [`${a} − ${b}`, a - b]; }
  if (type === 3) { const a = r(3, 19), b = r(3, 19); return [`${a} × ${b}`, a * b]; }
  if (type === 4) { const b = r(3, 12), q = r(3, 12), a = b * q; return [`${a} ÷ ${b}`, q]; }
  const base = r(40, 400), p = [10,20,25,50,5][r(0,4)]; return [`${p}% of ${base}`, base * p / 100];
}
function startMM() {
  MM = { score: 0, end: now() + 60000, cur: genMM() };
  paintMM();
  MM.t = setInterval(() => { if (now() >= MM.end) endMM(); else { const el=document.getElementById("mmTime"); if(el) el.textContent = Math.ceil((MM.end-now())/1000)+"s"; } }, 250);
}
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
    else { inp.style.borderColor = "#f85149"; setTimeout(()=>inp.style.borderColor="var(--line)",200); }
    MM.cur = genMM(); document.querySelector(".mm-display").textContent = MM.cur[0]; inp.value=""; inp.focus();
  };
  document.getElementById("mmGo").onclick = submit;
  inp.onkeydown = e => { if (e.key === "Enter") submit(); };
}
function endMM() {
  clearInterval(MM.t);
  S.mm.sessions++; S.mm.totalCorrect += MM.score; S.mm.best = Math.max(S.mm.best, MM.score);
  if (S.daily.day !== today()) S.daily = { day: today(), done: 0, mm: 0 }; S.daily.mm++;
  // mental-math counts toward arithmetic mastery
  ["arithmetic_speed","fractions_decimals"].forEach(tid=>{ const t=S.tech[tid]||{m:35,seen:0}; t.m=clamp(t.m + (clamp(MM.score*6,10,95)-t.m)*0.3,0,100); t.seen++; t.ts=now(); S.tech[tid]=t; });
  save(); refreshBadges();
  view().innerHTML = `<div class="card" style="text-align:center;padding:26px">
    <div class="big" style="font-size:44px">⚡</div>
    <div class="h2">${MM.score} correct</div>
    <div class="mini">${MM.score>S.mm.best-1&&MM.score===S.mm.best?"New best!":"Best: "+S.mm.best}</div>
    <div class="btn-row" style="margin-top:20px"><button class="btn" id="mmAgain">Again</button><button class="btn alt" id="mmBack">Back</button></div>
  </div>`;
  document.getElementById("mmAgain").onclick = startMM;
  document.getElementById("mmBack").onclick = () => go("drills");
}

/* ---------------- STATS ---------------- */
function renderStats() {
  const a = S.attempts, n = a.length;
  const correct = a.filter(x => x.correct).length;
  const acc = n ? Math.round(correct / n * 100) : 0;
  const avgSecs = n ? Math.round(a.reduce((s,x)=>s+(x.secs||0),0)/n) : 0;
  // calibration: among confident (>=3) how often correct; among guesses (<=2)
  const conf = a.filter(x=>x.conf>=3), low = a.filter(x=>x.conf<=2);
  const confAcc = conf.length?Math.round(conf.filter(x=>x.correct).length/conf.length*100):null;
  const lowAcc = low.length?Math.round(low.filter(x=>x.correct).length/low.length*100):null;
  // last 14 days heatmap
  const byDay = {}; a.forEach(x=>{ const d=new Date(x.ts).toISOString().slice(0,10); byDay[d]=(byDay[d]||0)+1; });
  let heat=""; for(let i=13;i>=0;i--){ const d=new Date(Date.now()-i*DAY).toISOString().slice(0,10); const c=byDay[d]||0;
    const bg=c===0?"#1c232d":c<5?"#1f3a2a":c<12?"#2a6b3f":"#3fb950"; heat+=`<div title="${d}: ${c}" style="width:100%;aspect-ratio:1;border-radius:4px;background:${bg}"></div>`; }

  view().innerHTML = `
    <div class="section-title">Progress</div>
    <div class="card"><div class="grid2">
      <div><div class="big">${n}</div><div class="mini">attempts</div></div>
      <div><div class="big">${acc}%</div><div class="mini">accuracy</div></div>
      <div><div class="big">${avgSecs}s</div><div class="mini">avg / question</div></div>
      <div><div class="big">${dueCards().length}</div><div class="mini">reviews due</div></div>
    </div></div>

    <div class="section-title">Activity (14 days)</div>
    <div class="card"><div style="display:grid;grid-template-columns:repeat(14,1fr);gap:4px">${heat}</div></div>

    <div class="section-title">Confidence calibration</div>
    <div class="card">
      ${confAcc!==null?`<div class="row spread"><span class="muted">When "fairly/certain"</span><b>${confAcc}% right</b></div>`:""}
      ${lowAcc!==null?`<div class="row spread" style="margin-top:8px"><span class="muted">When "guess/unsure"</span><b>${lowAcc}% right</b></div>`:""}
      ${confAcc!==null?`<div class="mini" style="margin-top:10px">${calibNote(confAcc)}</div>`:`<div class="dim">Log confidence on questions to see calibration — a key trading skill.</div>`}
    </div>

    <div class="section-title">Data</div>
    <div class="card">
      <div class="btn-row"><button class="btn alt sm" id="exp">Export progress</button><button class="btn alt sm" id="imp">Import</button></div>
      <button class="btn ghost sm" id="reset" style="width:100%;margin-top:10px;color:#f85149;border-color:#3a1417">Reset all progress</button>
    </div>`;
  document.getElementById("exp").onclick = exportData;
  document.getElementById("imp").onclick = importData;
  document.getElementById("reset").onclick = () => { if (confirm("Erase all progress?")) { S = defaultState(); save(); go("home"); } };
}
function calibNote(c){ return c>=85?"Well-calibrated when confident. Good.":c>=65?"Slightly overconfident — double-check before committing.":"Overconfident: you're wrong often when sure. Slow down and verify."; }

function renderSettings() {
  const el = document.getElementById("settings");
  el.innerHTML = `
    <label class="mini">Daily goal (questions)</label>
    <input id="goal" class="mm-input" style="font-size:18px;text-align:left;margin:6px 0 14px" inputmode="numeric" value="${S.settings.dailyGoal}">
    <label class="mini">Anthropic API key (optional — enables live mock interviews & grading)</label>
    <input id="key" class="mm-input" style="font-size:14px;text-align:left;margin-top:6px" placeholder="sk-ant-... (stored only on this device)" value="${S.settings.apiKey?"••••••••":""}">
    <button class="btn alt sm" id="saveSet" style="width:100%;margin-top:12px">Save settings</button>`;
  document.getElementById("saveSet").onclick = () => {
    S.settings.dailyGoal = clamp(+document.getElementById("goal").value || 15, 1, 200);
    const k = document.getElementById("key").value; if (k && !k.startsWith("•")) S.settings.apiKey = k.trim();
    save(); toast("Saved");
  };
}
function exportData() {
  const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = "quantprep-progress.json"; a.click(); toast("Exported");
}
function importData() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json";
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const rd = new FileReader();
    rd.onload = () => { try { S = Object.assign(defaultState(), JSON.parse(rd.result)); save(); toast("Imported"); go("home"); } catch { toast("Bad file"); } }; rd.readAsText(f); };
  inp.click();
}

/* ---------------- boot ---------------- */
async function boot() {
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => go(b.dataset.tab));
  try { await loadBank(); } catch (e) { view().innerHTML = `<div class="empty">Couldn't load question bank.<br><span class="mini">${e}</span></div>`; return; }
  if (S.daily.day !== today()) S.daily = { day: today(), done: 0, mm: 0 };
  go("home");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
}
boot();
