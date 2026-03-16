import os
import re
import sys
from datetime import datetime
import subprocess

# 1. Generate the exact moment in time as our version (e.g., 2026.03.14.1130)
now = datetime.now()
new_version = now.strftime("%Y.%m.%d.%H%M")
print(f"🚀 Bumping app version to: {new_version}")

# Helper function to safely read, replace, and write
def update_file(relative_path, pattern, replacement):
    filepath = os.path.join(os.path.dirname(__file__), '..', relative_path)
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Perform the Regex swap
        content = re.sub(pattern, replacement, content)
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"✅ Updated {relative_path}")
    except FileNotFoundError:
        print(f"❌ Could not find {relative_path}. Are you running this from the right folder?")

# --- 2. EXECUTE THE REPLACEMENTS ---
update_file('index.html', r'\?v=[\d\.]+', f'?v={new_version}')
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

try:
    subprocess.run(["git", "add", "."], check=True, cwd=root_dir)
    subprocess.run(["git", "commit", "-m", commit_msg], check=True, cwd=root_dir)
    subprocess.run(["git", "push"], check=True, cwd=root_dir)
    print("🎉 Deployment Complete! Pull down on your phone to see the magic.")
except Exception as e:
    print(f"⚠️ Git push failed: Make sure you have an internet connection and no merge conflicts. Error: {e}")