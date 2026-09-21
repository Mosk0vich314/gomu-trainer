import os
import re
import sys
from datetime import datetime
import subprocess

# Fix emoji output on Windows terminals
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 1. Generate the exact moment in time as our version (e.g., 2026.03.14.1130)
now = datetime.now()
new_version = now.strftime("%Y.%m.%d.%H%M")
print(f"🚀 Bumping app version to: {new_version}")

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

# --- 2. EXECUTE THE REPLACEMENTS ---
update_file('index.html', r'(\./(?:styles/styles\.css|scripts/app\.js))\?v=[\d\.]+', rf'\1?v={new_version}')
update_file('scripts/app.js', r'const APP_VERSION = "v[^"]+";', f'const APP_VERSION = "v{new_version}";')
update_file('sw.js', r"const CACHE_NAME = 'gomu-trainer-v[^']+';", f"const CACHE_NAME = 'gomu-trainer-v{new_version}';")

# --- 2.5. ENCRYPT DATABASE ---
print("🔐 Encrypting database...")
encrypt_script = os.path.join(os.path.dirname(__file__), 'encrypt_db.py')
subprocess.run([sys.executable, encrypt_script], check=True)
print("✅ Database encrypted")


# --- 3. DETERMINE COMMIT MESSAGE ---
commit_msg = f"Auto-deploy build v{new_version}"

# If you passed an argument in the terminal, use it!
if len(sys.argv) > 1:
    custom_msg = " ".join(sys.argv[1:])
    commit_msg = f"{custom_msg} (v{new_version})"


# --- 4. AUTO-PUSH TO GITHUB ---
print(f"📦 Committing as: '{commit_msg}'")
root_dir = os.path.join(os.path.dirname(__file__), '..')

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