import os
import re
import sys
from datetime import datetime
import subprocess

# Fix emoji output on Windows terminals
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.join(os.path.dirname(__file__), '..')

# 1. Generate the exact moment in time as our version (e.g., 2026.03.14.1130)
now = datetime.now()
new_version = now.strftime("%Y.%m.%d.%H%M")

# Helper function to safely read, replace, and write
def update_file(relative_path, pattern, replacement):
    """Rewrite a version string. Fails loudly: a silent no-match here ships a
    stale cache-buster, which is the exact bug the version stamp exists to stop."""
    filepath = os.path.join(os.path.dirname(__file__), '..', relative_path)
    try:
        with open(filepath, 'r', encoding='utf-8', newline='') as f:
            content = f.read()
    except FileNotFoundError:
        print(f"❌ Could not find {relative_path}. Are you running this from the right folder?")
        sys.exit(1)

    content, n = re.subn(pattern, replacement, content)
    if n == 0:
        print(f"❌ Version pattern never matched in {relative_path} -- refusing to deploy a stale cache-buster.")
        sys.exit(1)

    with open(filepath, 'w', encoding='utf-8', newline='') as f:
        f.write(content)
    print(f"✅ Updated {relative_path} ({n} replacement{'s' if n != 1 else ''})")

# --- 2. ENCRYPT DATABASE (before anything is mutated) ---
# scripts/database.js (plaintext programs) and password.txt are both gitignored,
# so a fresh clone has neither. Three cases:
#   both present  -> encrypt as usual
#   no database.js -> nothing to encrypt; ship the committed database.enc as-is
#   database.js but no password.txt -> STOP. You have program edits that cannot
#                                      be encrypted, and shipping would silently
#                                      leave them out of database.enc.
db_plain = os.path.join(ROOT, 'scripts', 'database.js')
db_enc   = os.path.join(ROOT, 'scripts', 'database.enc')
pw_file  = os.path.join(ROOT, 'password.txt')

if os.path.exists(db_plain):
    if not os.path.exists(pw_file):
        print("❌ scripts/database.js exists but password.txt does not.")
        print("   Your program edits cannot be encrypted, and deploying now would")
        print("   ship a database.enc without them. Add password.txt and re-run.")
        sys.exit(1)
    print("🔐 Encrypting database...")
    enc = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'encrypt_db.py')])
    if enc.returncode != 0:
        print("❌ Encryption failed -- nothing was modified. Fix and re-run.")
        sys.exit(1)
    print("✅ Database encrypted")
elif os.path.exists(db_enc):
    print("⚠️  No scripts/database.js in this clone -- skipping encryption.")
    print("   database.enc ships unchanged. That is correct when you have no")
    print("   program edits here; see CLAUDE.md to restore the plaintext DB.")
else:
    print("❌ Neither scripts/database.js nor scripts/database.enc exists.")
    print("   There is no database to ship. Check you are in the right folder.")
    sys.exit(1)

# --- 3. EXECUTE THE REPLACEMENTS ---
print(f"🚀 Bumping app version to: {new_version}")
update_file('index.html', r'(\./(?:styles/styles\.css|scripts/app\.js))\?v=[\d\.]+', rf'\1?v={new_version}')
update_file('scripts/app.js', r'const APP_VERSION = "v[^"]+";', f'const APP_VERSION = "v{new_version}";')
update_file('sw.js', r"const CACHE_NAME = 'gomu-trainer-v[^']+';", f"const CACHE_NAME = 'gomu-trainer-v{new_version}';")


# --- 4. DETERMINE COMMIT MESSAGE ---
commit_msg = f"Auto-deploy build v{new_version}"

# If you passed an argument in the terminal, use it!
if len(sys.argv) > 1:
    custom_msg = " ".join(sys.argv[1:])
    commit_msg = f"{custom_msg} (v{new_version})"


# --- 5. AUTO-PUSH TO GITHUB ---
print(f"📦 Committing as: '{commit_msg}'")
root_dir = ROOT

def git(*args, **kw):
    return subprocess.run(["git", *args], cwd=root_dir, capture_output=True, text=True, **kw)

add = git("add", "-A")
if add.returncode != 0:
    print(f"❌ git add failed:\n{add.stderr.strip()}")
    sys.exit(1)

# Nothing staged is not an error -- it used to raise from check=True and get
# reported as "Git push failed: check your internet connection", which is the
# least useful message available.
if git("diff", "--cached", "--quiet").returncode == 0:
    print("ℹ️  Nothing to commit (working tree already matches HEAD).")
    print("    Version strings were still bumped -- re-run after making a change.")
    sys.exit(0)

commit = git("commit", "-m", commit_msg)
if commit.returncode != 0:
    print(f"❌ git commit failed:\n{(commit.stderr or commit.stdout).strip()}")
    sys.exit(1)
print(f"✅ Committed {git('rev-parse', '--short', 'HEAD').stdout.strip()}")

push = git("push")
if push.returncode != 0:
    print("❌ git push failed. The commit is safe locally -- fix and re-run 'git push'.")
    print((push.stderr or push.stdout).strip())
    sys.exit(1)

print("🎉 Deployment Complete! Pull down on your phone to see the magic.")