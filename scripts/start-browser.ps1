# Windows: open Chrome with the MCP automation profile (CDP on port 9222).
# Run once to sign in to Google (bautran / Profile 10). The session is kept in
# .\chrome-profile-profile-10 and reused by the MCP server afterwards.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\start-browser.ps1

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
$Root = $ProjectDir -replace '\\', '/'

$js = @"
const { launchKiaraProfile } = await import('file:///$Root/src/browser/launch-profile.js');
const { getPage } = await import('file:///$Root/src/browser/connect.js');
await launchKiaraProfile(false);
await getPage().goto('https://accounts.google.com/');
console.log('Chrome is open on CDP port 9222. Sign in, then close this window or press Ctrl+C.');
"@

Set-Location $ProjectDir
node --input-type=module -e $js
