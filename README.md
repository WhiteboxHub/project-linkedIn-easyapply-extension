📘 LinkedIn Easy Apply — Chrome Extension

Automates LinkedIn Easy Apply submissions and exports a JSON report for each run.

🚀 Features

Auto-opens LinkedIn job pages and performs Easy Apply

Select Candidate and Employee before starting

Warning if user tries to start without selections

Tracks all successfully submitted applications

Exports one JSON file per run

Crash-safe: recovers & exports unfinished runs on restart

📁 Folder Structure

chrome-extension/
│
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
├── config/
│   ├── candidates.json
│   └── employees.json
│
├── background.js
├── content_script.js
├── popup.html
├── popup.js
├── easyapply_today.json
├── manifest.json
└── README.md


🧩 Config Files
config/candidates.json

[
  { "id": 1, "name": "Rohith" },
  { "id": 2, "name": "Abhi" },
  { "id": 3, "name": "Ram" }
]

config/employees.json

[
  { "id": 11, "name": "Suresh" },
  { "id": 12, "name": "Mahesh" }
]


📄 Job List File
easyapply_today.json

[
  {
    "jobId": "123456789",
    "title": "Software Engineer",
    "company": "Google",
    "location": "Bangalore"
  }
]


🔧 Installation

Open Chrome and go to:

chrome://extensions/


Enable Developer mode

Click Load unpacked

Select the chrome-extension/ folder

Open the extension popup

Select:

Candidate

Employee

Click Start Applying


📝 Run Log Export

At the end of each run, a JSON file downloads:

easyapply_run_<RUN_ID>_<timestamp>.json
