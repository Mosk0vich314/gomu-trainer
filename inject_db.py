import json
import re
import os
import sys

def inject_database(target_program):
    html_file = 'index.html'
    json_file = f'{target_program}_database.json'
    
    if not os.path.exists(html_file) or not os.path.exists(json_file):
        print(f"❌ Error: Make sure {html_file} and {json_file} exist.")
        return

    print(f"Reading data from {json_file}...")
    with open(json_file, 'r', encoding='utf-8') as f:
        json_data = json.dumps(json.load(f), indent=4)

    print(f"Opening {html_file}...")
    with open(html_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    # Create dynamic markers based on the folder name provided
    start_marker = f"/* {target_program}_START */"
    end_marker = f"/* {target_program}_END */"
    
    safe_start = re.escape(start_marker)
    safe_end = re.escape(end_marker)
    pattern = rf'({safe_start}).*?({safe_end})'
    
    if re.search(pattern, html_content, flags=re.DOTALL):
        new_html = re.sub(pattern, rf'\1\n{json_data}\n\2', html_content, flags=re.DOTALL)
        
        with open(html_file, 'w', encoding='utf-8') as f:
            f.write(new_html)
        print(f"✅ Success! Data injected into index.html between {start_marker} and {end_marker}")
    else:
        print(f"❌ Error: Could not find markers in index.html.")
        print(f"Please ensure your index.html contains exactly:")
        print(f"{start_marker} {{}} {end_marker}")

if __name__ == "__main__":
    # Check if the user provided a program name argument
    if len(sys.argv) < 2:
        print("❌ Error: You must provide the program/folder name.")
        print("Usage: python inject_db.py <PROGRAM_NAME>")
        sys.exit()
        
    # Read the argument from the terminal
    target = sys.argv[1]
    inject_database(target)