# ============================================================================
# sync-approvals.ps1 - watcher module (collaborative-review skill)
#
# WHAT IT DOES: downloads from the `approvals` backend function the verdicts the
# owner gave in the dashboard (approve or reject per item, with a possibly edited
# request) and STAMPS the matching gate files. The gate file remains the source of
# truth. This module only carries the mail from the database to disk.
#
# CALLED BY: the watcher, at the start of processing each material, BEFORE the
# approved-gate scan, so a verdict that just arrived is applied in the SAME tick.
# Dot-source the file, then call Sync-Approvals.
#
# HARD RULES (do not relax; this is a security-relevant piece):
#   1. The gate file field is a FILE NAME ONLY, revalidated here with a pattern
#      even though the server and database already validated it (defense in depth).
#      No slash, backslash, or dot-dot: it must be impossible to point outside
#      docs/orchestration/structural-gate/.
#   2. A gate only moves from pending to approved or rejected. A status already
#      decided is never downgraded or re-decided here.
#   3. APPROVED only when EVERY remaining item in the body carries a verdict.
#      An item with no verdict holds the gate pending: never apply something the
#      owner did not decide on.
#   4. A REJECTED item leaves the gate body, so the engine applies only what
#      stays, and is copied to the mirror file <gate>.rejected.md for audit.
#   5. Idempotence by marker: each approval stamps a comment into the item, so
#      re-running with the same approval changes nothing.
#   6. A network or API failure NEVER sinks the tick: it logs and returns.
#   7. Atomic write: temp file plus forced move, so a gate is never half-written.
#
# CLOSED-WORLD TESTING: -InjectedApprovals replaces the network call with
# supplied data, so the suite runs with no backend. See sync-approvals.test.ps1.
# ============================================================================

Set-StrictMode -Version Latest

# Anchored at the true end of the string rather than end of line. With the
# end-of-line anchor, a trailing newline would slip through - looser than the
# server's own regex and than the database CHECK. All three layers must refuse
# exactly the same names, or the strictest one is the only one that matters.
$script:GateFileRegex = '^[a-z0-9][a-z0-9-]*\.md\z'

function Test-GateFile {
  # A legitimate gate file name? (defense in depth, hard rule 1)
  param([AllowNull()] [AllowEmptyString()] [string]$Name)
  if ([string]::IsNullOrEmpty($Name)) { return $false }
  if ($Name.Length -gt 120) { return $false }
  # Case-sensitive on purpose: the Windows filesystem is not, and the stricter
  return $Name -cmatch $script:GateFileRegex
}

function ConvertTo-SafeLogText {
  # Untrusted values from the database may contain line breaks or terminal escape
  # sequences that would forge lines in the log. Collapse controls and truncate.
  param([AllowNull()] $Value)
  $s = [string]$Value
  if ([string]::IsNullOrEmpty($s)) { return $s }
  $s = [regex]::Replace($s, '[\x00-\x1f\x7f]', ' ')
  if ($s.Length -gt 120) { $s = $s.Substring(0, 120) + '…' }
  return $s
}

function ConvertTo-ItemNumber {
  # The item number from the database may be corrupt. Parse explicitly in range
  # 1 to 99: an invalid value returns null and the caller drains it, never guesses.
  # Parsing explicitly keeps a corrupt value from throwing and taking the
  # whole material's batch down with it.
  param([AllowNull()] $Value)
  [int]$n = 0
  if (-not [int]::TryParse([string]$Value, [ref]$n)) { return $null }
  if ($n -lt 1 -or $n -gt 99) { return $null }
  return $n
}

function Protect-EditedProposal {
  # The owner's edited proposal goes into the gate body. Whoever holds the password
  # can already send arbitrary instructions to the engine (that is the design), but
  # must NOT be able to forge STRUCTURE that breaks the engine's own invariants:
  #   - a fake "## Item N" heading, which becomes a phantom item in the count
  #     and in the engine
  #   - a fake approval marker, which would break idempotence and counting
  #   - "---" at the start of a line (a block boundary)
  # Hardening: escape the opening of HTML comments and emit the text as a QUOTE
  # (every line prefixed), which can never become a heading, rule, or comment.
  # The content stays readable and intact; it only loses the power to become
  # block structure.
  param([AllowNull()] [AllowEmptyString()] [string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return @() }
  $limpo = $Text -replace '<!--', '&lt;!--' -replace '-->', '--&gt;'
  $lines = $limpo -split "`r?`n"
  return @($lines | ForEach-Object { '> ' + $_ })
}

function Invoke-ApprovalsApi {
  param(
    [Parameter(Mandatory)] [string]$Url,
    [Parameter(Mandatory)] [hashtable]$Body
  )
  # The password goes ONLY in the request body, never in a URL or a log. Short
  # timeout: the watcher must not hang a tick waiting on the API.
  $json = $Body | ConvertTo-Json -Depth 5
  return Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' `
    -Body $json -TimeoutSec 30
}

function Get-ItemSection {
  # Locates one item's block inside the gate body.
  # Returns start and end LINE indices (end exclusive), or null.
  param(
    # A blank line is legitimate gate content
    [Parameter(Mandatory)] [AllowEmptyString()] [string[]]$Linhas,
    [Parameter(Mandatory)] [int]$ItemNumero
  )
  $start = -1
  # Accepts the item heading with or without a title
  $pattern = "^##[ \t]+Item[ \t]+$ItemNumero([ \t]|$|[—–-])"
  for ($i = 0; $i -lt $Linhas.Count; $i++) {
    if ($Linhas[$i] -match $pattern) { $start = $i; break }
  }
  if ($start -lt 0) { return $null }
  $end = $Linhas.Count
  for ($j = $start + 1; $j -lt $Linhas.Count; $j++) {
    if ($Linhas[$j] -match '^##[ \t]') { $end = $j; break }
  }
  return @{ Start = $start; End = $end }
}

function Sync-Approvals {
  param(
    [Parameter(Mandatory)] [string]$ApprovalsUrl,
    [Parameter(Mandatory)] [string]$Password,
    [Parameter(Mandatory)] [string]$Project,
    [Parameter(Mandatory)] [string]$Material,
    [Parameter(Mandatory)] [string]$OrqDir,
    [scriptblock]$Log = { param($nivel, $msg) Write-Host "[$nivel] $msg" },
    [object[]]$InjectedApprovals = $null   # TESTING: stands in for the network
  )

  $summary = [ordered]@{
    downloaded = 0; stamped = 0; rejected = 0; drained = 0
    gatesApproved = 0; gatesRejected = 0; errors = 0; markIds = @()
  }
  $testMode = ($null -ne $InjectedApprovals)

  # --- 1. Fetch pending approvals (or use the ones injected by the test) ----
  $approvals = @()
  if ($testMode) {
    $approvals = @($InjectedApprovals)
  }
  else {
    try {
      $resp = Invoke-ApprovalsApi -Url $ApprovalsUrl -Body @{
        password = $Password; action = 'list'; project = $Project; material = $Material
      }
      if (-not $resp.ok) { throw "response did not carry ok=true" }
      $approvals = @($resp.approvals)
    }
    catch {
      & $Log 'WARN' "Approval sync: API unavailable ($($_.Exception.Message)). Continuing without sync this tick."
      return [pscustomobject]$summary
    }
  }
  $summary.downloaded = $approvals.Count
  if ($approvals.Count -eq 0) { return [pscustomobject]$summary }

  $gatesDir    = Join-Path $OrqDir 'structural-gate'
  $localLedger = Join-Path $OrqDir 'approvals-processadas.jsonl'
  $now       = Get-Date -Format o

  # Local ledger (an extra belt beyond the database's own processed flag)
  $alreadyProcessed = @{}
  if (Test-Path -LiteralPath $localLedger) {
    foreach ($linha in (Get-Content -LiteralPath $localLedger -ErrorAction SilentlyContinue)) {
      try { $j = $linha | ConvertFrom-Json; $alreadyProcessed["$($j.id)"] = $true } catch {}
    }
  }

  function Registrar-Processed($ap, $result) {
    @{
      id = $ap.id; gate = $ap.gate_file; item = $ap.item_number
      verdict = $ap.verdict; result = $result; ts = $now
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $localLedger -Encoding utf8
  }

  # --- 2. Processar gate a gate (grouped; items em ordem) ------------------
  $porGate = $approvals | Group-Object -Property gate_file
  foreach ($grupo in $porGate) {
    $gateName = [string]$grupo.Name

    # Regra dura 1: revalidate o name (defesa em depth; Test-GateFile
    # anchored at true end of string and case-sensitive: the stricter layer wins).
    if (-not (Test-GateFile $gateName)) {
      & $Log 'ERROR' "Sync: invalid gate file name from the database ('$(ConvertTo-SafeLogText $gateName)'). Refused."
      foreach ($ap in $grupo.Group) {
        Registrar-Processed $ap 'invalido-drained'
        $summary.markIds += $ap.id; $summary.drained++
      }
      $summary.errors++
      continue
    }

    $gatePath = Join-Path $gatesDir $gateName
    if (-not (Test-Path -LiteralPath $gatePath)) {
      # A real anomaly (the gate is created BEFORE the dashboard decision): it stays
      # pending in the database and visible in the log, which beats a badge that lies.
      & $Log 'ERROR' "Sync: gate '$gateName' does not exist in $gatesDir. Its approvals stay pending."
      $summary.errors++
      continue
    }

    $conteudo = Get-Content -LiteralPath $gatePath -Raw
    if ($conteudo -notmatch '(?s)\A---\s*\r?\n(.*?)\r?\n---') {
      & $Log 'ERROR' "Sync: gate '$gateName' has no front matter - skipping."
      $summary.errors++
      continue
    }
    $fm = $Matches[1]
    $statusPendente = $fm -match '(?im)^[ \t]*status[ \t]*:[ \t]*["'']?pending["'']?[ \t]*\r?$'

    # Hard rule 2, reinforced: sync only stamps a PENDING gate. If the status is
    # already approved or rejected (even with the engine not yet run), the gate is
    # DECIDED, and stamping here would mutate a body that was already settled.
    # already decided by the owner. Drain the late approval without touching anything.
    if (-not $statusPendente) {
      & $Log 'WARN' "Sync: gate '$gateName' is not pending (already decided). Draining the approval."
      foreach ($ap in $grupo.Group) {
        Registrar-Processed $ap 'gate-not-pending'
        $summary.markIds += $ap.id; $summary.drained++
      }
      continue
    }

    $lines = $conteudo -split "`r?`n"
    $mudou  = $false

    foreach ($ap in ($grupo.Group | Sort-Object item_number)) {
      # Idempotence (hard rule 5): ONLY the local ledger decides what was processed.
      # We do NOT match the marker in the body: that was forgeable, and it could cause
      # an injected marker carrying a FUTURE id would make the count believe an item
      # a legitimate approval to be drained without being applied. The ledger is the
      # immune source: the watcher only writes there what it truly processed.
      if ($alreadyProcessed.ContainsKey("$($ap.id)")) {
        Registrar-Processed $ap 'ja-stamped'
        $summary.markIds += $ap.id; $summary.drained++
        continue
      }
      if ($ap.verdict -ne 'approved' -and $ap.verdict -ne 'rejected') {
        & $Log 'ERROR' "Sync: unknown verdict '$(ConvertTo-SafeLogText $ap.verdict)'. Approval refused."
        Registrar-Processed $ap 'invalid-verdict'
        $summary.markIds += $ap.id; $summary.drained++; $summary.errors++
        continue
      }

      # Defensive parse of the item number: never let a cast blow up the batch
      $itemN = ConvertTo-ItemNumber (Read-ApprovalProp $ap 'item_number')
      if ($null -eq $itemN) {
        & $Log 'ERROR' "Sync: invalid item number. Approval refused."
        Registrar-Processed $ap 'item-numero-invalido'
        $summary.markIds += $ap.id; $summary.drained++; $summary.errors++
        continue
      }

      $secao = Get-ItemSection -Linhas $lines -ItemNumero $itemN
      if ($null -eq $secao) {
        & $Log 'ERROR' "Sync: item $itemN not found in gate '$gateName'. That approval stays pending."
        $summary.errors++
        continue
      }

      if ($ap.verdict -eq 'rejected') {
        # Regra dura 4: rejected SAI do body (motor aplica o que fica) e
        # goes to the audit mirror file.
        $bloco = $lines[$secao.Start..($secao.End - 1)] -join "`n"
        $mirrorFile = Join-Path $gatesDir ($gateName -replace '\.md\z', '.rejected.md')
        $cab = ""
        if (-not (Test-Path -LiteralPath $mirrorFile)) {
          $cab = "# Items rejected via the dashboard - $gateName`n`n> Audit trail: the gate body keeps only what was approved.`n"
        }
        ($cab + "`n---`n<!-- approval:$($ap.id) verdict:rejected ts:$now -->`n" + $bloco + "`n") |
          Add-Content -LiteralPath $mirrorFile -Encoding utf8
        $resto = @()
        if ($secao.Start -gt 0) { $resto += $lines[0..($secao.Start - 1)] }
        $resto += "<!-- item $itemN rejected in the dashboard · approval:$($ap.id) ts:$now -->"
        if ($secao.End -lt $lines.Count) { $resto += $lines[$secao.End..($lines.Count - 1)] }
        $lines = $resto
        $summary.rejected++
      }
      else {
        # Approved: a CANONICAL stamp on the line right after the item heading, plus
        # the edited proposal, hardened. The marker only counts in that fixed
        # position, so a forged marker in the middle of the text is not counted
        # as a stamped item.
        $marcador = "<!-- approval:$($ap.id) verdict:approved ts:$now -->"
        $rawEditedRequest = [string](Read-ApprovalProp $ap 'edited_request')
        $hasEdit = -not [string]::IsNullOrWhiteSpace($rawEditedRequest)
        $bloco = @($lines[$secao.Start..($secao.End - 1)])
        $novoBloco = @($bloco[0], $marcador)   # heading, then marker (canonical)
        if ($hasEdit) {
          $idxProp = -1
          for ($k = 1; $k -lt $bloco.Count; $k++) {
            if ($bloco[$k] -match '^\*\*Proposal if approved') { $idxProp = $k; break }
          }
          $edit = @('**Proposal if approved (edited by the owner in the dashboard, approval ' + $ap.id + '):**')
          $edit += Protect-EditedProposal $rawEditedRequest
          if ($idxProp -ge 1) {
            # Keep what comes before the proposal; the edited proposal closes the item.
            if ($idxProp -gt 1) { $novoBloco += $bloco[1..($idxProp - 1)] }
            $novoBloco += $edit
          }
          else {
            if ($bloco.Count -gt 1) { $novoBloco += $bloco[1..($bloco.Count - 1)] }
            $novoBloco += $edit
          }
        }
        else {
          if ($bloco.Count -gt 1) { $novoBloco += $bloco[1..($bloco.Count - 1)] }
        }
        $resto = @()
        if ($secao.Start -gt 0) { $resto += $lines[0..($secao.Start - 1)] }
        $resto += $novoBloco
        if ($secao.End -lt $lines.Count) { $resto += $lines[$secao.End..($lines.Count - 1)] }
        $lines = $resto
        $summary.stamped++
      }

      $conteudo = $lines -join "`n"
      $mudou = $true
      Registrar-Processed $ap $ap.verdict
      $summary.markIds += $ap.id
    }

    if (-not $mudou) { continue }

    # --- 3. Decidir o status do gate (regras duras 2 e 3) -------------------
    # A stamp only COUNTS in the CANONICAL position: the line IMMEDIATELY after
    # the item heading, which is where sync itself writes it. A marker forged in
    # the middle of the text does NOT count, so nobody can fabricate
    # "everything decided" or smuggle in a phantom item.
    $itensRestantes = 0; $itensCarimbados = 0
    $linhasAtuais = $conteudo -split "`r?`n"
    for ($i = 0; $i -lt $linhasAtuais.Count; $i++) {
      if ($linhasAtuais[$i] -match '^##[ \t]+Item[ \t]+\d+') {
        $itensRestantes++
        $proxima = if (($i + 1) -lt $linhasAtuais.Count) { $linhasAtuais[$i + 1] } else { '' }
        if ($proxima -match '^<!-- approval:\d+ verdict:approved\b') { $itensCarimbados++ }
      }
    }

    if ($statusPendente) {
      if ($itensRestantes -eq 0) {
        # Everything rejected: close the gate right here, nothing to apply.
        $conteudo = $conteudo -replace '(?im)^([ \t]*status[ \t]*:[ \t]*)["'']?pending["'']?[ \t]*\r?$', "`$1rejected"
        $conteudo = $conteudo -replace '(?im)^([ \t]*applied_at[ \t]*:)[ \t]*\r?$', "`$1 $now (rejected in the dashboard — nada applied)"
        $summary.gatesRejected++
        & $Log 'INFO' "Sync: gate '$gateName' rejected por whole via painel — finished sem aplicar."
        # Close the ledger for the originating conclusion (same semantics as the engine)
        $condId = $null
        if ($fm -match '(?im)^[ \t]*conclusion_id[ \t]*:[ \t]*(\d+)') { $condId = [int]$Matches[1] }
        if ($null -ne $condId) {
          @{
            conclusion_id = $condId; project = $Project; material = $Material
            status = 'applied'; error = $null; ts = $now
            nota = "gate '$gateName' rejected por whole via painel - nada applied"
          } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $OrqDir 'ledger.jsonl') -Encoding utf8
        }
      }
      elseif ($itensCarimbados -eq $itensRestantes) {
        # Hard rule 3: EVERY remaining item has a verdict, so release the engine.
        $conteudo = $conteudo -replace '(?im)^([ \t]*status[ \t]*:[ \t]*)["'']?pending["'']?[ \t]*\r?$', "`$1approved"
        $summary.gatesApproved++
        & $Log 'INFO' "Sync: gate '$gateName' has every item decided - status: approved (the engine picks it up this tick)."
      }
      else {
        & $Log 'INFO' "Sync: gate '$gateName' has a partial verdict ($itensCarimbados/$itensRestantes). Waiting for the rest."
      }
    }

    # --- 4. Atomic write (hard rule 7) --------------------------------------
    $tmp = "$gatePath.tmp-sync"
    Set-Content -LiteralPath $tmp -Value $conteudo -Encoding utf8 -NoNewline
    Move-Item -LiteralPath $tmp -Destination $gatePath -Force
  }

  # --- 5. Confirm in the database, outside test mode only -----------------
  # The mark action accepts at most 100 ids per call; a tick with more approvals
  # would fail ENTIRELY, marking none and re-downloading every tick.
  # Split into batches of 100. A failed batch does not block the others, since
  # the local ledger already guarantees idempotence.
  if (-not $testMode) {
    $idsUnicos = @($summary.markIds | Select-Object -Unique)
    for ($ini = 0; $ini -lt $idsUnicos.Count; $ini += 100) {
      $end = [Math]::Min($ini + 99, $idsUnicos.Count - 1)
      $lote = @($idsUnicos[$ini..$end])
      try {
        $r = Invoke-ApprovalsApi -Url $ApprovalsUrl -Body @{
          password = $Password; action = 'mark'; ids = $lote
        }
        if (-not $r.ok) { throw "resposta sem ok=true" }
      }
      catch {
        # The local ledger holds idempotence; the next tick re-marks.
        & $Log 'WARN' "Sync: failed to mark approvals as processed ($($_.Exception.Message)). The local ledger prevents reapplying; the next tick retries."
      }
    }
  }

  return [pscustomobject]$summary
}

function Read-ApprovalProp {
  # Leitura tolerante de property (objeto de API ou hashtable de teste)
  param($obj, [string]$nome)
  if ($obj -is [hashtable]) { return $obj[$nome] }
  $p = $obj.PSObject.Properties[$nome]
  if ($null -ne $p) { return $p.Value }
  return $null
}
