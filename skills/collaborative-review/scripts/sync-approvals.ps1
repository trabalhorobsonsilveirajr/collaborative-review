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
# CLOSED-WORLD TESTING: -AprovacoesInjetadas replaces the network call with
# supplied data, so the suite runs with no backend. See sync-approvals.test.ps1.
# ============================================================================

Set-StrictMode -Version Latest

# Anchored at the true end of the string rather than end of line. With the
# end-of-line anchor, a trailing newline would slip through - looser than the
# server's own regex and than the database CHECK. All three layers must refuse
# exactly the same names, or the strictest one is the only one that matters.
$script:GateArquivoRegex = '^[a-z0-9][a-z0-9-]*\.md\z'

function Test-GateFile {
  # A legitimate gate file name? (defense in depth, hard rule 1)
  param([AllowNull()] [AllowEmptyString()] [string]$Name)
  if ([string]::IsNullOrEmpty($Name)) { return $false }
  if ($Name.Length -gt 120) { return $false }
  # Case-sensitive on purpose: the Windows filesystem is not, and the stricter
  return $Name -cmatch $script:GateArquivoRegex
}

function ConvertTo-SafeLogText {
  # Untrusted values from the database may contain line breaks or terminal escape
  # sequences that would forge lines in the log. Collapse controls and truncate.
  param([AllowNull()] $Valor)
  $s = [string]$Valor
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
  param([AllowNull()] $Valor)
  [int]$n = 0
  if (-not [int]::TryParse([string]$Valor, [ref]$n)) { return $null }
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
  param([AllowNull()] [AllowEmptyString()] [string]$Texto)
  if ([string]::IsNullOrEmpty($Texto)) { return @() }
  $limpo = $Texto -replace '<!--', '&lt;!--' -replace '-->', '--&gt;'
  $linhas = $limpo -split "`r?`n"
  return @($linhas | ForEach-Object { '> ' + $_ })
}

function Invoke-ApprovalsApi {
  param(
    [Parameter(Mandatory)] [string]$Url,
    [Parameter(Mandatory)] [hashtable]$Corpo
  )
  # The password goes ONLY in the request body, never in a URL or a log. Short
  # timeout: the watcher must not hang a tick waiting on the API.
  $json = $Corpo | ConvertTo-Json -Depth 5
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
  $inicio = -1
  # Accepts the item heading with or without a title
  $padrao = "^##[ \t]+Item[ \t]+$ItemNumero([ \t]|$|[—–-])"
  for ($i = 0; $i -lt $Linhas.Count; $i++) {
    if ($Linhas[$i] -match $padrao) { $inicio = $i; break }
  }
  if ($inicio -lt 0) { return $null }
  $fim = $Linhas.Count
  for ($j = $inicio + 1; $j -lt $Linhas.Count; $j++) {
    if ($Linhas[$j] -match '^##[ \t]') { $fim = $j; break }
  }
  return @{ Inicio = $inicio; Fim = $fim }
}

function Sync-Approvals {
  param(
    [Parameter(Mandatory)] [string]$ApprovalsUrl,
    [Parameter(Mandatory)] [string]$Password,
    [Parameter(Mandatory)] [string]$Project,
    [Parameter(Mandatory)] [string]$Material,
    [Parameter(Mandatory)] [string]$OrqDir,
    [scriptblock]$Log = { param($nivel, $msg) Write-Host "[$nivel] $msg" },
    [object[]]$AprovacoesInjetadas = $null   # TESTING: stands in for the network
  )

  $resumo = [ordered]@{
    downloaded = 0; stamped = 0; rejected = 0; drenadas = 0
    gatesApproved = 0; gatesRejected = 0; errors = 0; markIds = @()
  }
  $modoTeste = ($null -ne $AprovacoesInjetadas)

  # --- 1. Fetch pending approvals (or use the ones injected by the test) ----
  $approvals = @()
  if ($modoTeste) {
    $approvals = @($AprovacoesInjetadas)
  }
  else {
    try {
      $resp = Invoke-ApprovalsApi -Url $ApprovalsUrl -Corpo @{
        password = $Password; action = 'list'; project = $Project; material = $Material
      }
      if (-not $resp.ok) { throw "response did not carry ok=true" }
      $approvals = @($resp.approvals)
    }
    catch {
      & $Log 'WARN' "Approval sync: API unavailable ($($_.Exception.Message)). Continuing without sync this tick."
      return [pscustomobject]$resumo
    }
  }
  $resumo.downloaded = $approvals.Count
  if ($approvals.Count -eq 0) { return [pscustomobject]$resumo }

  $dirGates    = Join-Path $OrqDir 'structural-gate'
  $ledgerLocal = Join-Path $OrqDir 'aprovacoes-processadas.jsonl'
  $agora       = Get-Date -Format o

  # Local ledger (an extra belt beyond the database's own processed flag)
  $jaProcessadas = @{}
  if (Test-Path -LiteralPath $ledgerLocal) {
    foreach ($linha in (Get-Content -LiteralPath $ledgerLocal -ErrorAction SilentlyContinue)) {
      try { $j = $linha | ConvertFrom-Json; $jaProcessadas["$($j.id)"] = $true } catch {}
    }
  }

  function Registrar-Processada($ap, $resultado) {
    @{
      id = $ap.id; gate = $ap.gate_file; item = $ap.item_number
      verdict = $ap.verdict; resultado = $resultado; ts = $agora
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath $ledgerLocal -Encoding utf8
  }

  # --- 2. Processar gate a gate (agrupado; itens em ordem) ------------------
  $porGate = $approvals | Group-Object -Property gate_file
  foreach ($grupo in $porGate) {
    $nomeGate = [string]$grupo.Name

    # Regra dura 1: revalidar o nome (defesa em profundidade; Test-GateFile
    # anchored at true end of string and case-sensitive: the stricter layer wins).
    if (-not (Test-GateFile $nomeGate)) {
      & $Log 'ERROR' "Sync: invalid gate file name from the database ('$(ConvertTo-SafeLogText $nomeGate)'). Refused."
      foreach ($ap in $grupo.Group) {
        Registrar-Processada $ap 'invalido-drenado'
        $resumo.markIds += $ap.id; $resumo.drenadas++
      }
      $resumo.errors++
      continue
    }

    $gatePath = Join-Path $dirGates $nomeGate
    if (-not (Test-Path -LiteralPath $gatePath)) {
      # A real anomaly (the gate is created BEFORE the dashboard decision): it stays
      # pending in the database and visible in the log, which beats a badge that lies.
      & $Log 'ERROR' "Sync: gate '$nomeGate' does not exist in $dirGates. Its approvals stay pending."
      $resumo.errors++
      continue
    }

    $conteudo = Get-Content -LiteralPath $gatePath -Raw
    if ($conteudo -notmatch '(?s)\A---\s*\r?\n(.*?)\r?\n---') {
      & $Log 'ERROR' "Sync: gate '$nomeGate' has no front matter - skipping."
      $resumo.errors++
      continue
    }
    $fm = $Matches[1]
    $statusPendente = $fm -match '(?im)^[ \t]*status[ \t]*:[ \t]*["'']?pending["'']?[ \t]*\r?$'

    # Hard rule 2, reinforced: sync only stamps a PENDING gate. If the status is
    # already approved or rejected (even with the engine not yet run), the gate is
    # DECIDED, and stamping here would mutate a body that was already settled.
    # already decided by the owner. Drain the late approval without touching anything.
    if (-not $statusPendente) {
      & $Log 'WARN' "Sync: gate '$nomeGate' is not pending (already decided). Draining the approval."
      foreach ($ap in $grupo.Group) {
        Registrar-Processada $ap 'gate-not-pending'
        $resumo.markIds += $ap.id; $resumo.drenadas++
      }
      continue
    }

    $linhas = $conteudo -split "`r?`n"
    $mudou  = $false

    foreach ($ap in ($grupo.Group | Sort-Object item_number)) {
      # Idempotence (hard rule 5): ONLY the local ledger decides what was processed.
      # We do NOT match the marker in the body: that was forgeable, and it could cause
      # an injected marker carrying a FUTURE id would make the count believe an item
      # a legitimate approval to be drained without being applied. The ledger is the
      # immune source: the watcher only writes there what it truly processed.
      if ($jaProcessadas.ContainsKey("$($ap.id)")) {
        Registrar-Processada $ap 'ja-carimbada'
        $resumo.markIds += $ap.id; $resumo.drenadas++
        continue
      }
      if ($ap.verdict -ne 'approved' -and $ap.verdict -ne 'rejected') {
        & $Log 'ERROR' "Sync: unknown verdict '$(ConvertTo-SafeLogText $ap.verdict)'. Approval refused."
        Registrar-Processada $ap 'invalid-verdict'
        $resumo.markIds += $ap.id; $resumo.drenadas++; $resumo.errors++
        continue
      }

      # Defensive parse of the item number: never let a cast blow up the batch
      $itemN = ConvertTo-ItemNumber (Read-ApprovalProp $ap 'item_number')
      if ($null -eq $itemN) {
        & $Log 'ERROR' "Sync: invalid item number. Approval refused."
        Registrar-Processada $ap 'item-numero-invalido'
        $resumo.markIds += $ap.id; $resumo.drenadas++; $resumo.errors++
        continue
      }

      $secao = Get-ItemSection -Linhas $linhas -ItemNumero $itemN
      if ($null -eq $secao) {
        & $Log 'ERROR' "Sync: item $itemN not found in gate '$nomeGate'. That approval stays pending."
        $resumo.errors++
        continue
      }

      if ($ap.verdict -eq 'rejected') {
        # Regra dura 4: rejeitado SAI do corpo (motor aplica o que fica) e
        # goes to the audit mirror file.
        $bloco = $linhas[$secao.Inicio..($secao.Fim - 1)] -join "`n"
        $espelho = Join-Path $dirGates ($nomeGate -replace '\.md\z', '.rejected.md')
        $cab = ""
        if (-not (Test-Path -LiteralPath $espelho)) {
          $cab = "# Items rejected via the dashboard - $nomeGate`n`n> Audit trail: the gate body keeps only what was approved.`n"
        }
        ($cab + "`n---`n<!-- approval:$($ap.id) verdict:rejected ts:$agora -->`n" + $bloco + "`n") |
          Add-Content -LiteralPath $espelho -Encoding utf8
        $resto = @()
        if ($secao.Inicio -gt 0) { $resto += $linhas[0..($secao.Inicio - 1)] }
        $resto += "<!-- item $itemN rejected in the dashboard · approval:$($ap.id) ts:$agora -->"
        if ($secao.Fim -lt $linhas.Count) { $resto += $linhas[$secao.Fim..($linhas.Count - 1)] }
        $linhas = $resto
        $resumo.rejected++
      }
      else {
        # Approved: a CANONICAL stamp on the line right after the item heading, plus
        # the edited proposal, hardened. The marker only counts in that fixed
        # position, so a forged marker in the middle of the text is not counted
        # as a stamped item.
        $marcador = "<!-- approval:$($ap.id) verdict:approved ts:$agora -->"
        $editadoRaw = [string](Read-ApprovalProp $ap 'edited_request')
        $temEdicao = -not [string]::IsNullOrWhiteSpace($editadoRaw)
        $bloco = @($linhas[$secao.Inicio..($secao.Fim - 1)])
        $novoBloco = @($bloco[0], $marcador)   # heading, then marker (canonical)
        if ($temEdicao) {
          $idxProp = -1
          for ($k = 1; $k -lt $bloco.Count; $k++) {
            if ($bloco[$k] -match '^\*\*Proposal if approved') { $idxProp = $k; break }
          }
          $edicao = @('**Proposal if approved (edited by the owner in the dashboard, approval ' + $ap.id + '):**')
          $edicao += Protect-EditedProposal $editadoRaw
          if ($idxProp -ge 1) {
            # Keep what comes before the proposal; the edited proposal closes the item.
            if ($idxProp -gt 1) { $novoBloco += $bloco[1..($idxProp - 1)] }
            $novoBloco += $edicao
          }
          else {
            if ($bloco.Count -gt 1) { $novoBloco += $bloco[1..($bloco.Count - 1)] }
            $novoBloco += $edicao
          }
        }
        else {
          if ($bloco.Count -gt 1) { $novoBloco += $bloco[1..($bloco.Count - 1)] }
        }
        $resto = @()
        if ($secao.Inicio -gt 0) { $resto += $linhas[0..($secao.Inicio - 1)] }
        $resto += $novoBloco
        if ($secao.Fim -lt $linhas.Count) { $resto += $linhas[$secao.Fim..($linhas.Count - 1)] }
        $linhas = $resto
        $resumo.stamped++
      }

      $conteudo = $linhas -join "`n"
      $mudou = $true
      Registrar-Processada $ap $ap.verdict
      $resumo.markIds += $ap.id
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
        $conteudo = $conteudo -replace '(?im)^([ \t]*applied_at[ \t]*:)[ \t]*\r?$', "`$1 $agora (rejected in the dashboard — nada aplicado)"
        $resumo.gatesRejected++
        & $Log 'INFO' "Sync: gate '$nomeGate' rejeitado por inteiro via painel — encerrado sem aplicar."
        # Close the ledger for the originating conclusion (same semantics as the engine)
        $condId = $null
        if ($fm -match '(?im)^[ \t]*conclusion_id[ \t]*:[ \t]*(\d+)') { $condId = [int]$Matches[1] }
        if ($null -ne $condId) {
          @{
            conclusion_id = $condId; project = $Project; material = $Material
            status = 'applied'; erro = $null; ts = $agora
            nota = "gate '$nomeGate' rejeitado por inteiro via painel - nada aplicado"
          } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $OrqDir 'ledger.jsonl') -Encoding utf8
        }
      }
      elseif ($itensCarimbados -eq $itensRestantes) {
        # Hard rule 3: EVERY remaining item has a verdict, so release the engine.
        $conteudo = $conteudo -replace '(?im)^([ \t]*status[ \t]*:[ \t]*)["'']?pending["'']?[ \t]*\r?$', "`$1approved"
        $resumo.gatesApproved++
        & $Log 'INFO' "Sync: gate '$nomeGate' has every item decided - status: approved (the engine picks it up this tick)."
      }
      else {
        & $Log 'INFO' "Sync: gate '$nomeGate' has a partial verdict ($itensCarimbados/$itensRestantes). Waiting for the rest."
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
  if (-not $modoTeste) {
    $idsUnicos = @($resumo.markIds | Select-Object -Unique)
    for ($ini = 0; $ini -lt $idsUnicos.Count; $ini += 100) {
      $fim = [Math]::Min($ini + 99, $idsUnicos.Count - 1)
      $lote = @($idsUnicos[$ini..$fim])
      try {
        $r = Invoke-ApprovalsApi -Url $ApprovalsUrl -Corpo @{
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

  return [pscustomobject]$resumo
}

function Read-ApprovalProp {
  # Leitura tolerante de propriedade (objeto de API ou hashtable de teste)
  param($obj, [string]$nome)
  if ($obj -is [hashtable]) { return $obj[$nome] }
  $p = $obj.PSObject.Properties[$nome]
  if ($null -ne $p) { return $p.Value }
  return $null
}
