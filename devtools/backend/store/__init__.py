"""Command center v3 store (ie-run/3, COMMAND_CENTER_V3_DESIGN.md).

schema.py    the one column list, the manifest, the CCVB codec
registry.py  devtools/registry/*.json, validated once
derive.py    pure rules: tier, depth, parents, derived iteration, iterations, cause, comp, req, things, layers
adapters/    one parser per source (run folder files, nsys, torch, ncu, captures): records -> rows, live and final
probe.py     the host inventory from a device query this backend runs (cached in $CC_STORE/probe/)
importer.py  run folder + capture/ -> the next ie-run/3 generation (python -m store.importer)
ingest.py    the live tails of one run folder, through the same adapters
live.py      the live writer: rows, seal-time derivation, blocks, manifest
stream.py    the live runs, the collectors' feed, the WS stream, the final import at rep end
nvml.py      NVML and GPM sampler threads
detail.py    cold point lookups by row id (DuckDB over the generation's Parquet)
serve.py     /api/v3 routes
check.py     make store-check
"""
