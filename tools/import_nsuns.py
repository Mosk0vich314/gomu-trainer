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


# Rest after each set (nSuns itself prescribes none): main lifts 2 min, 3 min once
# the load reaches 85% TM, 4 min after the 1+ set; supplemental lifts 90 s.
def main_rest(pct, amrap):
    return 240 if amrap else 180 if pct >= 85 else 120


def blocks(reps, percentages, amrap=(), rest=main_rest):
    # Consecutive identical sets share one block (3 x 4 @ 85%), like every other program.
    # AMRAP sets always stay their own block.
    out = []
    for i, (r, p) in enumerate(zip(reps, percentages, strict=True)):
        is_amrap = i + 1 in amrap
        prev = out[-1] if out else None
        if prev and not is_amrap and not prev.get('amrap') and (prev['reps'], prev['pct']) == (r, p / 100):
            prev['sets'] += 1
            continue
        out.append(dict(type='top' if i < 3 else 'backoff', sets=1, reps=r, pct=p / 100,
                        restSec=rest(p, is_amrap), **({'amrap': True} if is_amrap else {})))
    return out


def supplemental_blocks(reps, percentages):
    return blocks(reps, percentages, rest=lambda pct, amrap: 90)


def exercise(name, reference, prescription, notes, progression=None):
    ex = dict(name=name, type='main', percentageReference=reference,
              trainingMaxFactor=0.9, notes=notes, blocks=prescription)
    if progression:
        block = next(i for i, b in enumerate(prescription, 1) if b.get('amrap') and b['pct'] == 0.95)
        ex['tmProgression'] = dict(block=block, **progression)
    return ex


ACCESSORY_NOTE = ('Custom accessory added to nSuns. Keep about 2 reps in reserve (RPE 8). '
                  'Rest about 90 seconds, longer if needed. Work up to the top of the rep range '
                  'on every set, then add the smallest available weight. '
                  'Cut accessory sets (Day 4 first) if the 1+ sets start dropping. ')


def accessory(name, sets, reps, rep_range, why, rest=90, bodyweight_only=False):
    # The app stores reps as a number, so the range lives in the notes.
    # Bodyweight-only work progresses by reps, so it skips the add-weight advice.
    ex = dict(name=name, type='accessory',
              notes=f'{rep_range} reps. {why}' + ('' if bodyweight_only else ' ' + ACCESSORY_NOTE),
              blocks=[dict(type='acc', sets=sets, reps=reps, targetRpe=8.0, pct=None, restSec=rest)])
    if bodyweight_only:
        ex['bodyweightOnly'] = True
    return ex


PULL_UP_WHY = ('Pull-up progression, twice a week. Do about half your max reps per set '
               '(4 x 3-4 if your max is 7), add one rep to one set each session and never grind '
               'to failure. At 4 x 8 add a small weight. If you cannot yet do strict reps, do '
               '3-5 slow negatives (5 s down) plus band-assisted reps and test one strict rep weekly.')
NORDIC_WHY = ('Bodyweight only. Football hamstring protection: programmes that include Nordic curls cut '
              'hamstring injuries by about half. Kneel, anchor your heels and lower yourself as slowly as '
              'you can, catching yourself with your hands. Very sore at first: start at 2 x 3 and add a rep '
              'only when the soreness is gone. At 2 x 6, make it harder by lowering more slowly or catching '
              'yourself later, not by adding weight. Keep this day far from match day.')


# Set 3 (95% TM, 1+) drives the TM; the app applies it when the workout is finished.
# Lower body: 2-3 reps +2.5 kg, 4-5 +5 kg, 6+ +7.5 kg. Bench: 2-5 +2.5 kg, 6+ +5 kg,
# and OHP follows at half the bench increase (the 4-day version has no OHP 1+ set).
# `block` (the 1-based block holding the 95% 1+ set) is filled in by exercise().
LOWER_PROGRESSION = dict(steps=[[2, 2.5], [4, 5], [6, 7.5]])
BENCH_PROGRESSION = dict(steps=[[2, 2.5], [6, 5]], also={'Overhead Press': 0.5})

SETUP = ('Training max (TM) = 90% of the reference 1RM entered in Stats, then progressed '
         'automatically inside this program (other programs keep reading your Stats 1RM). '
         'Entering a new reference 1RM in Stats restarts the TM from it. '
         'Percentages shown are of TM. Warm up before working sets. ')
LEG_DRIVE = ('Leg drive: set feet between knees and hips, pulled back and out, before you unrack. '
             'Squeeze glutes and drive heels through the floor as you press, keeping your butt on the '
             'bench; it pins your upper back, it does not push you up. Bar travels up and back toward '
             'your face; film heavy sets from the side to check the mid-range. ')
AMRAP_NOTE = ('AMRAP sets: stop when technique breaks down. Only the 1+ set drives progression; '
              'if recovery or next session\'s 1+ set suffers, leave 1-2 reps in reserve on the final + set. ')


def fmt_kg(kg):
    return f'{kg:g}'


def progression_note(lift, rule, followers):
    # Written from the same steps the app applies, so the note can never disagree with it.
    steps = rule['steps']
    bands = [f'0-{steps[0][0] - 1} reps: TM stays']
    for i, (lo, kg) in enumerate(steps):
        hi = steps[i + 1][0] - 1 if i + 1 < len(steps) else None
        reps = f'{lo}+' if hi is None else (f'{lo}' if hi == lo else f'{lo}-{hi}')
        bands.append(f'{reps}: +{fmt_kg(kg)} kg')
    text = (f'Log the reps on the 95% 1+ set: finishing the workout raises your {lift} TM for next week. '
            + '; '.join(bands) + '. ')
    for other, share in rule.get('also', {}).items():
        text += f'{other} rises by {"half" if share == 0.5 else f"{share:.0%}"} of each {lift} increase. '
    text += f'{followers} use this same TM, so they rise with it. '
    return text + AMRAP_NOTE


def follows_note(parent, day):
    # This lift reads the parent's progressed program TM, not the Stats 1RM: Stats is only the seed.
    return (f'No separate max: percentages are of the same {parent} TM the {parent} itself uses '
            f'(the Training max line on this card shows it). That TM starts at 90% of your {parent} 1RM in Stats, '
            f'then goes up inside this program every time the Day {day} 1+ set raises it, so this lift goes '
            f'up with it. Stats is only the starting point; it is not changed.')


def build_program():
    heavy_pct = [75, 85, 95, 90, 85, 80, 75, 70, 65]
    week = {
        '1': [
            exercise('Bench Press', 'Bench Press',
                     blocks([8, 6, 4, 4, 4, 5, 6, 7, 8], [65, 75, 85, 85, 85, 80, 75, 70, 65], (9,)),
                     SETUP + LEG_DRIVE + 'Volume day; final set is 8+ AMRAP. Bench TM progresses from the Day 3 1+ set, not this one. '
                     'Suggested schedule: Mon/Tue/Thu/Fri. Complete the accessories after the main work.'),
            exercise('Overhead Press', 'Overhead Press',
                     supplemental_blocks([6, 5, 3, 5, 7, 4, 6, 8], [50, 60, 70, 70, 70, 70, 70, 70]),
                     'Uses your own Overhead Press 1RM in Stats (listed as Overhead Press (bench)); '
                     'set it explicitly, not your bench max. TM starts at 90% of that value and rises by half '
                     'of each bench TM increase (no OHP 1+ set in the 4-day version).')],
        '2': [
            exercise('Squat', 'Squat', blocks([5, 3, 1, 3, 3, 3, 5, 5, 5], heavy_pct, (3, 9)),
                     SETUP + progression_note('squat', LOWER_PROGRESSION, 'Front squats (Day 4)')
                     + 'Final set is 5+ AMRAP. Complete the accessories after the main work.',
                     LOWER_PROGRESSION),
            exercise('Sumo Deadlift', 'Deadlift', supplemental_blocks([5, 5, 3, 5, 7, 4, 6, 8], [50, 60, 70, 70, 70, 70, 70, 70]),
                     follows_note('deadlift', 4))],
        '3': [
            exercise('Bench Press', 'Bench Press', blocks([5, 3, 1, 3, 5, 3, 5, 3, 5], heavy_pct, (3, 9)),
                     SETUP + LEG_DRIVE + progression_note('bench', BENCH_PROGRESSION, 'Day 1 bench and close grip (today)')
                     + 'Final set is 5+ AMRAP. Complete the accessories after the main work.',
                     BENCH_PROGRESSION),
            exercise('Close Grip (bench)', 'Bench Press', supplemental_blocks([6, 5, 3, 5, 7, 4, 6, 8], [40, 50, 60, 60, 60, 60, 60, 60]),
                     follows_note('bench', 3))],
        '4': [
            exercise('Deadlift', 'Deadlift', blocks([5, 3, 1, 3, 3, 3, 3, 3, 3], heavy_pct, (3, 9)),
                     SETUP + progression_note('deadlift', LOWER_PROGRESSION, 'Sumo deadlifts (Day 2)')
                     + 'Final set is 3+ AMRAP. Complete the accessories after the main work.',
                     LOWER_PROGRESSION),
            exercise('Front Squat', 'Squat', supplemental_blocks([5, 5, 3, 5, 7, 4, 6, 8], [35, 45, 55, 55, 55, 55, 55, 55]),
                     follows_note('squat', 2))]
    }
    # Chosen around the lifter's weak points: mid-range bench (triceps long head, incline for
    # the shoulders), learning pull-ups (twice a week), football (Nordics, light leg work)
    # and low deadlift energy (no extra hinging; Day 4 accessories are upper body only).
    accessories = {
        '1': [accessory('Pull-Up (Bodyweight)', 4, 4, '3-8', PULL_UP_WHY, rest=120),
              accessory('Chest Supported Row', 3, 10, '10-12', 'Horizontal pulling to balance the pressing.'),
              accessory('Overhead Triceps Extension', 2, 10, '10-12',
                        'Cable or dumbbell. Long-head triceps for a bench that stalls mid-range.'),
              accessory('Dumbbell Lateral Raises', 2, 12, '12-15', 'Side delts.')],
        '2': [accessory('Nordic Hamstring Curl', 2, 3, '3-6', NORDIC_WHY, rest=120, bodyweight_only=True),
              accessory('Cable Crunch', 3, 12, '12-15', 'Core.')],
        '3': [accessory('Pull-Up (Bodyweight)', 4, 4, '3-8', PULL_UP_WHY, rest=120),
              accessory('Seated Cable Rows', 3, 10, '10-12', 'Horizontal pulling to balance the pressing.'),
              accessory('Face Pulls', 2, 15, '15', 'Rear delts and upper back for shoulder health.'),
              accessory('Dumbbell Bicep Curl', 3, 10, '10-12', 'Biceps.')],
        '4': [accessory('DB Incline Bench', 3, 8, '8-10',
                        'Upper chest and front delts for the mid-range of the bench. '
                        'Placed on the no-bench day so shoulders and chest are fresh.'),
              accessory('Dumbbell Lateral Raises', 3, 12, '12-15', 'Side delts.'),
              accessory('Hammer Curl', 2, 10, '10-12', 'Biceps and forearms.'),
              accessory('Cable Crunch', 2, 12, '12-15', 'Core.')]
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
    week = json.loads(program)['1']
    acc = sum(b['sets'] for day in week.values() for ex in day if ex['type'] == 'accessory' for b in ex['blocks'])
    print(f'Injected {NAME}: 8 weeks, 4 days/week, 68 main/supplemental + {acc} accessory sets/week.')


if __name__ == '__main__':
    main()
