#!/usr/bin/env python3
"""Build app/bank.json — the single data file the app loads.

Merges raw questions + enrichment + taxonomy, computes 'more like this'
similarity neighbors (offline TF-IDF cosine over question text, boosted by
shared techniques), and emits per-question records plus the taxonomy.

Usage: python3 tools/build_bank.py
"""
import json, os, re, math
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "quantquestions_free.json")
ENR = os.path.join(ROOT, "data", "enrichment.json")
TAX = os.path.join(ROOT, "data", "techniques.json")
OUT = os.path.join(ROOT, "app", "bank.json")

STOP = set("a an the of to in on for and or is are be we you it that this with as at by from "
           "if then so what how many such each are will can let given find calculate "
           "probability expected number value all has have do does".split())

def tokenize(s):
    s = re.sub(r"\$[^$]*\$", " ", s or "")          # drop latex
    toks = re.findall(r"[a-zA-Z]{3,}", s.lower())
    return [t for t in toks if t not in STOP]

def main():
    raw = json.load(open(RAW))
    enr = json.load(open(ENR)) if os.path.exists(ENR) else {}
    tax = json.load(open(TAX))

    # --- merge ---
    questions = []
    for p in raw:
        e = enr.get(p["slug"], {})
        questions.append({
            "slug": p["slug"],
            "title": p["title"],
            "topic": p["topic"],
            "siteTags": p.get("tags", []),
            "difficulty": e.get("difficulty") or p.get("difficulty") or "medium",
            "companies": p.get("companies", []),
            "question": p["question"],
            "answer": p["answer"],
            "hint": p.get("hint", ""),
            "hints": e.get("hints"),                       # 3-tier ladder if generated
            "siteSolution": p.get("solution", ""),         # the 54 free ones
            "genSolution": e.get("solution", ""),          # generated for paywalled
            "solutionPaywalled": p.get("solutionPaywalled", False),
            "techniques": e.get("techniques", []),
            "primary": e.get("primary"),
            "firmStyle": e.get("firm_style", []),
        })

    # --- TF-IDF vectors ---
    docs = [tokenize(q["question"] + " " + q["title"]) for q in questions]
    df = Counter()
    for d in docs:
        for w in set(d): df[w] += 1
    N = len(docs)
    idf = {w: math.log(1 + N / df[w]) for w in df}
    vecs = []
    for d in docs:
        tf = Counter(d)
        v = {w: (tf[w] / len(d)) * idf[w] for w in tf} if d else {}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({w: x / norm for w, x in v.items()})

    # invert for speed
    postings = defaultdict(list)
    for i, v in enumerate(vecs):
        for w, x in v.items(): postings[w].append((i, x))

    # --- neighbors ---
    for i, q in enumerate(questions):
        sims = defaultdict(float)
        for w, x in vecs[i].items():
            for j, y in postings[w]:
                if j != i: sims[j] += x * y
        # boost shared techniques / primary
        for j, q2 in enumerate(questions):
            if j == i: continue
            shared = len(set(q["techniques"]) & set(q2["techniques"]))
            if shared: sims[j] += 0.15 * shared
            if q["primary"] and q["primary"] == q2["primary"]: sims[j] += 0.25
        top = sorted(sims.items(), key=lambda kv: -kv[1])[:6]
        q["similar"] = [questions[j]["slug"] for j, s in top if s > 0.05]

    bank = {
        "version": 1,
        "generated": True,
        "counts": {
            "total": len(questions),
            "tagged": sum(1 for q in questions if q["techniques"]),
            "withSolution": sum(1 for q in questions if q["siteSolution"].strip() or q["genSolution"].strip()),
        },
        "taxonomy": tax,
        "questions": questions,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(bank, open(OUT, "w"), ensure_ascii=False)
    print(f"wrote {OUT}")
    print(f"  questions: {bank['counts']['total']} | tagged: {bank['counts']['tagged']} | with solution: {bank['counts']['withSolution']}")

if __name__ == "__main__":
    main()
