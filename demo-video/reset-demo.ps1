# Rebuild the demo data from scratch and start the demo server (port 3001), detached from this window.
$wd = Split-Path -Parent $PSScriptRoot
$p = (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($p) { Stop-Process -Id $p -Force; Start-Sleep -Seconds 2 }
Start-Process -FilePath 'node' -ArgumentList 'scripts/demo.js' -WorkingDirectory $wd -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:TEMP 'bfl-demo.log') -RedirectStandardError (Join-Path $env:TEMP 'bfl-demo.err.log')
for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 1; if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) { 'demo ready'; break } }
