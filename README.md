# Kinetic

Prompt to motion launch video, on your PC. Type what you're launching, add your URL and screenshots, and Kinetic writes and animates a bold launch film: kinetic type, a colour per beat, real UI close-ups, cut on the beat. Edit any word, colour or beat, then export MP4 or GIF in 16:9, 9:16 or 1:1.

- **Website:** https://kinetic.launchloop.tech/
- **Download (Windows 10/11, 64-bit):** [Kinetic-Setup.exe](https://github.com/ShivamBwaj/kinetic/releases/latest/download/Kinetic-Setup.exe)

This repository holds the website and the release downloads. Kinetic is free while in early access.

## Install

1. Download `Kinetic-Setup.exe` from the latest release.
2. Windows SmartScreen may say it "protected your PC", because the installer is not code-signed yet. Click **More info**, then **Run anyway**.
3. Pick an install folder. No admin rights needed.

Each release lists the installer's SHA-256 so you can check the download:

```powershell
Get-FileHash .\Kinetic-Setup.exe -Algorithm SHA256
```
