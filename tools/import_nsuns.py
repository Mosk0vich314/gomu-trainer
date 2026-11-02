"""Build and inject the nSuns 4-day LP template (no deployment).

Sources:
https://www.boostcamp.app/coaches/r-fitness/nsuns-linear-progression
https://keylifts.com/templates/nsuns/nsuns-lp-4-day

Boostcamp's public preview groups identical prescriptions even when they are
nonconsecutive. Preserve the original ascending/descending set order here.
The weekly template repeats; progression is performance-based, not a fixed
increase baked into week numbers. Optional accessories are user-selected.
"""
import copy
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEY = 'nsuns_531_4day'
NAME = 'nSuns 5/3/1 - 4 Day LP'


def blocks(reps, percentages, amrap=()):
    return [dict(type='top' if i < 3 else 'backoff', sets=1, reps=r,
                 pct=p / 100, **({'amrap': True} if i + 1 in amrap else {}))
            for i, (r, p) in enumerate(zip(reps, percentages, strict=True))]


def exercise(name, reference, prescription, notes):
    return dict(name=name, type='main', percentageReference=reference,
                trainingMaxFactor=0.9, notes=notes, blocks=prescription)


SETUP = ('Training max (TM) = 90% of the reference 1RM entered in Stats. '
         'Percentages shown are of TM. Warm up before working sets. ')
PROGRESSION = ('Weekly progression is manual: use the 95% TM 1+ set. '
               '0-1 reps: keep TM; 2-3: add 5 lb (about 2.5 kg); '
               '4-5: add 5-10 lb (about 2.5-5 kg); '
               '6+: add 10-15 lb (about 5-7.5 kg). '
               'Before next week, set the reference 1RM in Stats to new TM / 0.9. '
               'This also changes the reference used by other programs. '
               'Log achieved reps on AMRAP sets; stop when technique breaks down. ')


def build_program():
    heavy_pct = [75, 85, 95, 90, 85, 80, 75, 70, 65]
    week = {
        '1': [
            exercise('Bench Press', 'Bench Press',
                     blocks([8, 6, 4, 4, 4, 5, 6, 7, 8], [65, 75, 85, 85, 85, 80, 75, 70, 65], (9,)),
                     SETUP + 'Volume day; final set is 8+ AMRAP. Progress bench from Day 3, not this set. '
                     'Suggested schedule: Mon/Tue/Thu/Fri. Add optional chest, back and arm accessories after the main work.'),
            exercise('Overhead Press', 'Overhead Press',
                     blocks([6, 5, 3, 5, 7, 4, 6, 8], [50, 60, 70, 70, 70, 70, 70, 70]),
                     'Uses your own Overhead Press 1RM in Stats (listed as Overhead Press (bench)); '
                     'set it explicitly, not your bench max. TM = 90% of that value. '
                     'No OHP 1+ test in the 4-day version: adjust its TM manually when all sets are manageable.')],
        '2': [
            exercise('Squat', 'Squat', blocks([5, 3, 1, 3, 3, 3, 5, 5, 5], heavy_pct, (3, 9)),
                     SETUP + PROGRESSION + 'Final set is 5+ AMRAP. Optional legs and abs after the main work.'),
            exercise('Sumo Deadlift', 'Deadlift', blocks([5, 5, 3, 5, 7, 4, 6, 8], [50, 60, 70, 70, 70, 70, 70, 70]),
                     'Percentages use 90% of your conventional Deadlift reference 1RM, not a separate sumo max.')],
        '3': [
            exercise('Bench Press', 'Bench Press', blocks([5, 3, 1, 3, 5, 3, 5, 3, 5], heavy_pct, (3, 9)),
                     SETUP + PROGRESSION + 'Final set is 5+ AMRAP. Optional back, shoulders and arms after the main work.'),
            exercise('Close Grip (bench)', 'Bench Press', blocks([6, 5, 3, 5, 7, 4, 6, 8], [40, 50, 60, 60, 60, 60, 60, 60]),
                     'Percentages use 90% of your standard Bench Press reference 1RM, not a close-grip max.')],
        '4': [
            exercise('Deadlift', 'Deadlift', blocks([5, 3, 1, 3, 3, 3, 3, 3, 3], heavy_pct, (3, 9)),
                     SETUP + PROGRESSION + 'Final set is 3+ AMRAP. Optional legs and abs after the main work.'),
            exercise('Front Squat', 'Squat', blocks([5, 5, 3, 5, 7, 4, 6, 8], [35, 45, 55, 55, 55, 55, 55, 55]),
                     'Percentages use 90% of your back Squat reference 1RM, not a front-squat max.')]
    }
    return {str(w): copy.deepcopy(week) for w in range(1, 9)}


def main():
    program = json.dumps(build_program(), indent=2, ensure_ascii=False)
    (ROOT / 'Programs' / 'nSuns_531_4Day_database.json').write_text(program + '\n', encoding='utf-8')
    db_path = ROOT / 'scripts' / 'database.js'
    content = db_path.read_text(encoding='utf-8')
    start, end = f'/* {KEY}_START */', f'/* {KEY}_END */'
    if start in content:
        content, count = re.subn(re.escape(start) + r'.*?' + re.escape(end),
                                lambda _: start + '\n' + program + '\n' + end,
                                content, flags=re.DOTALL)
        assert count == 1
    else:
        closing = re.search(r'\s*};\s*$', content)
        if not closing:
            raise ValueError('Cannot find database closing brace')
        prefix = content[:closing.start()].rstrip()
        separator = '' if prefix.endswith(',') else ','
        content = (prefix + separator + f'\n\n"{KEY}": {{ name: "{NAME}", weeks: {start}\n'
                   + program + f'\n{end} }}\n\n}};\n')
    db_path.write_text(content, encoding='utf-8')
    print(f'Injected {NAME}: 8 weeks, 4 days/week, 68 working sets/week.')


if __name__ == '__main__':
    main()
