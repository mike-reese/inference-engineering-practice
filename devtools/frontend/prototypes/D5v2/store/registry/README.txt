One registry file per source. The importer (../import_v2.py) knows no event kind, field, unit or measure by name:
it reads them from these files. To add or change an event kind, edit or add a rule here and re-run the importer.

Rule matching: the first rule whose "match" holds claims the row. Keys: source (neutral source name), track_prefix,
process_prefix, thread, box (the stamp's component box), name_regex. Sources are tried in "order" (lowest first).
eid template fields: {short} {name} {lane} {iter} {box} {request} {n}; {n} = ordinal among rows with the same prefix.
"what" is one ASD-STE100 sentence (simple present, active voice, approved verbs where possible); it may use the same
fields plus {bytes}. "fields" lists the source args kept as typed columns in args (others stay in args as text).
