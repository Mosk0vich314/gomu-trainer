"""Build and inject the nSuns 4-day LP template (no deployment).

Sources:
https://www.boostcamp.app/coaches/r-fitness/nsuns-linear-progression
https://keylifts.com/templates/nsuns/nsuns-lp-4-day

Boostcamp's public preview groups identical prescriptions even when they are
nonconsecutive. Preserve the original ascending/descending set order here.
The weekly template repeats; progression is performance-based, not a fixed
increase baked into week numbers. The accessories below are a custom Gomu
Trainer selection, not prescriptions from the original nSuns template.
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


def exercise(name, reference, prescription, notes, progression=None):
    ex = dict(name=name, type='main', percentageReference=reference,
              trainingMaxFactor=0.9, notes=notes, blocks=prescription)
    if progression:
        ex['tmProgression'] = progression
    return ex


def accessory(name, sets, reps):
    return dict(name=name, type='accessory',
                notes=('Custom accessory added to nSuns. Keep about 2 reps in reserve (RPE 8). '
                       'Rest 60-90 seconds, longer if needed. Once every set reaches the '
                       'prescribed reps at RPE 8 or below, increase by the smallest available '
                       'weight next time. Reduce accessory sets if main-lift recovery suffers.'),
                blocks=[dict(type='acc', sets=sets, reps=reps, targetRpe=8.0, pct=None)])


# Set 3 (95% TM, 1+) drives the TM; the app applies it when the workout is finished.
# Lower body: 2-3 reps +2.5 kg, 4-5 +5 kg, 6+ +7.5 kg. Bench: 2-5 +2.5 kg, 6+ +5 kg,
# and OHP follows at half the bench increase (the 4-day version has no OHP 1+ set).
LOWER_PROGRESSION = dict(block=3, steps=[[2, 2.5], [4, 5], [6, 7.5]])
BENCH_PROGRESSION = dict(block=3, steps=[[2, 2.5], [6, 5]], also={'Overhead Press': 0.5})

SETUP = ('Training max (TM) = 90% of the reference 1RM entered in Stats, then progressed '
         'automatically inside this program (other programs keep reading your Stats 1RM). '
         'Entering a new reference 1RM in Stats restarts the TM from it. '
         'Percentages shown are of TM. Warm up before working sets. ')
PROGRESSION = ('Log the reps on the 95% 1+ set: finishing the workout raises the TM for next week. '
               '0-1 reps: TM stays; 2-3: +2.5 kg; 4-5: +5 kg (bench +2.5); 6+: +7.5 kg (bench +5). '
               'Supplemental lifts using this TM move with it. '
               'AMRAP sets: stop when technique breaks down. Only the 1+ set drives progression; '
               'if recovery or next session\'s 1+ set suffers, leave 1-2 reps in reserve on the final + set. ')


def build_program():
    heavy_pct = [75, 85, 95, 90, 85, 80, 75, 70, 65]
    week = {
        '1': [
            exercise('Bench Press', 'Bench Press',
                     blocks([8, 6, 4, 4, 4, 5, 6, 7, 8], [65, 75, 85, 85, 85, 80, 75, 70, 65], (9,)),
                     SETUP + 'Volume day; final set is 8+ AMRAP. Bench TM progresses from the Day 3 1+ set, not this one. '
                     'Suggested schedule: Mon/Tue/Thu/Fri. Complete the accessories after the main work.'),
            exercise('Overhead Press', 'Overhead Press',
                     blocks([6, 5, 3, 5, 7, 4, 6, 8], [50, 60, 70, 70, 70, 70, 70, 70]),
                     'Uses your own Overhead Press 1RM in Stats (listed as Overhead Press (bench)); '
                     'set it explicitly, not your bench max. TM starts at 90% of that value and rises by half '
                     'of each bench TM increase (no OHP 1+ set in the 4-day version).')],
        '2': [
            exercise('Squat', 'Squat', blocks([5, 3, 1, 3, 3, 3, 5, 5, 5], heavy_pct, (3, 9)),
                     SETUP + PROGRESSION + 'Final set is 5+ AMRAP. Complete the accessories after the main work.',
                     LOWER_PROGRESSION),
            exercise('Sumo Deadlift', 'Deadlift', blocks([5, 5, 3, 5, 7, 4, 6, 8], [50, 60, 70, 70, 70, 70, 70, 70]),
                     'Percentages use 90% of your conventional Deadlift reference 1RM, not a separate sumo max.')],
        '3': [
            exercise('Bench Press', 'Bench Press', blocks([5, 3, 1, 3, 5, 3, 5, 3, 5], heavy_pct, (3, 9)),
                     SETUP + PROGRESSION + 'Final set is 5+ AMRAP. Complete the accessories after the main work.',
                     BENCH_PROGRESSION),
            exercise('Close Grip (bench)', 'Bench Press', blocks([6, 5, 3, 5, 7, 4, 6, 8], [40, 50, 60, 60, 60, 60, 60, 60]),
                     'Percentages use 90% of your standard Bench Press reference 1RM, not a close-grip max.')],
        '4': [
            exercise('Deadlift', 'Deadlift', blocks([5, 3, 1, 3, 3, 3, 3, 3, 3], heavy_pct, (3, 9)),
                     SETUP + PROGRESSION + 'Final set is 3+ AMRAP. Complete the accessories after the main work.',
                     LOWER_PROGRESSION),
            exercise('Front Squat', 'Squat', blocks([5, 5, 3, 5, 7, 4, 6, 8], [35, 45, 55, 55, 55, 55, 55, 55]),
                     'Percentages use 90% of your back Squat reference 1RM, not a front-squat max.')]
    }
    accessories = {
        '1': [accessory('Chest Supported Row', 3, 10), accessory('Lat Pulldown', 3, 12), accessory('Hammer Curl', 2, 12)],
        '2': [accessory('Leg Curl', 2, 12), accessory('Standing Calf Raise', 3, 15), accessory('Cable Crunch', 2, 15)],
        '3': [accessory('Chest Supported Row', 3, 10), accessory('Dumbbell Lateral Raises', 3, 15), accessory('Triceps Pushdown', 2, 12)],
        '4': [accessory('Leg Curl', 2, 12), accessory('Face Pulls', 3, 15), accessory('Cable Crunch', 2, 15)]
    }
    for day, additions in accessories.items():
        week[day].extend(additions)
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
    print(f'Injected {NAME}: 8 weeks, 4 days/week, 68 main/supplemental + 30 accessory sets/week.')


if __name__ == '__main__':
    main()
