@echo off
cd /d "%~dp0"
echo Force pushing to GitHub...
git push --force origin main
echo.
if %ERRORLEVEL% == 0 (
  echo SUCCESS - Cloudflare Pages will deploy in ~30 seconds.
) else (
  echo FAILED - see error above.
)
pause
