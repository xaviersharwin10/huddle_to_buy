# start-nodes.ps1
# Starts all 4 AXL nodes (nodeA, nodeB, nodeC, nodeS) via WSL in separate windows.
# Run this FIRST before any buyer/seller agents.
# Usage: .\scripts\start-nodes.ps1

param(
    [string]$Root = (Split-Path $PSScriptRoot -Parent)
)

$wslRoot = wsl wslpath -u ($Root.Replace('\', '\\'))

Write-Host "AXL root (WSL): $wslRoot"
Write-Host 'Starting 4 AXL nodes in new terminals...'

$nodes = @('nodeA', 'nodeB', 'nodeC', 'nodeS')

foreach ($node in $nodes) {
    $bashCmd = "cd '$wslRoot' && axl/scripts/run-node.sh $node"
    try {
        Start-Process wt -ArgumentList "wsl bash -c `"$bashCmd`"" -ErrorAction Stop
    } catch {
        Start-Process cmd -ArgumentList "/c start `"AXL $node`" wsl bash -c `"$bashCmd`""
    }
    Start-Sleep -Milliseconds 500
}

Write-Host ''
Write-Host 'Waiting 6s for nodes to initialize...'
Start-Sleep -Seconds 6

Write-Host ''
Write-Host 'Checking node health...'
@(9002, 9012, 9022, 9032) | ForEach-Object {
    $port = $_
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/topology" -UseBasicParsing -TimeoutSec 5
        $j = $r.Content | ConvertFrom-Json
        Write-Host "  port $port OK  pubkey=$($j.our_public_key.Substring(0,16))..."
    } catch {
        Write-Host "  port $port NOT READY (may need more time)"
    }
}

Write-Host ''
Write-Host 'Done. If any ports show NOT READY, wait 10s and re-run the health check.'
