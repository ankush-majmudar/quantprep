#!/usr/bin/env python3
"""Merge an enrichment batch (JSON array of records) into data/enrichment.json.

Each record is keyed by 'slug' and may contain any subset of:
  techniques [str], primary [str], difficulty [easy|medium|hard],
  firm_style [str], hints [str x3], solution [str], notes [str]
Existing fields for a slug are updated (shallow merge), not wiped.

Usage: python3 tools/apply_enrichment.py <batchfile.json> [--validate]
"""
import json, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENR = os.path.join(ROOT, "data", "enrichment.json")
RAW = os.path.join(ROOT, "data", "quantquestions_free.json")
TAX = os.path.join(ROOT, "data", "techniques.json")

ALLOWED = {"techniques","primary","difficulty","firm_style","hints","solution","notes","solution_verified"}
DIFF = {"easy","medium","hard"}

def load(p, default):
    return json.load(open(p)) if os.path.exists(p) else default

def main():
    if len(sys.argv) < 2:
        print("usage: apply_enrichment.py <batchfile.json>"); sys.exit(1)
    batch = json.load(open(sys.argv[1]))
    enr = load(ENR, {})
    raw = {p["slug"]: p for p in load(RAW, [])}
    tax_ids = {t["id"] for t in load(TAX, {"techniques":[]})["techniques"]}

    warnings = []
    for rec in batch:
        slug = rec.get("slug")
        if not slug:
            warnings.append("record missing slug"); continue
        if slug not in raw:
            warnings.append(f"unknown slug: {slug}"); continue
        clean = {}
        for k, v in rec.items():
            if k == "slug": continue
            if k not in ALLOWED:
                warnings.append(f"{slug}: dropped unknown field '{k}'"); continue
            clean[k] = v
        # light validation
        for tid in clean.get("techniques", []):
            if tid not in tax_ids: warnings.append(f"{slug}: unknown technique '{tid}'")
        if "primary" in clean and clean["primary"] not in tax_ids:
            warnings.append(f"{slug}: unknown primary '{clean['primary']}'")
        if "difficulty" in clean and clean["difficulty"] not in DIFF:
            warnings.append(f"{slug}: bad difficulty '{clean['difficulty']}'")
        if "hints" in clean and len(clean["hints"]) != 3:
            warnings.append(f"{slug}: expected 3 hints, got {len(clean['hints'])}")
        enr.setdefault(slug, {}).update(clean)

    json.dump(enr, open(ENR, "w"), ensure_ascii=False, indent=1)
    enriched = len(enr)
    tagged = sum(1 for v in enr.values() if v.get("techniques"))
    with_sol = sum(1 for v in enr.values() if (v.get("solution") or "").strip())
    print(f"merged {len(batch)} records -> enrichment.json")
    print(f"  total slugs enriched: {enriched}/{len(raw)} | tagged: {tagged} | with generated solution: {with_sol}")
    if warnings:
        print(f"  WARNINGS ({len(warnings)}):")
        for w in warnings[:40]: print("   -", w)

if __name__ == "__main__":
    main()
