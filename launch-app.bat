@echo off
setlocal
cd /d "%~dp0"
start "Deepfake OT Morph Lab Server" powershell.exe -NoExit -ExecutionPolicy Bypass -NoProfile -File "%~dp0server.ps1" -Port 8080
timeout /t 2 /nobreak >nul
start "" http://localhost:8080/
