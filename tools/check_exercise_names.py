"""Audit exercise names in database.js against the EXERCISE_ALIASES registry in app.js.

Run after injecting a new program. It reports:
  1. Names that resolve through an alias (sanity check the merge groups).
  2. Unmapped names that look suspiciously similar to an existing canonical name
     (likely a new alias that should be added to EXERCISE_ALIASES in app.js).

Usage: python tools/check_exercise_names.py
"""
import difflib
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_aliases():
    app = (ROOT / 'scripts' / 'app.js').read_text(encoding='utf-8')
    m = re.search(r'const EXERCISE_ALIASES = \{(.*?)\n\s*\};', app, re.DOTALL)
    if not m:
        sys.exit('EXERCISE_ALIASES not found in scripts/app.js')
    aliases = {}
    for am in re.finditer(r"'((?:[^'\\]|\\.)+)'\s*:\s*'((?:[^'\\]|\\.)+)'", m.group(1)):
        aliases[am.group(1).replace("\\'", "'")] = am.group(2).replace("\\'", "'")
    return aliases


def load_db_names():
    db = (ROOT / 'scripts' / 'database.js').read_text(encoding='utf-8')
    return sorted({m.group(1).replace('\\"', '"') for m in re.finditer(r'"name":\s*"((?:[^"\\]|\\.)+)"', db)})


def main():
    aliases = load_aliases()
    names = load_db_names()
    canonical = lambda n: aliases.get(n.lower().strip(), n)

    groups = defaultdict(list)
    for n in names:
        groups[canonical(n)].append(n)

    merged = {c: g for c, g in groups.items() if len(g) > 1 or g[0] != c}
    print(f'{len(names)} unique names -> {len(groups)} canonical exercises\n')
    print('-- Merge groups ' + '-' * 40)
    for c in sorted(merged):
        print(f'  {c}')
        for n in sorted(merged[c]):
            print(f'      <- {n}')

    # Fuzzy-flag unmapped names that resemble a different canonical exercise
    print('\n-- Possible missing aliases ' + '-' * 28)
    canonicals = sorted(groups.keys())
    flagged = 0
    for n in canonicals:
        others = [c for c in canonicals if c != n]
        close = difflib.get_close_matches(n.lower(), [o.lower() for o in others], n=2, cutoff=0.8)
        for cl in close:
            other = next(o for o in others if o.lower() == cl)
            if n < other:  # report each pair once
                print(f'  "{n}"  ~  "{other}"')
                flagged += 1
    if flagged == 0:
        print('  (none)')
    print('\nIf a pair above is the same exercise, add an alias entry to EXERCISE_ALIASES in scripts/app.js.')


if __name__ == '__main__':
    main()
