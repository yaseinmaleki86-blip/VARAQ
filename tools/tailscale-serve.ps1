# VARAQ private Tailnet sharing helper. Does NOT enable Tailscale Funnel.
# This script deliberately refuses to overwrite other Tailscale Serve mappings.
[CmdletBinding()]
param(
    [ValidateSet('connect','disconnect','status')]
    [string]$Action = 'connect',
    [ValidateRange(1,300)]
    [int]$WaitSeconds = 20
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$markerDir = Join-Path $root 'storage'
$markerPath = Join-Path $markerDir '.varaq_tailscale_serve.json'
$target = 'http://127.0.0.1:3030'

function Get-TailscaleExe {
    $cmd = Get-Command 'tailscale.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $paths = @()
    if ($env:ProgramFiles) { $paths += (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe') }
    if (${env:ProgramFiles(x86)}) { $paths += (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe') }
    if ($env:LOCALAPPDATA) { $paths += (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe') }
    foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { return $p } }
    throw 'Tailscale is not installed. Run TAILSCALE_INSTALL_WINDOWS.bat, then log in.'
}
function Invoke-Tailscale {
    param([string[]]$Arguments)
    $result = & $script:ts @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw ("Tailscale command failed (exit " + $LASTEXITCODE + "): " + $result.Trim())
    }
    return $result.Trim()
}
function Get-TailnetStatus {
    $raw = Invoke-Tailscale -Arguments @('status','--json')
    try { return ($raw | ConvertFrom-Json) }
    catch { throw 'Cannot read Tailscale status JSON. Please upgrade Tailscale.' }
}
function Get-ServeStatus {
    $raw = Invoke-Tailscale -Arguments @('serve','status','--json')
    if (-not $raw -or $raw -match '^No serve config') { return @{ Raw=''; Parsed=$null } }
    try { $json = $raw | ConvertFrom-Json }
    catch { throw 'Cannot read Tailscale Serve status JSON. Please upgrade Tailscale.' }
    return @{ Raw=$raw; Parsed=$json }
}
function Test-LocalWebsite {
    try {
        $response = Invoke-WebRequest -Uri ($target + '/market/health') -UseBasicParsing -TimeoutSec 3
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
    } catch { return $false }
}
function Test-PortOccupied {
    param($config, [int]$port)
    if (-not $config) { return $false }
    $name = [string]$port
    foreach ($kind in @('TCP','Web','AllowFunnel')) {
        $prop = $config.PSObject.Properties[$kind]
        if (-not $prop -or -not $prop.Value) { continue }
        foreach ($entry in @($prop.Value.PSObject.Properties)) {
            if ($entry.Name -eq $name -or $entry.Name -match (':' + $name + '$')) { return $true }
        }
    }
    return $false
}
function Test-OurEndpoint {
    param($config, [int]$port)
    if (-not $config -or -not $config.Web) { return $false }
    $suffix = ':' + $port
    foreach ($entry in @($config.Web.PSObject.Properties)) {
        if (-not $entry.Name.EndsWith($suffix)) { continue }
        $json = $entry.Value | ConvertTo-Json -Depth 12 -Compress
        if ($json -match '127\.0\.0\.1:3030|localhost:3030') { return $true }
    }
    return $false
}
function Test-ExclusiveOurEndpoint {
    param($config, [int]$port)
    if (-not (Test-OurEndpoint $config $port)) { return $false }
    $suffix = ':' + $port
    foreach ($entry in @($config.Web.PSObject.Properties)) {
        if (-not $entry.Name.EndsWith($suffix)) { continue }
        $handlers = $entry.Value.Handlers
        if (-not $handlers) { return $false }
        $paths = @($handlers.PSObject.Properties)
        if ($paths.Count -ne 1 -or $paths[0].Name -ne '/') { return $false }
        $proxy = [string]$paths[0].Value.Proxy
        if ($proxy -notmatch '127\.0\.0\.1:3030|localhost:3030') { return $false }
        return $true
    }
    return $false
}
function Get-MarkerPort {
    if (-not (Test-Path -LiteralPath $markerPath)) { return 0 }
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        $port = [int]$marker.https_port
        if ($marker.app -ne 'VARAQ' -or $port -notin @(443,8443)) { throw 'Invalid marker' }
        return $port
    } catch { throw 'VARAQ Serve marker is invalid; no mapping was changed.' }
}
function Show-Link {
    param($status, [int]$port)
    $dns = ''
    if ($status -and $status.Self -and $status.Self.DNSName) {
        $dns = ([string]$status.Self.DNSName).TrimEnd('.')
    }
    $suffix = if ($port -eq 443) { '' } else { ':' + $port }
    Write-Host 'Local VARAQ: http://127.0.0.1:3030/'
    if ($dns) {
        Write-Host ('Private Tailnet URL: https://' + $dns + $suffix + '/') -ForegroundColor Green
        Write-Host ('Store: https://' + $dns + $suffix + '/market/')
    } else {
        Write-Host 'Use the private URL printed by tailscale serve status.'
    }
    Write-Host 'Only devices allowed by your Tailnet access rules can reach it.'
}

try {
    $script:ts = Get-TailscaleExe
    $status = Get-TailnetStatus
    if ($Action -eq 'status') {
        Write-Host ('Tailscale state: ' + $status.BackendState)
        Write-Host ('VARAQ local server ready: ' + (Test-LocalWebsite))
        $serve = Get-ServeStatus
        Write-Host $serve.Raw
        $ourPort = Get-MarkerPort
        if ($ourPort -gt 0 -and (Test-OurEndpoint $serve.Parsed $ourPort)) {
            Show-Link $status $ourPort
        }
        exit 0
    }
    if ($Action -eq 'disconnect') {
        $ourPort = Get-MarkerPort
        if ($ourPort -eq 0) {
            throw 'No VARAQ-owned Serve marker found. Refusing to disable an unrelated Tailscale service.'
        }
        $serve = Get-ServeStatus
        if (-not (Test-ExclusiveOurEndpoint $serve.Parsed $ourPort)) {
            throw 'VARAQ Serve mapping is missing or has extra routes. Nothing was removed.'
        }
        Write-Host ('Disabling only HTTPS ' + $ourPort + ' mapping for VARAQ...')
        Write-Host (Invoke-Tailscale -Arguments @('serve',('--https=' + $ourPort),'off'))
        Remove-Item -LiteralPath $markerPath -Force
        Write-Host 'VARAQ Tailnet sharing stopped. Tailscale connection remains active.' -ForegroundColor Green
        exit 0
    }
    if ($status.BackendState -ne 'Running') {
        Write-Host 'Tailscale is not connected. Complete the browser sign-in if prompted.' -ForegroundColor Yellow
        Write-Host (Invoke-Tailscale -Arguments @('up'))
        $status = Get-TailnetStatus
        if ($status.BackendState -ne 'Running') { throw 'Tailscale still not connected. Open the Tailscale app and sign in.' }
    }
    $until = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $until -and -not (Test-LocalWebsite)) { Start-Sleep -Seconds 2 }
    if (-not (Test-LocalWebsite)) {
        throw 'VARAQ is not responding at http://127.0.0.1:3030/market/health. Start START_UNIFIED_WINDOWS.bat first.'
    }
    $serve = Get-ServeStatus
    $ourPort = Get-MarkerPort
    if ($ourPort -gt 0) {
        if (Test-OurEndpoint $serve.Parsed $ourPort) {
            Write-Host 'VARAQ is already shared inside this Tailnet.' -ForegroundColor Green
            Show-Link $status $ourPort
            exit 0
        }
        throw 'Previously registered VARAQ mapping has changed. Refusing to overwrite another service.'
    }
    $selectedPort = 0
    foreach ($candidate in @(443,8443)) {
        if (-not (Test-PortOccupied $serve.Parsed $candidate)) {
            $selectedPort = $candidate
            break
        }
    }
    if ($selectedPort -eq 0) {
        throw 'Tailscale Serve ports 443 and 8443 are already in use; refusing to overwrite them.'
    }
    Write-Host ('Starting PRIVATE Tailscale Serve on HTTPS ' + $selectedPort + ' (not Funnel)...')
    Write-Host (Invoke-Tailscale -Arguments @('serve','--bg',('--https=' + $selectedPort),$target))
    $serve = Get-ServeStatus
    if (-not (Test-OurEndpoint $serve.Parsed $selectedPort)) { throw 'Serve did not confirm the VARAQ target. Review tailscale serve status.' }
    if (-not (Test-Path -LiteralPath $markerDir)) { New-Item -ItemType Directory -Path $markerDir -Force | Out-Null }
    $details = @{ app='VARAQ'; local_target=$target; https_port=$selectedPort; created=(Get-Date).ToString('o'); private_tailnet_only=$true }
    $details | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8
    Show-Link (Get-TailnetStatus) $selectedPort
    Write-Host 'Use TAILSCALE_DISCONNECT_WINDOWS.bat to stop sharing.' -ForegroundColor Yellow
    exit 0
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
