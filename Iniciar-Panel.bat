@echo off
title DarkWaves - Panel de administracion
cd /d "%~dp0"

echo.
echo   Iniciando el panel de DarkWaves...
echo   Se abrira en el navegador: http://localhost:4321/admin
echo.
echo   Deja esta ventana abierta mientras administras el panel.
echo   Para cerrar el panel, cierra esta ventana o pulsa Ctrl+C.
echo.

start "" /b cmd /c "timeout /t 3 >nul && start "" http://localhost:4321/admin"
node server.mjs

echo.
echo   El panel se detuvo.
pause
