🔧 How to Install
1. Open Chrome

Go to:

chrome://extensions/

2. Enable Developer Mode

Toggle Developer mode in the top-right.

3. Load Unpacked Extension

Click Load unpacked → select the chrome-extension/ folder.

4. Open Extension Popup

Click the extension icon

Enter an encryption passphrase

Save encrypted credentials (optional)

Click Start Applying

📝 How It Works
1. background.js

Loads easyapply_today.json

Opens job URL:
https://www.linkedin.com/jobs/view/<JOB_ID>/

Injects content_script.js

Waits between job applications

Closes the tab after processing

2. content_script.js

Finds the "Easy Apply" button

Clicks it

Attempts to find and submit the application modal

(needs tuning depending on LinkedIn UI changes)

3. storage_crypto.js

Encrypts/decrypts LinkedIn credentials using AES-GCM

Avoids storing plaintext passwords

🔐 Credentials Storage

Credentials are encrypted using:

PBKDF2 key derivation

AES-GCM encryption

Random salt + IV

Stored in Chrome local storage as base64.

You must supply the same passphrase to decrypt credentials when running Start Apply.