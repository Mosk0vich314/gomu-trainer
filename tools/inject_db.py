import sys
import os
import re

def inject_program(program_name):
    html_file = 'index.html'
    json_file = f'{program_name}_database.json'

    # 1. Check if files exist
    if not os.path.exists(html_file):
        print(f"❌ Error: {html_file} not found.")
        return
    if not os.path.exists(json_file):
        print(f"❌ Error: {json_file} not found.")
        return

    # 2. Read the HTML and JSON
    with open(html_file, 'r', encoding='utf-8') as f:
        html_content = f.read()

    with open(json_file, 'r', encoding='utf-8') as f:
        json_content = f.read().strip()

    # 3. Setup the Regex Pattern
    # This looks for exactly: /* ProgramName_START */ [ANYTHING HERE] /* ProgramName_END */
    start_marker = f"/* {program_name}_START */"
    end_marker = f"/* {program_name}_END */"
    
    # re.DOTALL allows the (.*?) to match across multiple lines
    pattern = re.compile(f"({re.escape(start_marker)})(.*?)({re.escape(end_marker)})", re.DOTALL)

    # 4. Check if the markers actually exist in the HTML
    if not pattern.search(html_content):
        print(f"❌ Error: Could not find markers for {program_name} in {html_file}.")
        print(f"Make sure you have exactly: /* {program_name}_START */ {{}} /* {program_name}_END */ in your HTML.")
        return

    # 5. Overwrite everything between the markers with the new JSON
    # \1 is the start marker, \3 is the end marker. We inject the new JSON in the middle.
    new_html_content = pattern.sub(rf"\1\n{json_content}\n\3", html_content)

    # 6. Save the changes back to index.html
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(new_html_content)

    print(f"✅ Successfully injected/overwritten {program_name} into {html_file}!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python inject_db.py <program_name>")
    else:
        # Grab the program name from the command line argument
        program_name = sys.argv[1]
        inject_program(program_name)