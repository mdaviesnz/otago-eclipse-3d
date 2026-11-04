# Catalogue and preset verdicts are precomputed; the rule lives in two languages

The catalogue and the presets ship a precomputed verdict (`level`, plus `grazing` when true) in `viewpoints.json`. It replaces `wholeTotality`. Keeping the browser's work and the client code small matters more here than having a single implementation. The overview map in particular reads `level` and carries no verdict code at all.

The live sightline check still has to judge in the browser, so the rule exists twice: `precompute/verdict.py` (standard library only) and `verdict.js`. The two are kept in step by `tests/fixtures/verdict-cases.json`, which both the JS unit tests and `tests/check_static.py` run, including cases just either side of every threshold. `check_static.py` also re-judges every shipped row and fails the build if a stored `level` disagrees. Python rounds clearances to 2 decimal places before judging, so a stored level always agrees with the stored clearances.

## Considered options

- **Judge everything in the browser from the stored clearances.** One implementation, but the map would need verdict code. It was rejected in favour of precomputing as much as possible.
- **Keep trusting Python's `wholeTotality` boolean.** This is how a stored verdict came to disagree with its own rounded clearances. Rejected.

## Consequences

- Changing the rule means changing both files and the shared cases, then migrating or rebuilding `viewpoints.json`.
- Near edge is deliberately not stored. It is one comparison on the existing `totality` field, so storing it would add bytes and save no work.
- File size is not a cost: `"level":"clear"` is shorter than `"wholeTotality":true`, so the file shrank by about 4 KB raw (gzipped size essentially unchanged).
