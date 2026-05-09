@echo off
setlocal

cd /d "%~dp0"

set "PORT=8005"
set "URL=http://127.0.0.1:%PORT%/index.html"

echo Starting Fireboy and Watergirl 5 on port %PORT%...
start "" /min node server.js

timeout /t 2 /nobreak >nul

echo Opening %URL%
start "" "%URL%"

echo.
echo The game should now be opening in your browser.
echo If the port is already in use, close old Node/Python servers and run this script again.

endlocal
