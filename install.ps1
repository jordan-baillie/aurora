#requires -Version 5.1
<#
  Summon installer (Windows PowerShell) — build the agent + harness and put `summon` on your PATH.
  Idempotent. Run from the repo root:  powershell -ExecutionPolicy Bypass -File install.ps1
#>
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node not found. Summon needs Node >= 22."; exit 1 }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { Write-Error "Node >= 22 required (found $(node --version))."; exit 1 }

Write-Host "Summon - installing"
Write-Host "  1/3  npm install"
npm install
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }
Write-Host "  2/3  build (tui . ai . agent . coding-agent)"
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "build failed"; exit 1 }
Write-Host "  3/3  link the 'summon' command"
Push-Location packages/coding-agent
npm link
$linkExit = $LASTEXITCODE
Pop-Location
if ($linkExit -ne 0) { Write-Error "npm link failed"; exit 1 }

# Post-link sanity check.
$summon = Get-Command summon -ErrorAction SilentlyContinue
if ($summon) {
  Write-Host "  ok   summon is on your PATH ($((summon --version 2>&1 | Select-Object -First 1)))"
} else {
  Write-Warning "'summon' is not on your PATH yet. Ensure your npm global bin dir is on PATH:"
  Write-Warning "  npm prefix -g  -> add that directory to your PATH, then reopen the terminal."
}

Write-Host ""
Write-Host "Done. Summon is installed."
Write-Host "  summon            # start, then run /login once to connect your Claude subscription (OAuth)"
Write-Host ""
Write-Host "The harness is built in: spawn_agent / spawn_agents / run_team / run_blueprint."
Write-Host "Config lives in ~/.summon/. Switch themes with 'summon themes <name>' (default: summon)."
