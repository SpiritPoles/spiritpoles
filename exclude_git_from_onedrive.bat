@echo off
echo Marking .git folder as System so OneDrive stops syncing it...
attrib +H +S "C:\Users\chris\OneDrive\Chriss Claude Agent\Claude Cowork\Projects\Claude Virtual Assistant\spiritpoles\.git"
echo Done. Git lock conflicts caused by OneDrive should no longer occur.
pause
