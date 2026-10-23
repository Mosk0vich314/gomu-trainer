"""Extract the reviewed manual's content and models (no standalone page).

Usage: python tools/import_technique_manual.py path/to/manual.html
The imported script is trusted source code: review changes before running this.
"""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).read_text(encoding='utf-8')
sections = re.findall(r'<section class="lift" id="([^"]+)">.*?</section>', source, re.S)
assert sections == ['principles', 'brace', 'you', 'squat', 'bench', 'deadlift', 'coach']
markup = '\n'.join(re.findall(r'<section class="lift".*?</section>', source, re.S))
markup = re.sub(r'<!--.*?-->', '', markup, flags=re.S)
# Section navigation supplies lift names; remove the original page's chapter chrome.
markup = re.sub(r'<div class="tag">.*?</div>', '', markup, flags=re.S)
markup = re.sub(r'<div class="eyebrow">Part 0</div>', '', markup)
markup = markup.replace('class="bpath anim"', 'class="bpath"')
markup = markup.replace('blue</span>', 'teal</span>').replace('red</span> = the bar', 'accent</span> = the bar')
assert not re.search(r'<script|\son\w+=|<iframe|<link', markup, re.I)
(root / 'assets/technique-manual.json').write_text(json.dumps({'html': markup}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

runtime = re.search(r'<script>\s*\(function\(\)\{(.*?)\}\)\(\);\s*</script>', source, re.S).group(1)
runtime = runtime.replace('const $=id=>document.getElementById(id);', 'const $=id=>root.getElementById(id);\nconst players = [];')
runtime = runtime.replace("const KEY='big3-body-v1';", "const KEY='techniqueBody';")
runtime = runtime.replace("if(saved[id]!==undefined)$(id).value=saved[id];", "if(saved[id]!==undefined && (typeof saved[id]==='string' || typeof saved[id]==='number')) {\n    const el=$(id), value=String(saved[id]);\n    if(el.tagName!=='SELECT' || [...el.options].some(o=>o.value===value)) el.value=value;\n  }")
runtime = runtime.replace('  btn.onclick=()=>{if(raf)', '  players.push(stop);\n  btn.onclick=()=>{if(raf)')
runtime = runtime.replace("$('bodyApply').onclick=applyToModels;\ncompute();applyToModels();", "$('bodyApply').onclick=applyToModels;\n$('bodyForm').addEventListener('submit', event=>event.preventDefault());\ncompute();applyToModels();\nreturn { stop: () => players.forEach(stop => stop()) };")
(root / 'scripts/technique-models.js').write_text('// Lift models adapted from the supplied Big Three Technique Manual.\n// DOM access is scoped to the guide; stop all players when it closes or changes section.\nexport function initTechniqueModels(root) {\n' + runtime + '\n}\n', encoding='utf-8')

# Keep schematic and content styles, isolated inside the guide's shadow root.
css = re.findall(r'<style>(.*?)</style>', source, re.S)[1]
css = css[css.index('.grid2{'):]
css = re.sub(r'@media \(prefers-reduced-motion:no-preference\).*?(?=/\* tables \*/)', '', css, flags=re.S)
css = re.sub(r'@media \(prefers-reduced-motion:no-preference\).*', '', css, flags=re.S)
(root / 'styles/technique-content.css').write_text('/* Scoped manual content and schematic primitives. See technique-guide.css for app styling. */\n' + css, encoding='utf-8')
print('Imported 7 sections and interactive lift models.')
