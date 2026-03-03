def remove_db(filename):
    with open(filename, 'r', encoding='utf-8') as f:
        code = f.read()

    start_idx = code.find("const db =")
    if start_idx == -1:
        print("Could not find 'const db ='")
        return
        
    brace_start = code.find('{', start_idx)
    brace_count = 0
    end_idx = -1
    
    for i in range(brace_start, len(code)):
        if code[i] == '{':
            brace_count += 1
        elif code[i] == '}':
            brace_count -= 1
            if brace_count == 0:
                end_idx = i + 1 
                break
                
    if end_idx != -1:
        # Catch the trailing semicolon if it exists
        if end_idx < len(code) and code[end_idx] == ';':
            end_idx += 1
            
        clean_code = code[:start_idx] + "const db = {}; // [DATABASE STRIPPED FOR SHARING]" + code[end_idx:]
        
        with open("clean_app.html", 'w', encoding='utf-8') as f:
            f.write(clean_code)
        print("Success! Stripped code saved to clean_app.html")

# CHANGE THIS to your actual HTML file name
remove_db("noDB.html")