<#
.SYNOPSIS
  Rebuild the pipeline and drop the running MCP server + its browser so the next
  tool call picks up fresh code.

.DESCRIPTION
  Claude Code spawns the MCP server as a child process over stdio. It runs
  whatever was on disk when it started, so edits to src/ have no effect until
  that process is replaced.

  This script:
    1. Rebuilds TypeScript (unless -NoBuild)
    2. Kills Chrome processes holding the realestate-mcp browser profile
       (Chrome locks its user-data-dir; a live one blocks `setup` and serves
       stale cookies)
    3. Kills the MCP server process for THIS project
    4. Reports whether the profile is warm

  Targeting is deliberately narrow: only node processes whose command line
  references this repo's dist/cli.js (or the old dist/index.js), and only Chrome processes whose command
  line references the realestate-mcp profile. Your normal browser is untouched.

.PARAMETER NoBuild
  Skip the TypeScript build.

.PARAMETER CheckOnly
  Report state and exit without killing anything.

.PARAMETER Profile
  Browser profile directory. Defaults to ~/.realestate-mcp/profile.

.EXAMPLE
  ./scripts/reload-mcp.ps1
.EXAMPLE
  ./scripts/reload-mcp.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
  [switch]$NoBuild,
  [switch]$CheckOnly,
  [string]$Profile = (Join-Path $env:USERPROFILE ".realestate-mcp\profile")
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repo 'dist\cli.js'

function Write-Step($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  $t" -ForegroundColor Green }
function Write-Warn2($t){ Write-Host "  $t" -ForegroundColor Yellow }

# Match this repo's server only. Command lines vary ("node dist/cli.js mcp" vs an
# absolute path), so match on the repo folder OR the dist/cli.js suffix while
# excluding other projects.
$repoLeaf = Split-Path $repo -Leaf
function Get-ServerProcs {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $c = $_.CommandLine
      $c -and ($c -match 'dist[\\/](index|cli)\.js') -and
      ($c -match [regex]::Escape($repo) -or $c -match [regex]::Escape($repoLeaf) -or $c -notmatch '[A-Za-z]:\\')
    }
}
function Get-ProfileChrome {
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'realestate-mcp' }
}

Write-Host "sydney-rental-data-pipeline reload" -ForegroundColor White
Write-Host ("-" * 46)
Write-Host "  repo:    $repo"
Write-Host "  profile: $Profile"

# ---- current state -----------------------------------------------------------
Write-Step "Current state"
$servers = @(Get-ServerProcs)
$chromes = @(Get-ProfileChrome)
Write-Host "  MCP server processes: $($servers.Count)"
foreach ($s in $servers) { Write-Host "    pid=$($s.ProcessId)  started=$($s.CreationDate)" }
Write-Host "  Chrome on profile:    $($chromes.Count)"
if (Test-Path $Profile) {
  $mb = [math]::Round((Get-ChildItem $Profile -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum / 1MB, 1)
  Write-Host "  Profile exists:       yes ($mb MB)"
} else {
  Write-Warn2 "Profile missing - run:  node dist/cli.js setup"
}

if ($CheckOnly) { Write-Host "`n(check-only, nothing changed)"; return }

# ---- build -------------------------------------------------------------------
if (-not $NoBuild) {
  Write-Step "Building"
  # Invoke the local compiler directly. `npx tsc` resolves inconsistently when
  # called from a script ("could not determine executable to run").
  $tsc = Join-Path $repo 'node_modules\typescript\bin\tsc'
  if (-not (Test-Path $tsc)) {
    Write-Host "`n  typescript not installed - run: npm install" -ForegroundColor Red
    exit 1
  }
  Push-Location $repo
  try {
    & node $tsc 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Write-Host "`n  BUILD FAILED - server not touched." -ForegroundColor Red; exit 1 }
    Write-Ok "build ok"
  } finally { Pop-Location }
} else {
  Write-Step "Skipping build (-NoBuild)"
}

# ---- stop browser ------------------------------------------------------------
Write-Step "Releasing browser profile"
$chromes = @(Get-ProfileChrome)
if ($chromes.Count -eq 0) {
  Write-Ok "no Chrome holding the profile"
} else {
  foreach ($c in $chromes) {
    try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop } catch {}
  }
  Start-Sleep -Milliseconds 1200
  $left = @(Get-ProfileChrome).Count
  if ($left -eq 0) { Write-Ok "stopped $($chromes.Count) Chrome process(es)" }
  else { Write-Warn2 "$left Chrome process(es) still running" }
}

# ---- stop server -------------------------------------------------------------
Write-Step "Stopping MCP server"
$servers = @(Get-ServerProcs)
if ($servers.Count -eq 0) {
  Write-Ok "not running (will start fresh on next tool call)"
} else {
  foreach ($s in $servers) {
    try { Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop; Write-Ok "stopped pid=$($s.ProcessId)" } catch { Write-Warn2 $_.Exception.Message }
  }
  # Claude Code can hold more than one server process (it respawns quickly, and
  # a supervisor copy may linger). Sweep again so none survive with stale code.
  Start-Sleep -Milliseconds 800
  $again = @(Get-ServerProcs)
  foreach ($s in $again) {
    try { Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop; Write-Ok "stopped straggler pid=$($s.ProcessId)" } catch {}
  }
}

# ---- verify ------------------------------------------------------------------
Write-Step "Verifying profile is warm"
Push-Location $repo
try {
  $env:REALESTATE_MCP_PROFILE = $Profile
  $probe = @'
import('./dist/browser.js').then(async b => {
  try {
    const { status, title } = await b.fetchPage('https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1', 3500);
    console.log('WARM|' + status + '|' + title.slice(0, 50));
  } catch (e) { console.log('COLD|' + e.message.split('\n')[0].slice(0, 90)); }
  await b.closeContext();
});
'@
  $out = & node -e $probe 2>&1 | Select-String -Pattern '^(WARM|COLD)\|' | Select-Object -First 1
  if ($out -match '^WARM\|(\d+)\|(.*)$') { Write-Ok "profile warm (HTTP $($Matches[1])) - $($Matches[2])" }
  elseif ($out -match '^COLD\|(.*)$')    { Write-Warn2 "profile COLD: $($Matches[1])"; Write-Warn2 "run: node dist/cli.js setup" }
  else                                    { Write-Warn2 "probe inconclusive: $out" }
} finally { Pop-Location }

Write-Host ""
Write-Host ("-" * 46)
Write-Host "Done." -ForegroundColor White
Write-Host "  Changed existing tool behaviour?  Just make a tool call - the"
Write-Host "  server respawns automatically with the new code."
Write-Host "  ADDED or RENAMED a tool?          Restart Claude Code. The tool"
Write-Host "  list is negotiated once per session and is cached until then."
