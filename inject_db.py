import json
import re
import os

def inject_database():
    html_file = 'index.html'
    json_file = 'POP_1_database.json'
    
    # 1. Check if files exist
    if not os.path.exists(html_file) or not os.path.exists(json_file):
        print("❌ Error: Make sure index.html and POP_1_database.json are in this folder.")
        return

    # 2. Read the JSON data
    print(f"Reading data from {json_file}...")
    with open(json_file, 'r', encoding='utf-8') as f:
        # Load and dump to ensure it's formatted compactly
        json_data = json.dumps(json.load(f), indent=4)

    # 3. Read the HTML file
    print(f"Opening {html_file}...")
    with open(html_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    # 4. Find the markers and swap the data
    # This looks for /* POP1_START */ [anything in here] /* POP1_END */
    pattern = r'(/\* POP1_START \*/).*?(/\* POP1_END \*/)'
    
    # If the markers exist, replace what's between them with our JSON
    if re.search(pattern, html_content, flags=re.DOTALL):
        new_html = re.sub(pattern, rf'\1\n{json_data}\n\2', html_content, flags=re.DOTALL)
        
        # 5. Save the updated HTML
        with open(html_file, 'w', encoding='utf-8') as f:
            f.write(new_html)
        print("✅ Success! The JSON database has been injected into index.html")
    else:
        print("❌ Error: Could not find the /* POP1_START */ and /* POP1_END */ markers in your index.html file.")

if __name__ == "__main__":
    inject_database()