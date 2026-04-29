#!/usr/bin/env pwsh
# demo-dropout-replay.ps1
# Day 5 P1: Drop-out replay demo
#   Buyer3 has AUTO_FUND=false — it never calls fund()
#   After validUntil elapses, keeper fires refundAll()
#   Buyers 1 & 2 get their USDC back automatically
#
# Usage (from repo root):
#   .\scripts\demo-dropout-replay.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT      = (Split-Path $PSScriptRoot -Parent)
$AGENT_DIR = "$ROOT\agent"
$CON_DIR   = "$ROOT\contracts"
$wslRoot   = wsl wslpath -u ($ROOT.Replace('\','\\'))

Write-Host '=== Huddle Day 5 Drop-out Replay Demo ===' -ForegroundColor Magenta
Write-Host 'Buyer3 will NOT fund (AUTO_FUND=false). After deadline, keeper fires refundAll().'
Write-Host ''

# ── Step 1: Clean slate ───────────────────────────────────────────────────
Write-Host '[1] Killing stale processes...'
wsl pkill -f 'axl/bin/node' 2>$null; $null
wsl pkill -f 'tsx src/index'  2>$null; $null
Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ── Step 2: Start AXL nodes ───────────────────────────────────────────────
Write-Host '[2] Starting AXL nodes...'
@('nodeA','nodeB','nodeC','nodeS') | ForEach-Object {
    $n = $_
    Start-Job -Name "axl-$n" -ScriptBlock {
        param($r,$node) wsl bash -c "cd '$r' && axl/scripts/run-node.sh $node 2>&1"
    } -ArgumentList $wslRoot,$n | Out-Null
}
Start-Sleep -Seconds 10
@(9002,9012,9022,9032) | ForEach-Object {
    $port = $_
    $resp = wsl curl -s --max-time 3 "http://127.0.0.1:$port/topology" 2>&1
    if ($resp -match 'our_public_key') { Write-Host "  port $port OK" }
    else { Write-Host "  port $port NOT READY" -ForegroundColor Yellow }
}

# ── Step 3: Launch seller + buyers (buyer3 has AUTO_FUND=false) ───────────
Write-Host '[3] Launching seller + buyers...'

if (-not $env:SELLER_PRIVATE_KEY) {
    Write-Host 'ERROR: $env:SELLER_PRIVATE_KEY is not set' -ForegroundColor Red
    Write-Host '  Set it before running: $env:SELLER_PRIVATE_KEY=''0x...'''
    exit 1
}
$sellerPeerId = (wsl curl -s http://127.0.0.1:9032/topology | wsl jq -r .our_public_key)
if (-not $sellerPeerId -or $sellerPeerId -eq 'null') {
    Write-Host 'ERROR: could not fetch seller peer id' -ForegroundColor Red
    exit 1
}

# Seller
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

# Buyers 1 & 2 — AUTO_FUND=true (they fund normally)
@('.env.buyer1','.env.buyer2') | ForEach-Object {
    $ef = $_
    $envPath = "$AGENT_DIR\$ef"
    $cmd = @"
Set-Location '$AGENT_DIR'
Get-Content '$envPath' | Where-Object {`$_ -match '^[^#].+=.+'} | ForEach-Object {`$p=`$_ -split '=',2; [System.Environment]::SetEnvironmentVariable(`$p[0].Trim(),`$p[1].Trim(),'Process')}
Write-Host '$ef (FUNDS) STARTING...' -ForegroundColor Cyan
pnpm exec tsx src/index.ts run h100-pcie-hour 1.5 1 10
"@
    Start-Process powershell -ArgumentList "-NoExit","-Command",$cmd -WindowStyle Normal
    Start-Sleep -Milliseconds 800
}

# Buyer3 — AUTO_FUND=false (simulates drop-out)
$envPath3 = "$AGENT_DIR\.env.buyer3"
$cmd3 = @"
Set-Location '$AGENT_DIR'
Get-Content '$envPath3' | Where-Object {`$_ -match '^[^#].+=.+'} | ForEach-Object {`$p=`$_ -split '=',2; [System.Environment]::SetEnvironmentVariable(`$p[0].Trim(),`$p[1].Trim(),'Process')}
`$env:AUTO_FUND='false'
Write-Host 'BUYER3 (DROP-OUT - will NOT fund) STARTING...' -ForegroundColor Red
pnpm exec tsx src/index.ts run h100-pcie-hour 1.5 1 10
"@
Start-Process powershell -ArgumentList "-NoExit","-Command",$cmd3 -WindowStyle Normal

Write-Host '    Seller + 3 buyers launched (buyer3 has AUTO_FUND=false)'
Write-Host ''
Write-Host '>>> Watch buyer1 window for: *** COALITION DEPLOYED ... ***' -ForegroundColor Yellow
Write-Host '>>> Buyer3 window should show: AUTO_FUND=false --- skipping fund' -ForegroundColor Yellow
Write-Host ''

$addr = Read-Host 'Coalition address (paste 0x... from buyer1 window)'

if ($addr -match '^0x[0-9A-Fa-f]{40}$') {
    Write-Host "[4] Running keeper — polling until expire then refundAll()..." -ForegroundColor Magenta
    Write-Host "    Coalition will expire in ~30 min. Keeper polls every 5s."
    $env:COALITION_ADDRESS = $addr
    $env:POLL_MS           = '5000'
    $env:STOP_ON_TERMINAL  = 'true'
    Set-Location $CON_DIR
    pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet
    Write-Host '=== DROP-OUT REPLAY COMPLETE: refundAll() fired ===' -ForegroundColor Green
} else {
    Write-Host 'Run keeper manually when ready:'
    Write-Host "  cd $CON_DIR"
    Write-Host '  $env:COALITION_ADDRESS="0x<address>"'
    Write-Host '  pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet'
}
