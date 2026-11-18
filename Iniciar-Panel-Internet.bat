@echo off
title DarkWaves - Panel por Internet
cd /d "%~dp0"

echo.
echo   Este acceso publica el panel en una URL temporal de Internet
echo   (https://algo.trycloudflare.com) para que entres desde el movil u
echo   otro equipo, sin cuentas ni tokens.
echo.
echo   Requiere que este PC este encendido y con el panel funcionando.
echo   La URL cambia cada vez que lo inicias.
echo.

if not exist "cloudflared.exe" (
  echo   Descargando cloudflared la primera vez...
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe'" || goto :error
)

start "" /b cmd /c "timeout /t 4 >nul && start "" http://localhost:4321/admin"
start "" /b cmd /c "timeout /t 8 >nul && findstr /c:\"https://\" nul"

echo   Abriendo tunel... busca la linea con https:// (esa es tu URL publica)
echo.
"%~dp0cloudflared.exe" tunnel --url http://localhost:4321
pause
exit /b 0

:error
echo   No se pudo descargar cloudflared. Revisa la conexion a Internet.
pause
