#!/usr/bin/env python3
"""Encrypts scripts/database.js using AES-256-GCM with a password-derived key.
Output: scripts/database.enc (base64 of salt + iv + ciphertext+tag)
Compatible with Web Crypto API decryption in the browser.
"""

import os
import sys
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, 'scripts', 'database.js')
ENC_PATH = os.path.join(ROOT, 'scripts', 'database.enc')
PW_PATH = os.path.join(ROOT, 'password.txt')

ITERATIONS = 100_000

def main():
    # Read password
    if not os.path.exists(PW_PATH):
        print("ERROR: password.txt not found in project root.")
        sys.exit(1)
    password = open(PW_PATH, 'r', encoding='utf-8').read().strip()
    if not password:
        print("ERROR: password.txt is empty.")
        sys.exit(1)

    # Read plaintext database
    if not os.path.exists(DB_PATH):
        print("ERROR: scripts/database.js not found.")
        sys.exit(1)
    plaintext = open(DB_PATH, 'r', encoding='utf-8').read().encode('utf-8')

    # Derive key
    salt = os.urandom(16)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    key = kdf.derive(password.encode('utf-8'))

    # Encrypt
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    ciphertext_and_tag = aesgcm.encrypt(iv, plaintext, None)

    # Write: base64(salt + iv + ciphertext+tag)
    blob = salt + iv + ciphertext_and_tag
    encoded = base64.b64encode(blob).decode('ascii')

    with open(ENC_PATH, 'w', encoding='utf-8') as f:
        f.write(encoded)

    size_kb = len(encoded) / 1024
    print(f"Encrypted database.js -> database.enc ({size_kb:.1f} KB)")

if __name__ == '__main__':
    main()
