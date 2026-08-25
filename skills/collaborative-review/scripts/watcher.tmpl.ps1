#Requires -Version 7
<#
================================================================================
 watcher.tmpl.ps1 — TEMPLATE for the collaborative-review watcher (do not run raw)
================================================================================
 Instantiate ONCE PER MACHINE, not per project: replace the placeholders below
 and save as "collaborative-review-watcher.ps1". The file name MUST contain
 "collaborative-review", because that string is the signature the PID check uses
 to recognize its own instance on the command line.

 Placeholders (all required; no value may contain a single quote):
   REGISTRY_PATH        -> the materials registry JSON (project/material -> folder)
   EDGE_FN_URL          -> base URL of the deployed server functions
   PASSWORD_PATH        -> local file holding the dashboard password. NEVER the
                           password inline: it must not reach a command line
   CLAUDE_ALLOWED_TOOLS -> value for --allowedTools on the headless run. Without a
                           pre-approved list, a headless run HANGS waiting for a
                           permission prompt nobody is there to answer
   PROTOCOL_PATH        -> the .md holding the correction engine protocol
   LOG_PATH             -> the watcher log

 Rules this script honors:

   - Its own PID file, checked by SIGNATURE on the command line. It NEVER kills a
     process, not by generic name and not by PID: if another instance is alive,
     this one simply EXITS. On a machine running several projects, killing by a
     generic script name terminates a neighbor's work silently.

   - Lock staleness: fresh (under 60 min) means a run is in progress, so skip the
     material and stay serial; old (60 min or more) means a previous run crashed,
     so remove it and WARN in the log.

   - APPROVED STRUCTURAL GATES take PRIORITY over new conclusions. A decision the
     owner already made should land before new work piles on top of it.

   - ALWAYS serial: ONE action per material per tick, either one approved
     structural gate or one new conclusion, oldest first. The rest wait for later
     ticks.

   - Silent when there is nothing new: an empty tick writes NO log line at all. A
     watcher that logs every ten minutes trains you to stop reading its log, and
     then you miss the line that mattered.

   - The password never appears in a log, a prompt, or a command line. It travels
     only in the request body, read from the file at the moment it is needed.

 Scheduling: every 10 to 15 minutes, with "start when available" so missed runs
 are recovered, "do not stop on idle end", "ignore new instances", allowed to run
 on battery, an execution time limit of 30 to 60 minutes, and set to run whether
 the user is logged on or not.

 The execution time limit is what kills a hung headless run. Any orphaned lock it
 leaves behind is cleaned by the staleness rule on the following tick.

 Server function prerequisite: it must accept a call authenticated only by the
 password in the body, meaning deployed with JWT verification off. The watcher
 does not send a project key.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Configuration (filled in when the template is instantiated)
# -----------------------------------------------------------------------------
$RegistryPath  = '{{REGISTRY_PATH}}'
$EdgeFnUrl     = '{{EDGE_FN_URL}}'
$PasswordPath     = '{{PASSWORD_PATH}}'
$AllowedTools  = '{{CLAUDE_ALLOWED_TOOLS}}'
$ProtocolPath = '{{PROTOCOL_PATH}}'
$LogPath       = '{{LOG_PATH}}'

# A NEW conclusion is an id whose latest ledger status is NOT in this list
# ('pending' and 'error' count as new on purpose: that is the retry mechanism).
$StatusEmCurso = @('applied', 'processing', 'awaiting-structural-approval')
# 250 min, to line up with the scheduled task's own 4h execution limit. This is
# only the fallback: the common crash case is caught far earlier, by the check
# for whether the lock's process is still alive.
$LockStaleMin  = 250

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
$dirLog = Split-Path -Parent $LogPath
if ($dirLog -and -not (Test-Path -LiteralPath $dirLog)) {
  New-Item -ItemType Directory -Path $dirLog -Force | Out-Null
}

function Write-Log {
  param([string]$Nivel, [string]$Mensagem)
  # Machine local time; Get-Date already returns it.
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $LogPath -Value "[$ts BRT] [$Nivel] $Mensagem" -Encoding utf8
}

# Defensive property read: rows coming from the backend function or from the
# ledger may be missing fields, and direct access would break the whole tick.
function Read-Prop {
  param($Objeto, [string]$Name)
  if ($null -eq $Objeto) { return $null }
  $p = $Objeto.PSObject.Properties[$Name]
  if ($p) { return $p.Value } else { return $null }
}

# A tick firing right after the machine wakes finds the network still coming up: the
# scheduler runs the missed tick immediately, Wi-Fi has not reconnected yet, and
# the call dies with "host not known". Measured, not guessed: cross-referencing
# watcher.log against the Kernel-Power events showed all 8 network errors landing
# between 3 and 51 seconds after wake, before DNS started answering again.
# The scheduler's "only if network available" does not cover this: as far as
# Windows is concerned the network is available the moment the adapter comes up.
#
# Only TRANSPORT failures are retried, recognized by TYPE rather than message: the text
# is localized and useless as a criterion. An inner socket error is what separates a
# network problem from an application one: an HTTP error derives from the same class
# but carries no socket inner, so without this a wrong password would retry 3 times.
function Invoke-WithNetworkRetry {
  param(
    [Parameter(Mandatory)][scriptblock]$Acao,
    [int]$Tentativas = 3,
    [int]$EsperaSeg = 8
  )
  for ($i = 1; $i -le $Tentativas; $i++) {
    try { return & $Acao }
    catch {
      $ehRede = $_.Exception.InnerException -is [System.Net.Sockets.SocketException]
      if (-not $ehRede -or $i -eq $Tentativas) { throw }
      Start-Sleep -Seconds ($EsperaSeg * $i)   # 8s, then 16s: covers Wi-Fi coming up
    }
  }
}

# -----------------------------------------------------------------------------
# Approval sync module, loaded tolerantly:
# a missing module NEVER takes the watcher down (the tick runs without sync, warns once).
# -----------------------------------------------------------------------------
$SyncModulo = Join-Path $PSScriptRoot 'sync-approvals.ps1'
if (Test-Path -LiteralPath $SyncModulo) {
  try { . $SyncModulo }
  catch { Write-Log 'WARN' "Approval sync module failed to load ($($_.Exception.Message)). Ticks continue without dashboard sync." }
}

# -----------------------------------------------------------------------------
# (a) Our own PID file, uniquely named. We never kill anyone: we check and leave
# -----------------------------------------------------------------------------
$PidFile = Join-Path $dirLog 'collaborative-review-watcher.pid'

if (Test-Path -LiteralPath $PidFile) {
  $pidAntigo = ((Get-Content -LiteralPath $PidFile -Raw -ErrorAction SilentlyContinue) ?? '').Trim()
  if ($pidAntigo -match '^\d+$') {
    $procAntigo = Get-CimInstance Win32_Process -Filter "ProcessId=$pidAntigo" -ErrorAction SilentlyContinue
    if ($procAntigo -and $procAntigo.CommandLine -like '*collaborative-review*') {
      # A previous instance is alive and really is the watcher (signature matches).
      # Clean exit, touching nothing. The scheduler already prevents overlap;
      # this is the seatbelt for manual triggers.
      Write-Log 'WARN' "A previous watcher instance is still alive (PID $pidAntigo). Exiting without doing anything."
      exit 0
    }
  }
  # Orphaned PID file (process died, PID recycled, or leftover):
  # takes over by overwriting the file. We NEVER kill the previous owner.
}
Set-Content -LiteralPath $PidFile -Value $PID -Encoding ascii

try {
  # ---------------------------------------------------------------------------
  # Preconditions (logged: this IS a problem, not an empty tick)
  # ---------------------------------------------------------------------------
  if (-not (Test-Path -LiteralPath $RegistryPath)) {
    Write-Log 'ERROR' "Materials registry file not found: $RegistryPath. The watcher cannot run."
    exit 1
  }

  try {
    $materiais = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
  }
  catch {
    Write-Log 'ERROR' "Materials registry is not valid JSON: $($_.Exception.Message)"
    exit 1
  }

  # An empty registry is a configuration state, not an error:
  # log ONE line and exit 0. Password and protocol are only required once there is a
  # material, so a fresh instance validates cleanly before the other pieces arrive.
  if ($null -eq $materiais -or @($materiais).Count -eq 0) {
    Write-Log 'INFO' 'Materials registry is empty, nothing to do.'
    exit 0
  }

  foreach ($par in @(
      @('dashboard password', $PasswordPath),
      @('protocolo do motor', $ProtocolPath))) {
    if (-not (Test-Path -LiteralPath $par[1])) {
      Write-Log 'ERROR' "File for $($par[0]) not found: $($par[1]). The watcher cannot run."
      exit 1
    }
  }

  $senha = (Get-Content -LiteralPath $PasswordPath -Raw).Trim()

  # ---------------------------------------------------------------------------
  # Walk the registered materials
  # ---------------------------------------------------------------------------
  foreach ($m in @($materiais)) {
    try {
      $obrigatorios = @('project', 'material', 'projectFolder', 'htmlFile', 'publishCommand', 'branch')
      $semCampo = @($obrigatorios | Where-Object { [string]::IsNullOrWhiteSpace([string](Read-Prop $m $_)) })
      if ($semCampo.Count -gt 0) {
        Write-Log 'ERROR' "Registry entry is missing required field(s): $($semCampo -join ', '). Skipping this entry."
        continue
      }

      $orq  = Join-Path $m.projectFolder 'docs/orchestration'
      $lock = Join-Path $orq 'lock'

      # -----------------------------------------------------------------------
      # (b) Lock: fresh means a run is in progress (skip, stay serial);
      #           old = stale (remove it with a warning and carry on)
      # -----------------------------------------------------------------------
      if (Test-Path -LiteralPath $lock) {
        $idadeMin = ((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalMinutes
        # A LIVE lock process means the engine is working, however old the lock is: skip.
        # PID MORTO = crash confirmado: destrava ja, sem esperar staleness
        # (bug real 10/07/2026: ExecutionTimeLimit de 1h matava motor legitimo
        # e o material ficava 60 min travado ate o lock "envelhecer").
        $pidVivo = $false
        try {
          $lockPid = (Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).pid
          if ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) { $pidVivo = $true }
        } catch {}
        if ($pidVivo) { continue }
        if ($pidVivo -eq $false -and $idadeMin -lt 2) { continue } # just created: leave room for the process to start
        if ($pidVivo -eq $false -and $idadeMin -ge 2) {
          Write-Log 'WARN' "Lock process is dead (age $([math]::Round($idadeMin)) min) - releasing without waiting for the staleness window."
        } elseif ($idadeMin -lt $LockStaleMin) { continue }
        # Antes de remover o lock velho, DESTRAVA tambem o ledger: run morta por
        # a hard kill leaves the last status as processing, which reads as in-flight
        # - without the error line, that conclusion would never be retried
        # (furo real encontrado no teste ponta a ponta de 08/07/2026).
        $lockInfo = $null
        try { $lockInfo = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json } catch {}
        $idCrash = if ($lockInfo) { Read-Prop $lockInfo 'conclusion_id' } else { $null }
        Remove-Item -LiteralPath $lock -Force
        Write-Log 'WARN' "Stale lock ($([math]::Round($idadeMin)) min) removed at $lock. Most likely a previous run crashed."
        if ($null -ne $idCrash) {
          $ledgerCrash = Join-Path $orq 'ledger.jsonl'
          @{
            conclusion_id = $idCrash; project = $m.project; material = $m.material
            status = 'error'; erro = "lock stale ($([math]::Round($idadeMin)) min) - crash presumido; retry"
            ts = (Get-Date -Format o)
          } | ConvertTo-Json -Compress | Add-Content -LiteralPath $ledgerCrash -Encoding utf8
          Write-Log 'WARN' "Conclusion #$idCrash released in the ledger (error status). Eligible for retry."
        }
      }

      # -----------------------------------------------------------------------
      # (b1.5) Sync dashboard approvals: stamp the gates BEFORE the scan below, so a
      # verdict given in the dashboard becomes an applied change in the SAME
      # tick. A failure here never sinks the tick: sync warns and the loop continues.
      # -----------------------------------------------------------------------
      if (Get-Command Sync-Approvals -ErrorAction SilentlyContinue) {
        try {
          $aprovacoesUrl = $EdgeFnUrl -replace 'read-feedback', 'approvals'
          $sync = Sync-Approvals -ApprovalsUrl $aprovacoesUrl -Password $senha `
            -Project $m.project -Material $m.material -OrqDir $orq `
            -Log ${function:Write-Log}
          if ($sync.downloaded -gt 0) {
            Write-Log 'INFO' "Dashboard sync in $($m.project)/$($m.material): $($sync.downloaded) verdict(s) downloaded, $($sync.stamped) approved, $($sync.rejected) rejected, $($sync.gatesApproved) gate(s) released, $($sync.gatesRejected) closed, $($sync.errors) error(s)."
          }
        }
        catch {
          Write-Log 'WARN' "Sync painel falhou em $($m.project)/$($m.material): $($_.Exception.Message) — tique segue sem sync."
        }
      }

      # -----------------------------------------------------------------------
      # (b2) APPROVED STRUCTURAL GATES take priority over new conclusions.
      #      Eligible means marked approved and not yet marked applied.
      #      The engine marks it applied on completion, so a gate that fails
      #      stays eligible and retries on the next tick.
      # -----------------------------------------------------------------------
      $dirGates     = Join-Path $orq 'structural-gate'
      $gateAprovado = $null
      if (Test-Path -LiteralPath $dirGates) {
        # Oldest first (the name carries reviewer and timestamp as a stable tiebreak)
        $candidatos = @(Get-ChildItem -LiteralPath $dirGates -Filter '*.md' -File -ErrorAction SilentlyContinue |
          Sort-Object CreationTime, Name)
        foreach ($g in $candidatos) {
          $conteudo = Get-Content -LiteralPath $g.FullName -Raw -ErrorAction SilentlyContinue
          if ([string]::IsNullOrWhiteSpace($conteudo)) { continue }
          # Front matter: the block between the first two '---' at the top of the file
          if ($conteudo -notmatch '(?s)\A---\s*\r?\n(.*?)\r?\n---') { continue }
          $fm       = $Matches[1]
          # A space/tab class on purpose: a generic whitespace class matches newlines
          # an EMPTY applied-at field swallow the next line and look filled in.
          $aprovado = $fm -match '(?im)^[ \t]*status[ \t]*:[ \t]*["'']?approved["'']?[ \t]*\r?$'
          $aplicado = $fm -match '(?im)^[ \t]*applied_at[ \t]*:[ \t]*\S'
          if ($aprovado -and -not $aplicado) { $gateAprovado = $g; break }
        }
      }

      if ($gateAprovado) {
        # Same mechanism as a conclusion: lock, headless run, safety net.
        New-Item -ItemType Directory -Path $orq -Force | Out-Null
        $agora = Get-Date -Format o
        @{ pid = $PID; gate = $gateAprovado.FullName; created_at = $agora } | ConvertTo-Json -Compress |
          Set-Content -LiteralPath $lock -Encoding utf8

        try {
          $ledger   = Join-Path $orq 'ledger.jsonl'
          $contexto = [ordered]@{
            modo            = 'structural-approved'
            gatePath        = $gateAprovado.FullName
            project         = $m.project
            material        = $m.material
            projectFolder    = $m.projectFolder
            htmlFile     = $m.htmlFile
            publishCommand = $m.publishCommand
            branch          = $m.branch
            edgeFnUrl       = $EdgeFnUrl
            passwordPath       = $PasswordPath   # the engine reads the password FROM THIS FILE; it never enters the prompt
            ledgerPath      = $ledger
            lockPath        = $lock
          } | ConvertTo-Json -Compress

          # The context goes in a FILE, and the prompt carries no quotes and no
          # accents. The globally installed claude is a .cmd shim, and cmd.exe
          # re-splits double quotes inside an argument: a real bug on 08/07/2026,
          # where a --prod flag from inside a publish command leaked out and became
          # a CLI flag of its own. Accents can be mangled by the cmd code page too.
          $ctxFile = Join-Path $orq 'contexto-gate.json'
          $contexto | Set-Content -LiteralPath $ctxFile -Encoding utf8
          $prompt = "You are the collaborative-review correction engine. MODE: structural-approved. Read the protocol at '$ProtocolPath' and follow that mode's section EXACTLY: apply ONLY the approved gate named in the context, re-reading the CURRENT state of the file and reconciling with what was already applied, and when finished fill in the 'applied_at:' field in the gate front matter. The context for this run, including the gate path, is in the file '$ctxFile' - read it BEFORE you start."

          $runLog = Join-Path $orq ("claude-run-gate-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
          Write-Log 'INFO' "APPROVED structural gate '$($gateAprovado.Name)' in $($m.project)/$($m.material). Invoking the engine in structural-approved mode (output: $runLog)."

          & claude -p $prompt --allowedTools $AllowedTools *>> $runLog
          $codigo = $LASTEXITCODE

          if ($codigo -eq 0) {
            # Marking it applied is the ENGINE's job; if it did not, the gate
            # becomes eligible again on the next tick (retry).
            Write-Log 'INFO' "claude -p finished OK for gate '$($gateAprovado.Name)'."
          }
          else {
            # Fonte da verdade = o proprio gate (applied_at), nao o exit code
            # (a headless run can exit non-zero even after finishing successfully).
            $gateDepois = Get-Content -LiteralPath $gateAprovado.FullName -Raw -ErrorAction SilentlyContinue
            if ($gateDepois -match '(?m)^applied_at:[ 	]*\S') {
              Write-Log 'WARN' "The engine exited with code $codigo, BUT the gate is marked applied. It finished; ignoring the exit code."
            }
            else {
              Write-Log 'ERROR' "The engine exited with code $codigo for that gate. The gate stays eligible and will be retried next tick."
            }
          }
        }
        finally {
          if (Test-Path -LiteralPath $lock) {
            Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
          }
        }

        continue   # ONE action per material per tick: the gate consumed this one
      }

      # -----------------------------------------------------------------------
      # (c) New conclusions: server function (filtered by scope) versus the ledger
      # -----------------------------------------------------------------------
      $corpo = @{ password = $senha; project = $m.project; material = $m.material } | ConvertTo-Json -Compress
      $resposta = Invoke-WithNetworkRetry {
        Invoke-RestMethod -Uri $EdgeFnUrl -Method Post -ContentType 'application/json' -Body $corpo -TimeoutSec 60
      }

      $linhas = if ($resposta -is [System.Array]) { $resposta }
                elseif ($null -ne (Read-Prop $resposta 'feedbacks')) { @($resposta.feedbacks) }
                else { @() }

      $conclusoes = @($linhas | Where-Object {
        ((Read-Prop $_ 'type') -eq 'conclusion') -and ($null -ne (Read-Prop $_ 'id'))
      })
      if ($conclusoes.Count -eq 0) { continue }   # nothing to do: stay silent

      # Local ledger: append-only journal; the LAST line for each id wins.
      $ledger = Join-Path $orq 'ledger.jsonl'
      $statusPorId = @{}
      if (Test-Path -LiteralPath $ledger) {
        foreach ($linha in (Get-Content -LiteralPath $ledger)) {
          if ([string]::IsNullOrWhiteSpace($linha)) { continue }
          try { $reg = $linha | ConvertFrom-Json } catch { continue }
          $idReg = Read-Prop $reg 'conclusion_id'
          if ($null -ne $idReg) { $statusPorId["$idReg"] = [string](Read-Prop $reg 'status') }
        }
      }

      $novas = @($conclusoes |
        Where-Object { $statusPorId["$(Read-Prop $_ 'id')"] -notin $StatusEmCurso } |
        Sort-Object { [string](Read-Prop $_ 'created_at') })
      if ($novas.Count -eq 0) { continue }        # all handled already: stay silent

      # -----------------------------------------------------------------------
      # (d) Process ONLY the oldest. Lock, ledger, headless run
      # -----------------------------------------------------------------------
      $alvo    = $novas[0]
      $idAlvo  = Read-Prop $alvo 'id'
      $revisor = [string](Read-Prop $alvo 'reviewer_name')

      New-Item -ItemType Directory -Path $orq -Force | Out-Null
      $agora = Get-Date -Format o
      @{ pid = $PID; conclusion_id = $idAlvo; created_at = $agora } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $lock -Encoding utf8

      try {
        @{
          conclusion_id = $idAlvo; revisor = $revisor
          project = $m.project; material = $m.material
          status = 'pending'; ts = $agora
        } | ConvertTo-Json -Compress | Add-Content -LiteralPath $ledger -Encoding utf8

        $contexto = [ordered]@{
          conclusion_id    = $idAlvo
          revisor         = $revisor
          project         = $m.project
          material        = $m.material
          projectFolder    = $m.projectFolder
          htmlFile     = $m.htmlFile
          publishCommand = $m.publishCommand
          branch          = $m.branch
          edgeFnUrl       = $EdgeFnUrl
          passwordPath       = $PasswordPath   # the engine reads the password FROM THIS FILE; it never enters the prompt
          ledgerPath      = $ledger
          lockPath        = $lock
        } | ConvertTo-Json -Compress

        # The context goes to a FILE and the prompt carries only paths, with no
        # double quotes: the globally installed claude is a .cmd shim, and cmd.exe
        # re-splits double quotes inside an argument (real bug, 08/07/2026: a flag
        # inside a publish command leaked into the CLI call). For the same reason
        # the prompt avoids accents, which the cmd code page can mangle.
        $ctxFile = Join-Path $orq 'contexto-run.json'
        $contexto | Set-Content -LiteralPath $ctxFile -Encoding utf8
        $prompt = "You are the collaborative-review correction engine. Read the protocol at '$ProtocolPath' and follow its 11 steps EXACTLY. The context for this run is in the file '$ctxFile' - read it BEFORE you start."

        $runLog = Join-Path $orq ("claude-run-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")
        Write-Log 'INFO' "New conclusion #$idAlvo from '$revisor' in $($m.project)/$($m.material). Invoking the engine (output: $runLog)."

        # SYNCHRONOUS call: the watcher waits. What cuts a hang is the scheduled
        # task's own execution time limit, backed by the lock going stale on a
        # later tick. --allowedTools carries the pre-approved list; without it a
        # headless run hangs on a permission prompt nobody will ever answer.
        & claude -p $prompt --allowedTools $AllowedTools *>> $runLog
        $codigo = $LASTEXITCODE

        if ($codigo -eq 0) {
          # Status final ('applied', 'awaiting-structural-approval' etc.)
          # is the ENGINE's job; it writes to the ledger as it works.
          Write-Log 'INFO' "The engine finished successfully for conclusion #$idAlvo."
        }
        else {
          # Before recording an error, check the LEDGER: the engine writes its status
          # final durante os 11 passos, e o codigo de saida do claude pode vir
          # exit 1 EVEN when the run finished completely (real case, 08/07/2026:
          # status 'applied' at 21:53, exit 1 at 21:56 - which would have become an
          # endless retry, once per tick). The ledger is the source of truth here;
          # the exit code is only a hint.
          $ultimoStatus = $null
          try {
            $ultimaLinha = Get-Content -LiteralPath $ledger -ErrorAction SilentlyContinue |
              Where-Object { $_ -match ('"conclusion_id":\s*' + $idAlvo + '\b') } | Select-Object -Last 1
            if ($ultimaLinha) { $ultimoStatus = (ConvertFrom-Json $ultimaLinha).status }
          } catch {}
          if ($ultimoStatus -in @('applied', 'awaiting-structural-approval')) {
            Write-Log 'WARN' "The engine exited with code $codigo, BUT the ledger shows it completed. Ignoring the exit code."
          }
          else {
            Write-Log 'ERROR' "The engine exited with code $codigo for conclusion #$idAlvo. An error line was written to the ledger; it will be retried next tick."
            @{
              conclusion_id = $idAlvo; revisor = $revisor
              project = $m.project; material = $m.material
              status = 'error'; erro = "claude -p exit $codigo"; ts = (Get-Date -Format o)
            } | ConvertTo-Json -Compress | Add-Content -LiteralPath $ledger -Encoding utf8
          }
        }
      }
      finally {
        # The engine releases the lock at the end; this is the safety net that
        # guarantees no orphaned lock survives a run the watcher started.
        if (Test-Path -LiteralPath $lock) {
          Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
        }
      }
    }
    catch {
      $rotulo = "$(Read-Prop $m 'project')/$(Read-Prop $m 'material')"
      Write-Log 'ERROR' "Falha no material ${rotulo}: $($_.Exception.Message)"
      # move on to the next material: one bad material does not block the others
    }
  }
}
finally {
  # Remove the PID file ONLY if it is still ours (another instance may have taken over)
  # after a crash and restart. Never delete somebody else's file.
  try {
    if ((Test-Path -LiteralPath $PidFile) -and (((Get-Content -LiteralPath $PidFile -Raw).Trim()) -eq "$PID")) {
      Remove-Item -LiteralPath $PidFile -Force
    }
  }
  catch { }
}
