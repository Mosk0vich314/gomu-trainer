import json
import re
import sys
import os

def inject_database(program_id):
    json_file = f"{program_id}_database.json"
    html_file = "index.html"

    if not os.path.exists(json_file):
        print(f"Error: {json_file} not found.")
        return
    if not os.path.exists(html_file):
        print(f"Error: {html_file} not found.")
        return

    with open(json_file, 'r', encoding='utf-8') as f:
        db_content = f.read()

    # Validate JSON before injecting
    try:
        json.loads(db_content)
    except json.JSONDecodeError as e:
        print(f"Error: {json_file} contains invalid JSON. {e}")
        return

    with open(html_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    # Regex pattern to find the exact injection block
    pattern = re.compile(
        r'(/\*\s*' + re.escape(program_id) + r'_START\s*\*/\s*)(.*?)(\s*/\*\s*' + re.escape(program_id) + r'_END\s*\*/)',
        re.DOTALL
    )

    if not pattern.search(html_content):
        print(f"Error: Injection markers for '{program_id}' not found in {html_file}.")
        print(f"Looking for: /* {program_id}_START */ ... /* {program_id}_END */")
        return

    # Replace the content between the markers
    new_html_content = pattern.sub(r'\g<1>' + db_content + r'\g<3>', html_content)

    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(new_html_content)

    print(f"Successfully injected {json_file} into {html_file}!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python inject_db.py <program_id>")
        print("Example: python inject_db.py PPL")
    else:
        inject_database(sys.argv[1])