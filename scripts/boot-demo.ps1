# boot-demo.ps1 — quick local boot for Windows + WSL.
# Requires:
#   - $env:SELLER_PRIVATE_KEY set in your PowerShell session
#   - .env.buyer1, .env.buyer2, .env.buyer3 in agent/ (gitignored — see agent/.env.buyer{1,2,3}.example)
# Run from repo root:
#   .\scripts\boot-demo.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT = (Split-Path $PSScriptRoot -Parent)
$AGENT_DIR = "$ROOT\agent"

if (-not $env:SELLER_PRIVATE_KEY) {
    Write-Host 'ERROR: $env:SELLER_PRIVATE_KEY must be set' -ForegroundColor Red
    Write-Host "  Example: `$env:SELLER_PRIVATE_KEY='0x...'"
    exit 1
}

Set-Location $ROOT
wsl killall node tsx axl 2>$null; Start-Sleep 2
.\scripts\start-nodes.ps1

# Wait for nodeS topology to be reachable, then fetch seller pubkey
Start-Sleep 4
$sellerPeerId = (wsl curl -s http://127.0.0.1:9032/topology | wsl jq -r .our_public_key)
if (-not $sellerPeerId -or $sellerPeerId -eq 'null') {
    Write-Host 'ERROR: nodeS topology not reachable at :9032' -ForegroundColor Red
    exit 1
}
Write-Host "Seller peer id: $sellerPeerId"

# Seller (port 3004)
Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location '$AGENT_DIR'; `$env:AXL_API='http://127.0.0.1:9032'; `$env:PRIVATE_KEY='$($env:SELLER_PRIVATE_KEY)'; `$env:SELLER_PEER_ID='$sellerPeerId'; `$env:PORT=3004; pnpm exec tsx src/index.ts seller" -WindowStyle Minimized

# Buyers (ports 3001/3002/3003)
$buyerMap = @{ '.env.buyer1' = 3001; '.env.buyer2' = 3002; '.env.buyer3' = 3003 }
foreach ($k in $buyerMap.Keys) {
    $port = $buyerMap[$k]
    Start-Process powershell -ArgumentList "-NoExit","-Command","Set-Location '$AGENT_DIR'; Get-Content '$k' | Where-Object { `$_ -match '^[^#].+=.+' } | ForEach-Object { `$p=`$_ -split '=',2; [System.Environment]::SetEnvironmentVariable(`$p[0].Trim(),`$p[1].Trim(),'Process') }; `$env:SELLER_PEER_ID='$sellerPeerId'; `$env:PORT=$port; pnpm exec tsx src/index.ts run daemon" -WindowStyle Minimized
}

Write-Host "Boot complete: 4 AXL nodes + 4 agents (1 seller on PORT 3004, 3 buyers on PORT 3001-3003)"
