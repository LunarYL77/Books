@echo off
chcp 65001 >nul
cd /d %~dp0backend
where python >nul 2>nul
if %errorlevel%==0 (
  python main.py
) else (
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" main.py
)
pause
