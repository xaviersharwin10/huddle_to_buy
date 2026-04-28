# run-happy-path.ps1
#
# Day 5 P0 demo: Full happy path
#   1. Start seller agent (nodeS / port 9032)
#   2. Start 3 buyers simultaneously (each loads its own .env.buyerN)
#   3. Watch buyer1 output for "COALITION DEPLOYED" address
#   4. Once coalition address is known, run keeper -> commit()
#
# Prerequisites:
#   - All 4 AXL nodes must be running (run: .\scripts\start-nodes.ps1 first)
#   - contracts/.env has PRIVATE_KEY and KEEPER_PRIVATE_KEY set
#
# Usage:
#   cd H:\Huddle1\huddle-to-buy
#   .\scripts\run-happy-path.ps1

param(
    [string]$AgentDir    = "H:\Huddle1\huddle-to-buy\agent",
    [string]$ContractDir = "H:\Huddle1\huddle-to-buy\contracts",
    [string]$Sku         = "h100-pcie-hour",
    [double]$MaxPrice    = 1.5,
    [int]   $DeadlineHrs = 1,
    [int]   $Qty         = 10,
    [int]   $KeeperPollMs = 4000
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
Write-Host "=== Huddle Day 5 — Happy Path Demo ===" -ForegroundColor Cyan
Write-Host "SKU=$Sku  max=`$$MaxPrice  deadline=${DeadlineHrs}h  qty=$Qty"
Write-Host ""

# ── 1. Verify AXL nodes are up ──────────────────────────────────────────────
Write-Host "[1/4] Checking AXL nodes..." -ForegroundColor Yellow
$ports = @(9002, 9012, 9022, 9032)
$allUp = $true
foreach ($port in $ports) {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/topology" -UseBasicParsing -TimeoutSec 3
        Write-Host "  port $port OK"
    } catch {
        Write-Host "  port $port NOT RESPONDING" -ForegroundColor Red
        $allUp = $false
    }
}
if (-not $allUp) {
    Write-Host ""
    Write-Host "ERROR: Some AXL nodes are not running." -ForegroundColor Red
    Write-Host "Start them first: .\scripts\start-nodes.ps1" -ForegroundColor Yellow
    exit 1
}

# ── 2. Start seller in background job ──────────────────────────────────────
Write-Host ""
Write-Host "[2/4] Starting seller agent (port 9032)..." -ForegroundColor Yellow

$env1 = "$AgentDir\.env.buyer1"
Load-EnvFile $env1  # Load to get SELLER_PEER_ID, KNOWN_PEERS etc.

$sellerJob = Start-Job -ScriptBlock {
    param($dir, $env1)
    Set-Location $dir
    # Load env vars for seller context (seller agent only needs AXL_API and SELLER_PEER_ID env)
    Get-Content $env1 | Where-Object { $_ -match "^\s*[^#].*=.*" } | ForEach-Object {
        $parts = $_ -split "=", 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
    $env:AXL_API = "http://127.0.0.1:9032"
    & pnpm exec tsx src/index.ts seller 2>&1
} -ArgumentList $AgentDir, $env1

Start-Sleep -Seconds 2
Write-Host "  seller job started (id=$($sellerJob.Id))"

# ── 3. Run 3 buyers and capture coalition address ──────────────────────────
Write-Host ""
Write-Host "[3/4] Starting 3 buyer agents simultaneously..." -ForegroundColor Yellow
Write-Host "      (watching for COALITION DEPLOYED address in buyer1 output)"

$buyerJobs = @()
$envFiles  = @(".env.buyer1", ".env.buyer2", ".env.buyer3")

foreach ($ef in $envFiles) {
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
    Write-Host "  buyer $ef started (job id=$($job.Id))"
}

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
                Write-Host ""
                Write-Host "  ✅ Coalition deployed: $coalitionAddress" -ForegroundColor Green
                break
            }
        }
        if ($coalitionAddress) { break }
    }
    Write-Host "  ... still waiting ..." -NoNewline
}

if (-not $coalitionAddress) {
    Write-Host ""
    Write-Host "ERROR: Timed out waiting for coalition address." -ForegroundColor Red
    Write-Host "Check buyer logs:" -ForegroundColor Yellow
    foreach ($job in $buyerJobs) {
        Write-Host "--- Job $($job.Id) ---"
        Receive-Job $job -Keep | Write-Host
    }
    Stop-Job $sellerJob, $buyerJobs
    exit 1
}

# ── 4. Keeper: call commit() ────────────────────────────────────────────────
Write-Host ""
Write-Host "[4/4] Running keeper → commit() on $coalitionAddress" -ForegroundColor Yellow

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
Write-Host "=== HAPPY PATH COMPLETE ===" -ForegroundColor Green
Write-Host "Coalition $coalitionAddress → Committed ✅"
Write-Host ""
Write-Host "Collecting final buyer logs..."
foreach ($job in $buyerJobs + $sellerJob) {
    $out = Receive-Job -Job $job -Keep -ErrorAction SilentlyContinue
    if ($out) {
        Write-Host "--- Job $($job.Id) ($($job.Name)) ---" -ForegroundColor Gray
        Write-Host ($out -join "`n") | Select-Object -Last 20
    }
}

Stop-Job $sellerJob, $buyerJobs -ErrorAction SilentlyContinue
Remove-Job $sellerJob, $buyerJobs -ErrorAction SilentlyContinue
