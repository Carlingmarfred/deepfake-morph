@echo off
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0server.ps1" -Port 8080
