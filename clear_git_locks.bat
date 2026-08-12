@echo off
set REPO=C:\Users\chris\OneDrive\Chriss Claude Agent\Claude Cowork\Projects\Claude Virtual Assistant\spiritpoles\.git
del /f /q "%REPO%\HEAD.lock" 2>nul
del /f /q "%REPO%\index.lock" 2>nul
del /f /q "%REPO%\objects\maintenance.lock" 2>nul
del /f /q "%REPO%\refs\heads\main.lock" 2>nul
echo Git locks cleared.
