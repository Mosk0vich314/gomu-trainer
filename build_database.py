import os
import re
import json
from PIL import Image
from google import genai

# Read the API key from your secret local file
try:
    with open("api_key.txt", "r") as key_file:
        API_KEY = key_file.read().strip()
except FileNotFoundError:
    print("❌ Error: Could not find api_key.txt. Please create it and paste your API key inside.")
    exit()

# Initialize the Client
client = genai.Client(api_key=API_KEY)

def parse_filename(filename):
    """Extracts week and day ranges from filenames like w1to4_d1to5.png"""
    match = re.search(r'w(\d+)(?:to(\d+))?_d(\d+)(?:to(\d+))?', filename)
    if match:
        w_start = int(match.group(1))
        w_end = int(match.group(2)) if match.group(2) else w_start
        d_start = int(match.group(3))
        d_end = int(match.group(4)) if match.group(4) else d_start
        return w_start, w_end, d_start, d_end
    return None, None, None, None

def extract_image_data(image_path, w_start, w_end, d_start, d_end):
    print(f"Processing {os.path.basename(image_path)} (Weeks {w_start}-{w_end}, Days {d_start}-{d_end})...")
    img = Image.open(image_path)
    
    prompt = f"""
    You are a data extraction AI. Look at the provided powerlifting program image.
    This image contains training data for Weeks {w_start} to {w_end}, specifically for Days {d_start} to {d_end}.
    
    Extract the workout data and format it EXACTLY as a JSON object. 
    The top-level keys must be the week numbers (as strings).
    The second-level keys must be the day numbers (as strings).
    The values must be the array of exercises.

    Rules:
    1. Only output valid JSON. No markdown formatting or code blocks.
    2. Convert percentages to decimals (e.g., 75% = 0.75). If no percentage, use null.
    3. Main lifts have 'Top Set' and 'Backoff' blocks. Accessories do not need 1RM math (set type to "acc", pct to null).
    
    Example Output Structure:
    {{
        "{w_start}": {{
            "{d_start}": [
                {{
                    "name": "Competition Squat",
                    "type": "main", 
                    "blocks": [
                        {{ "type": "top", "sets": 1, "reps": 4, "targetRpe": 6.5, "pct": null, "rest": "4min" }},
                        {{ "type": "backoff", "sets": 3, "reps": 5, "targetRpe": 6.5, "pct": 0.75, "rest": "3min" }}
                    ]
                }},
                {{
                    "name": "Biceps of Choice",
                    "type": "acc", 
                    "blocks": [
                        {{ "type": "acc", "sets": 3, "reps": 12, "targetRpe": 7.0, "pct": null, "rest": "2min" }}
                    ]
                }}
            ]
        }}
    }}
    """

    try:
        # The new way to call the API
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[prompt, img]
        )
        
        raw_text = response.text.strip()
        
        # Strip markdown if the AI adds it
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:-3]
        elif raw_text.startswith("```"):
            raw_text = raw_text[3:-3]
            
        return json.loads(raw_text.strip())
    except Exception as e:
        print(f"Failed to extract JSON from {os.path.basename(image_path)}. Error: {e}")
        return None

def build_master_database(folder_path):
    master_db = {}
    
    # Sort filenames so it processes in alphabetical order
    filenames = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(('.png', '.jpg', '.jpeg'))])
    
    if not filenames:
        print("No images found in that folder!")
        return master_db

    for filename in filenames:
        w_start, w_end, d_start, d_end = parse_filename(filename)
        
        if w_start is None:
            print(f"Skipping {filename} - doesn't match naming convention (e.g., w1to4_d1to5.png).")
            continue
            
        image_path = os.path.join(folder_path, filename)
        extracted_data = extract_image_data(image_path, w_start, w_end, d_start, d_end)
        
        if extracted_data:
            for week_str, days_dict in extracted_data.items():
                if week_str not in master_db:
                    master_db[week_str] = {}
                master_db[week_str].update(days_dict)
                
    return master_db

if __name__ == "__main__":
    # --- 1. TYPE YOUR FOLDER NAME HERE ---
    TARGET_FOLDER = "POP_1" 
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    folder_path = os.path.join(base_dir, TARGET_FOLDER)
    
    if not os.path.exists(folder_path):
        print(f"❌ Error: Could not find a folder named '{TARGET_FOLDER}' in {base_dir}")
    else:
        print(f"Starting extraction for images inside: {TARGET_FOLDER}...\n")
        
        final_database = build_master_database(folder_path)
        
        if final_database:
            output_file = os.path.join(base_dir, f"{TARGET_FOLDER}_database.json")
            with open(output_file, "w") as f:
                json.dump(final_database, f, indent=4)
                
            print(f"\n✅ Complete! Master database saved to {output_file}")
        else:
            print("\n❌ Failed to build database.")