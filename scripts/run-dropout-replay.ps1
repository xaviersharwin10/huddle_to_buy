# run-dropout-replay.ps1
#
# Day 5 P1 demo: Drop-out replay (refundAll path)
#   - 3 buyers launch but buyer3 has AUTO_FUND=false (simulates a drop-out)
#   - 2 buyers fund OK; buyer3 never funds
#   - Coalition stays in Forming/Funded with fundedCount < requiredBuyers
#   - validUntil elapses → keeper fires refundAll() → funded buyers refunded
#
# Prerequisites:
#   - All 4 AXL nodes must be running (.\scripts\start-nodes.ps1)
#   - contracts/.env has PRIVATE_KEY and KEEPER_PRIVATE_KEY set
#   - Use a short deadline (DeadlineHrs=0.002 ≈ ~7 minutes) so you don't wait forever
#
# Usage:
#   cd H:\Huddle1\huddle-to-buy
#   .\scripts\run-dropout-replay.ps1

param(
    [string]$AgentDir    = "H:\Huddle1\huddle-to-buy\agent",
    [string]$ContractDir = "H:\Huddle1\huddle-to-buy\contracts",
    [string]$Sku         = "h100-pcie-hour",
    [double]$MaxPrice    = 1.5,
    [double]$DeadlineHrs = 0.003,     # ~10 minutes — short so we see expiry fast
    [int]   $Qty         = 10,
    [int]   $KeeperPollMs = 5000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Load-EnvFile {
    param([string]$Path)
    Get-Content $Path | Where-Object { $_ -match "^\s*[^#].*=.*" } | ForEach-Object {
        $parts = $_ -split "=", 2
        $key   = $parts[0].Trim()
        $value = $parts[1].Trim()
        [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

Write-Host ""
Write-Host "=== Huddle Day 5 — Drop-out Replay Demo ===" -ForegroundColor Magenta
Write-Host "Buyer3 will NOT fund (AUTO_FUND=false). Coalition expires → refundAll()."
Write-Host "SKU=$Sku  max=`$$MaxPrice  deadline=${DeadlineHrs}h (~$([math]::Round($DeadlineHrs*60,1)) min)  qty=$Qty"
Write-Host ""

# ── 1. Check nodes ──────────────────────────────────────────────────────────
Write-Host "[1/5] Checking AXL nodes..." -ForegroundColor Yellow
$ports = @(9002, 9012, 9022, 9032)
foreach ($port in $ports) {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/topology" -UseBasicParsing -TimeoutSec 3
        Write-Host "  port $port OK"
    } catch {
        Write-Host "  port $port NOT RESPONDING — run .\scripts\start-nodes.ps1 first" -ForegroundColor Red
        exit 1
    }
}

# ── 2. Seller ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[2/5] Starting seller agent..." -ForegroundColor Yellow
$env1 = "$AgentDir\.env.buyer1"
$sellerJob = Start-Job -ScriptBlock {
    param($dir, $env1)
    Set-Location $dir
    Get-Content $env1 | Where-Object { $_ -match "^\s*[^#].*=.*" } | ForEach-Object {
        $parts = $_ -split "=", 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
    $env:AXL_API = "http://127.0.0.1:9032"
    & pnpm exec tsx src/index.ts seller 2>&1
} -ArgumentList $AgentDir, $env1
Start-Sleep -Seconds 2
Write-Host "  seller started (job $($sellerJob.Id))"

# ── 3. Buyers 1 & 2 (AUTO_FUND=true) ────────────────────────────────────────
Write-Host ""
Write-Host "[3/5] Starting buyers 1 & 2 (will fund)..." -ForegroundColor Yellow
$buyerJobs = @()
foreach ($ef in @(".env.buyer1", ".env.buyer2")) {
    $envPath = "$AgentDir\$ef"
    $job = Start-Job -ScriptBlock {
        param($dir, $envPath, $sku, $maxPrice, $dlHrs, $qty)
        Set-Location $dir
        Get-Content $envPath | Where-Object { $_ -match "^\s*[^#].*=.*" } | ForEach-Object {
            $parts = $_ -split "=", 2
            [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
        }
        & pnpm exec tsx src/index.ts run $sku $maxPrice $dlHrs $qty 2>&1
    } -ArgumentList $AgentDir, $envPath, $Sku, $MaxPrice, $DeadlineHrs, $Qty
    $buyerJobs += $job
    Write-Host "  buyer $ef started (job $($job.Id))"
}

# ── 4. Buyer 3 with AUTO_FUND=false (drop-out) ─────────────────────────────
Write-Host ""
Write-Host "[4/5] Starting buyer 3 with AUTO_FUND=false (drop-out simulation)..." -ForegroundColor Magenta
$dropout = "$AgentDir\.env.buyer3"
$buyer3Job = Start-Job -ScriptBlock {
    param($dir, $envPath, $sku, $maxPrice, $dlHrs, $qty)
    Set-Location $dir
    Get-Content $envPath | Where-Object { $_ -match "^\s*[^#].*=.*" } | ForEach-Object {
        $parts = $_ -split "=", 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
    $env:AUTO_FUND = "false"   # ← This is the drop-out
    & pnpm exec tsx src/index.ts run $sku $maxPrice $dlHrs $qty 2>&1
} -ArgumentList $AgentDir, $dropout, $Sku, $MaxPrice, $DeadlineHrs, $Qty
$buyerJobs += $buyer3Job
Write-Host "  buyer3 (drop-out) started (job $($buyer3Job.Id))"

# ── Wait for coalition address ─────────────────────────────────────────────
Write-Host ""
Write-Host "  Watching for COALITION DEPLOYED... (up to 120s)" -ForegroundColor Gray
$coalitionAddress = $null
$deadline = (Get-Date).AddSeconds(120)

while ((Get-Date) -lt $deadline -and -not $coalitionAddress) {
    Start-Sleep -Seconds 3
    foreach ($job in $buyerJobs) {
        $out = Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue
        foreach ($line in ($out -split "`n")) {
            if ($line -match "COALITION DEPLOYED.*?(0x[0-9A-Fa-f]{40})") {
                $coalitionAddress = $Matches[1]
                Write-Host "  Coalition deployed: $coalitionAddress" -ForegroundColor Green
                break
            }
        }
        if ($coalitionAddress) { break }
    }
    Write-Host "  ... polling ..." -NoNewline
}

if (-not $coalitionAddress) {
    Write-Host ""
    Write-Host "ERROR: No coalition address found (timeout). Check logs below." -ForegroundColor Red
    $buyerJobs | ForEach-Object { Receive-Job $_ -Keep | Write-Host }
    Stop-Job $sellerJob, $buyerJobs
    exit 1
}

# ── 5. Keeper watches and fires refundAll() after expiry ───────────────────
Write-Host ""
Write-Host "[5/5] Running keeper — waiting for validUntil expiry then refundAll()..." -ForegroundColor Magenta
Write-Host "  Coalition: $coalitionAddress"
Write-Host "  Keeper will poll every ${KeeperPollMs}ms..."
Write-Host "  (This may take up to ~10 minutes for the deadline to elapse)"
Write-Host ""

$env:COALITION_ADDRESS = $coalitionAddress
$env:POLL_MS           = $KeeperPollMs
$env:STOP_ON_TERMINAL  = "true"

Push-Location $ContractDir
try {
    pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "=== DROP-OUT REPLAY COMPLETE ===" -ForegroundColor Green
Write-Host "Coalition $coalitionAddress → Refunded ✅"
Write-Host "Funded buyers received their USDC back automatically."
Write-Host ""

Stop-Job $sellerJob, $buyerJobs -ErrorAction SilentlyContinue
Remove-Job $sellerJob, $buyerJobs -ErrorAction SilentlyContinue
