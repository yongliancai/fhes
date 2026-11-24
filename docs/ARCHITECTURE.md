# FHES code map (observed v5.1 at 44879bb)
## Current
- `index.html`: standalone HTML/CSS/JavaScript entry, cosmic-style UI.
- Browser IndexedDB `classroomPowerhouseV5`: `classes`, `students`, `events`, `dailySnapshots`, `meta`.
- Local-memory `S`: classes, students, events, snapshots and meta.
- Derived maps: `totals` (score/earned/heart), `groupTotals` for group event totals.
- User workflows: student and group scoring, order-recording review and reversal, daily settlement, roster updates, backup import/export.
- Optional legacy `Cloud`: Firebase dynamic imports + Firestore `classroomPowerhouseV5/{docId}` collections, local-first push/pull.
- No Google Sign-In or Sheets client in current source.
## Existing logic to protect
- `isCounted` gates pending/rejected records.
- `applyTo` tracks heart floor, spendable score, lifetime earned (redemption excluded).
- `applyToTotals` handles independent student vs group event totals.
- `dbWrite` is a multi-store IndexedDB transaction.
- `buildBackup` / `parseBackup` / import approval paths preserve historical backup compatibility.
## Known limitations
- One large application file; existing Firebase cloud update/merge behavior needs stronger conflict tests.
- Baseline tests added to branch use narrow production-code extraction rather than a public module interface.
- No reliable runtime UI or OAuth verification established yet.
## Proposed P2 modular boundary (not yet implemented)
core/ids-and-schema → core/score-projection → core/backup-version → data/local-indexeddb → sync/provider-adapter → ui/controllers.
Separate read projections from mutation commands. Keep storage provider implementation behind a narrow adapter.
Never remove the old `Cloud` or alter formal data migration until isolated tests and export checks prove preservation.
## Future P3–P6 (design only)
Homework records; collection identity & rarity 5/4/2/1, six worlds, independent special collectible IDs; Google Sheets OAuth replacing optional Firestore only following additional authorization and data confirmation.
