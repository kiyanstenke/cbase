#!/bin/bash
# Checks that every translation key L("…") used in the code (English) has a German counterpart in LocDEBase, LocDEMobile,
# LocDECommunication, LocDEOuterLoop, LocDEProjects, LocDEPreview, LocDEInstances, LocDESkills, LocDEChats, LocDEAgenda,
# LocDEAdministration, LocDEUsage, LocDEMcp, LocDEScheduled, LocDEGit or LocDETimeline. The English UI string IS the key — if it is
# missing from the dictionary, the German version shows English.
#
#   bash tools/loc-audit.sh          # missing keys only
#   bash tools/loc-audit.sh --all    # plus the count
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

python3 - "${1:-}" <<'PY'
import re, sys, pathlib

show_all = sys.argv[1] == "--all"
source = pathlib.Path("CbaseMobile")

# Keys from the code: L("…") and L("…", [ … ])
keys = set()
key_pattern = re.compile(r'\bL\(\s*"((?:[^"\\]|\\.)*)"')
# recursive: the sources live in subfolders (Chat/, Kit/, …)
for path in sorted(source.rglob("*.swift")):
    if path.name.startswith("LocDE"):
        continue
    for match in key_pattern.finditer(path.read_text()):
        keys.add(match.group(1))

# Keys from the dictionaries: "…": "…",
# Duplicate keys are CHECKED TOO: a Swift dictionary literal with a duplicate key crashes at start ("Dictionary literal contains
# duplicate keys") — the compiler says nothing.
translated = set()
duplicates = []
entry_pattern = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"', re.MULTILINE)
# LocDECommunication.swift is a table of its own because LocDEMobile.swift sits at the 2,000-line guard. Base and Mobile may
# override each other (deliberate deviation); the newer tables may not — a key that already stands elsewhere is an error there
# (otherwise the order in LocDE.swift would silently decide). The same holds for LocDEOuterLoop.swift: it may carry no key of the
# three other tables.
tables = {}
for name in ("LocDEBase.swift", "LocDEMobile.swift", "LocDECommunication.swift", "LocDEOuterLoop.swift", "LocDEProjects.swift", "LocDEPreview.swift", "LocDEInstances.swift", "LocDESkills.swift", "LocDEChats.swift", "LocDEAgenda.swift", "LocDEAdministration.swift", "LocDEUsage.swift", "LocDEMcp.swift", "LocDEScheduled.swift", "LocDEGit.swift", "LocDETimeline.swift"):
    file = next(iter(sorted(source.rglob(name))), None)  # may live under Kit/
    if file is None:
        continue
    seen = set()
    for match in entry_pattern.finditer(file.read_text()):
        key = match.group(1)
        if key in seen:
            duplicates.append(f"{name}: {key}")
        seen.add(key)
    tables[name] = seen
    translated |= seen
for key in sorted(tables.get("LocDECommunication.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()))):
    duplicates.append(f"LocDECommunication.swift (already in LocDEBase/LocDEMobile): {key}")
for key in sorted(tables.get("LocDEOuterLoop.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()) | tables.get("LocDECommunication.swift", set()))):
    duplicates.append(f"LocDEOuterLoop.swift (already in LocDEBase/LocDEMobile/LocDECommunication): {key}")
# LocDEProjects.swift: the same rule — no key of the four other tables.
for key in sorted(tables.get("LocDEProjects.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()) | tables.get("LocDECommunication.swift", set()) | tables.get("LocDEOuterLoop.swift", set()))):
    duplicates.append(f"LocDEProjects.swift (already in LocDEBase/LocDEMobile/LocDECommunication/LocDEOuterLoop): {key}")
# LocDEPreview.swift: the same rule — no key of the five other tables.
for key in sorted(tables.get("LocDEPreview.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()) | tables.get("LocDECommunication.swift", set()) | tables.get("LocDEOuterLoop.swift", set()) | tables.get("LocDEProjects.swift", set()))):
    duplicates.append(f"LocDEPreview.swift (already in LocDEBase/LocDEMobile/LocDECommunication/LocDEOuterLoop/LocDEProjects): {key}")
# LocDEInstances.swift: the same rule — no key of the six other tables.
for key in sorted(tables.get("LocDEInstances.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()) | tables.get("LocDECommunication.swift", set()) | tables.get("LocDEOuterLoop.swift", set()) | tables.get("LocDEProjects.swift", set()) | tables.get("LocDEPreview.swift", set()))):
    duplicates.append(f"LocDEInstances.swift (already in LocDEBase/LocDEMobile/LocDECommunication/LocDEOuterLoop/LocDEProjects/LocDEPreview): {key}")
# LocDESkills.swift: the same rule — no key of the seven other tables.
for key in sorted(tables.get("LocDESkills.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()) | tables.get("LocDECommunication.swift", set()) | tables.get("LocDEOuterLoop.swift", set()) | tables.get("LocDEProjects.swift", set()) | tables.get("LocDEPreview.swift", set()) | tables.get("LocDEInstances.swift", set()))):
    duplicates.append(f"LocDESkills.swift (already in LocDEBase/LocDEMobile/LocDECommunication/LocDEOuterLoop/LocDEProjects/LocDEPreview/LocDEInstances): {key}")
# LocDEChats.swift: the same rule — no key of the eight other tables.
for key in sorted(tables.get("LocDEChats.swift", set()) & (tables.get("LocDEBase.swift", set()) | tables.get("LocDEMobile.swift", set()) | tables.get("LocDECommunication.swift", set()) | tables.get("LocDEOuterLoop.swift", set()) | tables.get("LocDEProjects.swift", set()) | tables.get("LocDEPreview.swift", set()) | tables.get("LocDEInstances.swift", set()) | tables.get("LocDESkills.swift", set()))):
    duplicates.append(f"LocDEChats.swift (already in LocDEBase/LocDEMobile/LocDECommunication/LocDEOuterLoop/LocDEProjects/LocDEPreview/LocDEInstances/LocDESkills): {key}")

# LocDEAgenda.swift: the same rule — no key of the nine other tables.
_other_agenda = set()
for _name in ("LocDEBase.swift", "LocDEMobile.swift", "LocDECommunication.swift", "LocDEOuterLoop.swift", "LocDEProjects.swift", "LocDEPreview.swift", "LocDEInstances.swift", "LocDESkills.swift", "LocDEChats.swift"):
    _other_agenda |= tables.get(_name, set())
for key in sorted(tables.get("LocDEAgenda.swift", set()) & _other_agenda):
    duplicates.append(f"LocDEAgenda.swift (already in one of the nine other tables): {key}")

# LocDEAdministration.swift: the same rule — no key of the ten other tables.
_other_administration = _other_agenda | tables.get("LocDEAgenda.swift", set())
for key in sorted(tables.get("LocDEAdministration.swift", set()) & _other_administration):
    duplicates.append(f"LocDEAdministration.swift (already in one of the ten other tables): {key}")

# LocDEUsage.swift: the same rule — no key of the eleven other tables.
_other_usage = _other_administration | tables.get("LocDEAdministration.swift", set())
for key in sorted(tables.get("LocDEUsage.swift", set()) & _other_usage):
    duplicates.append(f"LocDEUsage.swift (already in one of the eleven other tables): {key}")

# LocDEMcp.swift: the same rule — no key of the twelve other tables.
_other_mcp = _other_usage | tables.get("LocDEUsage.swift", set())
for key in sorted(tables.get("LocDEMcp.swift", set()) & _other_mcp):
    duplicates.append(f"LocDEMcp.swift (already in one of the twelve other tables): {key}")

# LocDEScheduled.swift: the same rule — no key of the thirteen other tables.
_other_scheduled = _other_mcp | tables.get("LocDEMcp.swift", set())
for key in sorted(tables.get("LocDEScheduled.swift", set()) & _other_scheduled):
    duplicates.append(f"LocDEScheduled.swift (already in one of the thirteen other tables): {key}")

# LocDEGit.swift: the same rule — no key of the fourteen other tables.
_other_git = _other_scheduled | tables.get("LocDEScheduled.swift", set())
for key in sorted(tables.get("LocDEGit.swift", set()) & _other_git):
    duplicates.append(f"LocDEGit.swift (already in one of the fourteen other tables): {key}")

# LocDETimeline.swift: the same rule — no key of the fifteen other tables.
_other_timeline = _other_git | tables.get("LocDEGit.swift", set())
for key in sorted(tables.get("LocDETimeline.swift", set()) & _other_timeline):
    duplicates.append(f"LocDETimeline.swift (already in one of the fifteen other tables): {key}")

if duplicates:
    print(f"{len(duplicates)} DUPLICATE keys (crash at start!):")
    for entry in duplicates:
        print("  " + entry)
    sys.exit(1)

missing = sorted(keys - translated)
if show_all:
    print(f"{len(keys)} keys in the code, {len(translated)} in the dictionary")
if missing:
    print(f"{len(missing)} keys without a German entry:")
    for key in missing:
        print("  " + key)
    sys.exit(1)
print("All used keys are translated.")
PY
