@echo off
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Start-Desktop-Alerts.ps1"
if errorlevel 1 pause
