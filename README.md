# QuantPrep

An offline-first quant-trading-interview practice app: 764 free questions from
quantquestions.io, each enriched with technique tags, a 3-tier hint ladder, and
(for most) a verified worked solution. Includes spaced repetition, a skill-tree
roadmap, mastery tracking, mental-math drills, and similar-question clustering.

**Live demo:** https://ankush-majmudar.github.io/quantprep/

Your progress is stored locally in your own browser (`localStorage`), so every
person/device has a completely independent save — no accounts, no server.

---

## Use it (no setup)

Open the live URL above in Safari (iPhone) or Chrome (Android), then
**Add to Home Screen / Install app**. It caches everything and runs offline.

## Run it locally

```bash
cd app
python3 -m http.server 8765
# then open http://localhost:8765/
```

## Make it your OWN editable + deployable copy

1. On GitHub, click **Fork** at the top-right of the repo. You now have
   `https://github.com/<you>/quantprep` — fully independent of the original.
2. In your fork: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push any change (or use **Actions → Deploy QuantPrep to Pages → Run workflow**).
4. Your version goes live at `https://<you>.github.io/quantprep/`.

Edit away — nothing you do affects anyone else's fork.

---

## Project layout

```
app/                 The PWA (this is what gets deployed)
  index.html, app.js, styles.css, sw.js, manifest.json, icons
  bank.json          Compiled question bank the app reads
data/
  quantquestions_free.json   Raw scraped questions (764)
  techniques.json            Technique taxonomy / skill-tree DAG
  enrichment.json            Per-question tags, hints, solutions
tools/
  dump_batch.py      List next un-enriched questions
  apply_enrichment.py  Merge an enrichment batch (validates technique ids)
  build_bank.py      Merge raw + enrichment + taxonomy -> app/bank.json
  batch_*.json       Authored enrichment batches
```

## Rebuild the bank after editing content

```bash
python3 tools/build_bank.py     # regenerates app/bank.json
git add -A && git commit -m "update" && git push   # auto-redeploys
```
