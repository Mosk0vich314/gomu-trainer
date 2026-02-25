import os
import sys
import json
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

def build_master_database_batch(folder_path, folder_name):
    filenames = sorted([f for f in os.listdir(folder_path) if f.lower().endswith(('.png', '.jpg', '.jpeg'))])
    
    if not filenames:
        print(f"❌ No images found in the {folder_name} folder!")
        return None

    print(f"Loading {len(filenames)} images from {folder_name}...")
    
    # Load all images into a list
    image_list = []
    for filename in filenames:
        image_path = os.path.join(folder_path, filename)
        image_list.append(Image.open(image_path))

    prompt = f"""
    You are a data extraction AI. I am providing you with {len(filenames)} images that together make up a complete powerlifting program block.
    
    Carefully read across ALL the images to extract the full workout data. 
    Format the combined data EXACTLY as a single JSON object. 
    
    The top-level keys must be the week numbers (as strings, e.g., "1", "2").
    The second-level keys must be the day numbers (as strings, e.g., "1", "2").
    The values must be the array of exercises for that specific week and day.

    Rules:
    1. Only output valid JSON. No markdown formatting or code blocks.
    2. Convert percentages to decimals (e.g., 75% = 0.75). If no percentage, use null.
    3. Main lifts have 'Top Set' and 'Backoff' blocks. Accessories do not need 1RM math (set type to "acc", pct to null).
    4. If there are any coach notes, instructions, or specific cues written for an exercise, capture them in a "notes" string. If none, use null.
    5. Do not include rest times.
    """

    print(f"Sending batch request to Gemini 2.5 Flash. Please wait...")

    try:
        # We pass the prompt string PLUS the entire list of images in one single request
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[prompt] + image_list
        )
        raw_text = response.text.strip()
        
        # Clean up the markdown formatting if the AI includes it
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:-3]
        elif raw_text.startswith("```"):
            raw_text = raw_text[3:-3]
            
        return json.loads(raw_text.strip())
    
    except Exception as e:
        print(f"❌ Failed to extract JSON for {folder_name}. Error: {e}")
        return None

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
        print(f"\n🚀 Starting BATCH extraction for: {TARGET_FOLDER}...")
        final_database = build_master_database_batch(folder_path, TARGET_FOLDER)
        
        if final_database:
            output_file = os.path.join(base_dir, f"{TARGET_FOLDER}_database.json")
            with open(output_file, "w") as f:
                json.dump(final_database, f, indent=4)
            print(f"✅ Complete! Master database saved to {output_file}\n")
        else:
            print("\n❌ Failed to build database.")