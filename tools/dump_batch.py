#!/usr/bin/env python3
"""Dump a batch of questions for in-session enrichment.

Usage:
  python3 tools/dump_batch.py [--start N] [--count K] [--untagged] [--full]
  --untagged : only questions not yet technique-tagged in enrichment.json
  --full     : include full question text + hint + answer (for solution writing)
"""
import json, os, sys, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = json.load(open(os.path.join(ROOT, "data", "quantquestions_free.json")))
ENRP = os.path.join(ROOT, "data", "enrichment.json")
ENR = json.load(open(ENRP)) if os.path.exists(ENRP) else {}

ap = argparse.ArgumentParser()
ap.add_argument("--start", type=int, default=0)
ap.add_argument("--count", type=int, default=20)
ap.add_argument("--untagged", action="store_true")
ap.add_argument("--full", action="store_true")
a = ap.parse_args()

pool = RAW
if a.untagged:
    pool = [p for p in RAW if not ENR.get(p["slug"], {}).get("techniques")]

batch = pool[a.start:a.start + a.count]
print(f"# pool={len(pool)} showing [{a.start}:{a.start+a.count}] ({len(batch)} items)\n")
for p in batch:
    print(f"=== {p['slug']}")
    print(f"    title: {p['title']} | topic: {p['topic']} | siteTags: {p.get('tags')} | diff: {p['difficulty']} | paywalled: {p['solutionPaywalled']}")
    print(f"    answer: {p['answer']}")
    if a.full:
        print(f"    Q: {p['question']}")
        if p.get('hint'): print(f"    hint: {p['hint']}")
        if p.get('solution','').strip(): print(f"    SITE-SOLUTION: {p['solution']}")
    else:
        q = p['question'].replace('\n', ' ')
        print(f"    Q: {q[:200]}{'...' if len(q) > 200 else ''}")
    print()
