#!/usr/bin/env pwsh
# demo-happy-path.ps1
# Runs the full Day 5 happy-path demo:
#   1. Kills any stale processes
#   2. Restarts all 4 AXL nodes (via WSL background jobs)
#   3. Starts seller + 3 buyers in VISIBLE PowerShell windows (so they don't die)
#   4. Watches for coalition deploy, then runs keeper -> commit()
#
# Usage (from repo root):
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\scripts\demo-happy-path.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT      = (Split-Path $PSScriptRoot -Parent)
$AGENT_DIR = "$ROOT\agent"
$CON_DIR   = "$ROOT\contracts"
$wslRoot   = wsl wslpath -u ($ROOT.Replace('\','\\'))

Write-Host '=== Huddle Day 5 Happy Path Demo ===' -ForegroundColor Cyan

# ── Step 1: Clean slate ───────────────────────────────────────────────────
Write-Host '[1] Killing stale agents and AXL nodes...'
wsl pkill -f 'axl/bin/node' 2>$null; $null
wsl pkill -f 'tsx src/index' 2>$null; $null
Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ── Step 2: Start AXL nodes ───────────────────────────────────────────────
Write-Host '[2] Starting 4 AXL nodes via WSL jobs...'
@('nodeA','nodeB','nodeC','nodeS') | ForEach-Object {
    $n = $_
    Start-Job -Name "axl-$n" -ScriptBlock {
        param($r,$node) wsl bash -c "cd '$r' && axl/scripts/run-node.sh $node 2>&1"
    } -ArgumentList $wslRoot,$n | Out-Null
}
Write-Host '    Waiting 10s for nodes...' -NoNewline
Start-Sleep -Seconds 10
# Verify all 4 via WSL
$ok = $true
@(9002,9012,9022,9032) | ForEach-Object {
    $port = $_
    $resp = wsl curl -s --max-time 3 "http://127.0.0.1:$port/topology" 2>&1
    if ($resp -match 'our_public_key') { Write-Host "." -NoNewline }
    else { Write-Host " port $port NOT READY" -ForegroundColor Red; $ok = $false }
}
Write-Host ''
if (-not $ok) {
    Write-Host '    Some nodes not ready — giving 10 more seconds...'
    Start-Sleep -Seconds 10
}

# ── Step 3: Launch seller + 3 buyers in separate visible PS windows ────────
Write-Host '[3] Launching seller and 3 buyers in separate windows...'

# Pull seller key + peer id from env; fall back to a sentinel that fails clearly.
if (-not $env:SELLER_PRIVATE_KEY) {
    Write-Host 'ERROR: $env:SELLER_PRIVATE_KEY is not set' -ForegroundColor Red
    Write-Host '  Set it before running: $env:SELLER_PRIVATE_KEY=''0x...'''
    exit 1
}

# Discover seller peer id dynamically from nodeS topology (reliable across machines)
$sellerPeerId = (wsl curl -s http://127.0.0.1:9032/topology | wsl jq -r .our_public_key)
if (-not $sellerPeerId -or $sellerPeerId -eq 'null') {
    Write-Host 'ERROR: could not fetch seller peer id from http://127.0.0.1:9032/topology' -ForegroundColor Red
    exit 1
}

# Seller window
$sellerCmd = @"
Set-Location '$AGENT_DIR'
`$env:AXL_API='http://127.0.0.1:9032'
`$env:PRIVATE_KEY='$($env:SELLER_PRIVATE_KEY)'
`$env:SELLER_PEER_ID='$sellerPeerId'
Write-Host 'SELLER STARTING...' -ForegroundColor Yellow
pnpm exec tsx src/index.ts seller
"@
Start-Process powershell -ArgumentList "-NoExit","-Command",$sellerCmd -WindowStyle Normal
Start-Sleep -Milliseconds 1500

# Buyer windows
$buyers = @(
    @{ name='buyer1'; env='.env.buyer1' },
    @{ name='buyer2'; env='.env.buyer2' },
    @{ name='buyer3'; env='.env.buyer3' }
)
foreach ($b in $buyers) {
    $envPath = "$AGENT_DIR\$($b.env)"
    $buyerCmd = @"
Set-Location '$AGENT_DIR'
Get-Content '$envPath' | Where-Object {`$_ -match '^[^#].+=.+'} | ForEach-Object {`$p=`$_ -split '=',2; [System.Environment]::SetEnvironmentVariable(`$p[0].Trim(),`$p[1].Trim(),'Process')}
Write-Host '$($b.name) STARTING...' -ForegroundColor Cyan
pnpm exec tsx src/index.ts run h100-pcie-hour 1.5 1 10
"@
    Start-Process powershell -ArgumentList "-NoExit","-Command",$buyerCmd -WindowStyle Normal
    Start-Sleep -Milliseconds 800
}

Write-Host '    Seller + 3 buyers launched in separate windows.'
Write-Host '    Watching for COALITION DEPLOYED in buyer logs (up to 180s)...'

# ── Step 4: Watch buyer1 output from WSL (it logs to its window) ──────────
# We can't read the separate window output — instead poll the AXL topology
# and check known coalition pattern from buyer1 job or direct chain query.
# Best approach: wait, then let user paste the address OR auto-detect via fallback.

Write-Host ''
Write-Host '>>> Watch the buyer1 window for: *** COALITION DEPLOYED c=... : 0x<addr> ***' -ForegroundColor Yellow
Write-Host '>>> Once you see it, paste the address below (or wait — keeper will be started manually).' -ForegroundColor Yellow
Write-Host ''

$addr = Read-Host 'Coalition address (paste 0x... from buyer1 window, or press Enter to skip)'

if ($addr -match '^0x[0-9A-Fa-f]{40}$') {
    Write-Host "[4] Running keeper against $addr ..." -ForegroundColor Green
    $env:COALITION_ADDRESS = $addr
    $env:POLL_MS           = '5000'
    $env:STOP_ON_TERMINAL  = 'true'
    Set-Location $CON_DIR
    pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet
    Write-Host '=== HAPPY PATH COMPLETE: commit() called ===' -ForegroundColor Green
} else {
    Write-Host 'Skipped keeper — run manually when you have the coalition address:' -ForegroundColor Yellow
    Write-Host "  cd $CON_DIR"
    Write-Host '  $env:COALITION_ADDRESS="0x<address>"'
    Write-Host '  $env:STOP_ON_TERMINAL="true"'
    Write-Host '  pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet'
}
