@echo off
if "%~1"=="" (
    echo Usage: start.cmd ^<PORT^>
    exit /b 1
)
set APP_PORT=%~1
docker-compose up --build -d
echo Stock Market running at http://localhost:%APP_PORT%