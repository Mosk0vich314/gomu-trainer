import os
import sys
import json
import re
import time
from PIL import Image
from google import genai

# Read the API key from your secret local file
try:
    with open("api_key.txt", "r") as key_file:
        API_KEY = key_file.read().strip()
except FileNotFoundError:
    print("❌ Error: Could not find api_key.txt. Please create it and paste your API key inside.")
    sys.exit()

# Initialize the Client
client = genai.Client(api_key=API_KEY)

def extract_json_from_response(text):
    """Safely extracts JSON from the LLM's markdown block."""
    match = re.search(r"```json\n(.*?)\n```", text, re.DOTALL)
    if match:
        return match.group(1)
    if text.startswith("```"):
        return text[3:-3].strip()
    return text.strip()

def build_master_database_iterative(folder_path, folder_name):
    filenames = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(('.png', '.jpg', '.jpeg'))])
    
    if not filenames:
        print(f"❌ No images found in the {folder_name} folder!")
        return None

    print(f"Loading {len(filenames)} images from {folder_name}...")
    master_database = {}

    for filename in filenames:
        image_path = os.path.join(folder_path, filename)
        print(f"\n  -> Extracting data from: {filename}...")
        img = Image.open(image_path)

        prompt = f"""
        You are a strict data extraction AI. Read this powerlifting program screenshot.
        
        CRITICAL INSTRUCTION - DO NOT IGNORE: 
        The filename of this image is: '{filename}'.
        You MUST extract the Week and Day numbers from this filename and use them as the EXACT keys in your JSON.
        
        - If the filename is 'w11to14_d2', your JSON week keys MUST be "11", "12", "13", and "14". 
        - DO NOT start at "1" unless the filename explicitly says 'w1'. 
        - If you output "1", "2", "3", "4" for an image named 'w11to14', you have failed.
        
        Format your response EXACTLY like this example (assuming filename was w11_d2):
        {{
          "11": {{
            "2": [
              {{
                "name": "Exercise Name",
                "type": "main", // or "acc" for accessory
                "notes": "Any coach notes",
                "blocks": [
                  {{ "sets": 3, "reps": 5, "type": "top", "targetRpe": 8.0, "pct": 0.80 }},
                  {{ "sets": 2, "reps": 5, "type": "backoff", "targetRpe": null, "pct": 0.75 }}
                ]
              }}
            ]
          }}
        }}

        Rules:
        1. ONLY output valid JSON.
        2. Convert percentages to decimals (e.g., 75% = 0.75).
        3. Main lifts have 'Top Set' and 'Backoff'. Accessories have type "acc" and pct `null`.
        4. Capture notes in a "notes" string. Use null if none.
        5. Do not include rest times.
        """

        # --- BULLETPROOF RETRY LOOP ---
        success = False
        while not success:
            try:
                response = client.models.generate_content(
                    model='gemini-2.5-pro', 
                    contents=[prompt, img]
                )
                
                raw_text = extract_json_from_response(response.text)
                extracted_data = json.loads(raw_text)
                
                # Deep merge
                for week_num, days in extracted_data.items():
                    if week_num not in master_database:
                        master_database[week_num] = {}
                    for day_num, exercises in days.items():
                        master_database[week_num][day_num] = exercises
                        
                print(f"     ✅ Successfully merged data for Week(s): {list(extracted_data.keys())}")
                success = True # Break the while loop and move to the next image
                
                # Standard slight pause so we don't spam the API unnecessarily
                time.sleep(5) 
                
            except Exception as e:
                error_msg = str(e).lower()
                # If we hit a rate limit, catch it, sleep for 60 seconds, and loop back to try again
                if "429" in error_msg or "exhausted" in error_msg or "quota" in error_msg:
                    print("     ⏳ Rate limit hit! Google requires a cool-down. Pausing for 60 seconds...")
                    time.sleep(60)
                else:
                    # If it's a real error (like hallucinated JSON), print it and skip the image
                    print(f"     ❌ Failed to parse JSON for {filename}. Skipping. Error: {e}")
                    break 

    return master_database

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("❌ Error: You must provide a folder name.")
        print("Usage: python build_database.py <FOLDER_NAME>")
        sys.exit()

    TARGET_FOLDER = sys.argv[1] 
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    folder_path = os.path.join(base_dir, TARGET_FOLDER)
    
    if not os.path.exists(folder_path):
        print(f"❌ Error: Could not find a folder named '{TARGET_FOLDER}' in {base_dir}")
    else:
        print(f"\n🚀 Starting BULLETPROOF extraction for: {TARGET_FOLDER}...")
        final_database = build_master_database_iterative(folder_path, TARGET_FOLDER)
        
        if final_database:
            output_file = os.path.join(base_dir, f"{TARGET_FOLDER}_database.json")
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(final_database, f, indent=4)
            print(f"\n✅ Complete! Master database saved to {output_file}\n")
        else:
            print("\n❌ Failed to build database.")