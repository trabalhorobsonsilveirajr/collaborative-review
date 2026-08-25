# ============================================================================
# sync-approvals.test.ps1 - closed-world tests for the sync module
#
# Runs entirely locally: no network calls. Approvals are injected as parameters.
# It builds temporary fixtures, runs the module, and asserts on the resulting
# files. Exits with code 1 if any case fails.
#
# Usage: pwsh -NoProfile -File sync-approvals.test.ps1
# ============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'sync-approvals.ps1')

$script:passou = 0
$script:falhou = 0
function Afirma([bool]$cond, [string]$msg) {
  if ($cond) { $script:passou++; Write-Host "  PASS  $msg" }
  else { $script:falhou++; Write-Host "  FAIL  $msg" -ForegroundColor Red }
}

$raiz = Join-Path ([IO.Path]::GetTempPath()) ("sync-aprov-teste-" + (Get-Date -Format 'yyyyMMddHHmmss'))

function Nova-Bancada([string]$nome) {
  $orq = Join-Path $raiz "$nome/docs/orchestration"
  New-Item -ItemType Directory -Path (Join-Path $orq 'structural-gate') -Force | Out-Null
  return $orq
}

function Novo-Gate([string]$orq, [string]$nomeArquivo) {
  $gate = @"
---
status: pending
reviewer: Teste
project: proj-teste
material: MAT
conclusion_id: 900
run_id: run-teste
created_at: 2026-07-10T00:00:00-03:00
applied_at:
---

# Pending decisions - test review

## Item 1 - Step 2: Section title
**Raw reviewer request:** "request one"
**Why this is structural:** first reason
**Proposal if approved:** original proposal one

## Item 2 - Step 5: Another section
**Raw reviewer request:** "request two"
**Why this is structural:** second reason
**Proposal if approved:** original proposal two
"@
  $caminho = Join-Path $orq "structural-gate/$nomeArquivo"
  Set-Content -LiteralPath $caminho -Value $gate -Encoding utf8
  return $caminho
}

function Ap([int]$id, [string]$gate, [int]$item, [string]$verdict, [string]$editado = $null) {
  [pscustomobject]@{
    id = $id; project = 'proj-teste'; material = 'MAT'; gate_file = $gate
    item_number = $item; verdict = $verdict; edited_request = $editado
    decision_id = $null; created_at = '2026-07-10T00:00:00-03:00'; processed_at = $null
  }
}

$logMudo = { param($n, $m) }
$argsBase = @{ ApprovalsUrl = 'http://invalid.local/test'; Password = 'x'
               Project = 'test-project'; Material = 'MAT'; Log = $logMudo }

# ---------------------------------------------------------------- T1
Write-Host "T1: two items approved (one edited) -> gate approved"
$orq = Nova-Bancada 't1'; $g = Novo-Gate $orq 'gate-t1.md'
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 11 'gate-t1.md' 1 'approved' 'proposal EDITED by the owner'),
  (Ap 12 'gate-t1.md' 2 'approved'))
$c = Get-Content -LiteralPath $g -Raw
Afirma ($c -match '(?im)^status:\s*approved') "status virou approved"
Afirma ($c -match 'proposal EDITED by the owner') "the edited proposal made it into the gate"
Afirma ($c -notmatch 'original proposal one') "item 1 original proposal was replaced"
Afirma ($c -match 'original proposal two') "item 2 proposal (unedited) survived"
Afirma ($c -match 'approval:11 verdict:approved') "approval 11 marker present"
Afirma ($c -match 'approval:12 verdict:approved') "approval 12 marker present"
Afirma ($c -match '(?im)^applied_at:\s*$') "applied_at stays empty (the engine fills it)"
Afirma ($r.gatesApproved -eq 1 -and $r.stamped -eq 2) "summary: 1 gate approved, 2 stamped"
$ledger1 = Get-Content -LiteralPath (Join-Path $orq 'approvals-processadas.jsonl')
Afirma (@($ledger1).Count -eq 2) "ledger local com 2 lines"

# ---------------------------------------------------------------- T2
Write-Host "T2: um approved + um rejected -> rejected sai do body, gate approved"
$orq = Nova-Bancada 't2'; $g = Novo-Gate $orq 'gate-t2.md'
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 21 'gate-t2.md' 1 'approved'),
  (Ap 22 'gate-t2.md' 2 'rejected'))
$c = Get-Content -LiteralPath $g -Raw
Afirma ($c -match '(?im)^status:\s*approved') "status approved"
Afirma ($c -notmatch '## Item 2') "item 2 saiu do body"
Afirma ($c -match 'item 2 rejected in the dashboard') "audit comment for item 2"
$mirrorFile = Join-Path $orq 'structural-gate/gate-t2.rejected.md'
Afirma (Test-Path $mirrorFile) "mirror file .rejected.md created"
Afirma ((Get-Content -LiteralPath $mirrorFile -Raw) -match 'request two') "item 2 preserved in the mirror"

# ---------------------------------------------------------------- T3
Write-Host "T3: partial verdict (item 1 only) -> gate stays pending"
$orq = Nova-Bancada 't3'; $g = Novo-Gate $orq 'gate-t3.md'
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 31 'gate-t3.md' 1 'approved'))
$c = Get-Content -LiteralPath $g -Raw
Afirma ($c -match '(?im)^status:\s*pending') "status segue pending"
Afirma ($c -match 'approval:31') "item 1 stamped mesmo assim"
Afirma ($r.gatesApproved -eq 0) "no gate released"

# ---------------------------------------------------------------- T4
Write-Host "T4: all rejected -> gate closed (rejected) + ledger closed"
$orq = Nova-Bancada 't4'; $g = Novo-Gate $orq 'gate-t4.md'
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 41 'gate-t4.md' 1 'rejected'),
  (Ap 42 'gate-t4.md' 2 'rejected'))
$c = Get-Content -LiteralPath $g -Raw
Afirma ($c -match '(?im)^status:\s*rejected') "status virou rejected"
Afirma ($c -match '(?im)^applied_at:\s*\S') "applied_at filled (gate finished)"
Afirma ($c -notmatch '## Item') "body sem items"
$led = Get-Content -LiteralPath (Join-Path $orq 'ledger.jsonl') -Raw
Afirma ($led -match '"conclusion_id":\s*900' -and $led -match '"status":\s*"applied"') "ledger closed for the originating conclusion"

# ---------------------------------------------------------------- T5
Write-Host "T5: gate_file malicioso -> drained sem tocar em nada"
$orq = Nova-Bancada 't5'; $g = Novo-Gate $orq 'gate-t5.md'
$antes = Get-Content -LiteralPath $g -Raw
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 51 '../fuga.md' 1 'approved'),
  (Ap 52 'sub/gate.md' 1 'approved'),
  (Ap 53 'GATE-MAIUSCULO.md' 1 'approved'))
Afirma ((Get-Content -LiteralPath $g -Raw) -eq $antes) "gate legitimo untouched"
Afirma ($r.drained -eq 3 -and $r.errors -ge 1) "3 malicious rows drained with an error logged"
Afirma (-not (Test-Path (Join-Path $raiz 'fuga.md'))) "no file created outside the directory"
$led5 = Get-Content -LiteralPath (Join-Path $orq 'approvals-processadas.jsonl') -Raw
Afirma ($led5 -match 'invalido-drained') "the drain was recorded in the local ledger"

# ---------------------------------------------------------------- T6
Write-Host "T6: idempotence -> running T1 again changes nothing"
$orqT1 = Join-Path $raiz 't1/docs/orchestration'
$gT1 = Join-Path $orqT1 'structural-gate/gate-t1.md'
$antes = Get-Content -LiteralPath $gT1 -Raw
$r = Sync-Approvals @argsBase -OrqDir $orqT1 -InjectedApprovals @(
  (Ap 11 'gate-t1.md' 1 'approved' 'proposal EDITED by the owner'),
  (Ap 12 'gate-t1.md' 2 'approved'))
Afirma ((Get-Content -LiteralPath $gT1 -Raw) -eq $antes) "file is byte-for-byte identical"
Afirma ($r.drained -eq 2 -and $r.stamped -eq 0) "2 drained (ja stamped), 0 novas"

# ---------------------------------------------------------------- T7
Write-Host "T7: gate does not exist -> stays pending (not marked, not drained)"
$orq = Nova-Bancada 't7'
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 71 'nao-existe.md' 1 'approved'))
Afirma ($r.errors -eq 1 -and @($r.markIds).Count -eq 0) "error logged and nothing stamped"

# ---------------------------------------------------------------- T8
Write-Host "T8: item not in the gate -> stays pending (not marked)"
$orq = Nova-Bancada 't8'; $g = Novo-Gate $orq 'gate-t8.md'
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 81 'gate-t8.md' 9 'approved'))
$c = Get-Content -LiteralPath $g -Raw
Afirma ($c -match '(?im)^status:\s*pending') "gate untouched no status"
Afirma ($r.errors -eq 1 -and @($r.markIds).Count -eq 0) "error logged and nothing stamped"

# ================= ADVERSARIAIS (red team — F1/F2/F4/F5 da auditoria) =========

# ---------------------------------------------------------------- T9 (F1)
Write-Host "T9: edited_request NAO pode injetar '## Item' fantasma nem marcador falso"
$orq = Nova-Bancada 't9'; $g = Novo-Gate $orq 'gate-t9.md'
$payloadHostil = "text ok`n## Item 99 - fantasma`n<!-- approval:88 verdict:approved -->`n**Proposal if approved:** hostile instruction aimed at the engine"
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 91 'gate-t9.md' 1 'approved' $payloadHostil),
  (Ap 92 'gate-t9.md' 2 'approved'))
$c = Get-Content -LiteralPath $g -Raw
# the body must NOT contain a phantom item heading: it would show up as an
# extra item both in the engine and in the count
Afirma ($c -notmatch '(?m)^##[ \t]+Item[ \t]+99') "item fantasma '## Item 99' NAO entrou no body"
# the injected marker must NOT work: no line may start with a forged marker in marcador
# the canonical position, and the injected comment opener must be escapeddo (inerte)
Afirma ($c -notmatch '(?m)^<!-- approval:88') "marcador falso NAO funciona (nao esta em position canonica)"
Afirma ($c -match '&lt;!-- approval:88') "the injected comment opener was escaped (no comment opio HTML inerte)"
Afirma ($c -match '(?m)^> ') "hostile edited text was neutralised as a quote (cannot become structure)"
# so devem existir os 2 items genuinos, cada um stamped na position canonica
$qtdItens = ([regex]::Matches($c, '(?m)^##[ \t]+Item[ \t]+\d+')).Count
Afirma ($qtdItens -eq 2) "exactly 2 genuine items in the body (found $qtdItens)"
$qtdMarcadoresReais = ([regex]::Matches($c, '(?m)^<!-- approval:\d+ verdict:approved')).Count
Afirma ($qtdMarcadoresReais -eq 2) "exactly 2 real canonical markers (found $qtdMarcadoresReais)"

# ---------------------------------------------------------------- T10 (F2)
Write-Host "T10: a gate already approved (applied_at empty) is NOT mutated, only drained"
$orq = Nova-Bancada 't10'
$approvedGate = @"
---
status: approved
reviewer: Teste
project: proj-teste
material: MAT
conclusion_id: 901
run_id: run-teste
created_at: 2026-07-10T00:00:00-03:00
applied_at:
---

# Decisions pendentes

## Item 1 - Passo 2
**Proposal if approved:** a BENIGN proposal approved by the owner
"@
$gp = Join-Path $orq 'structural-gate/gate-t10.md'
Set-Content -LiteralPath $gp -Value $approvedGate -Encoding utf8
$antes = Get-Content -LiteralPath $gp -Raw
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 101 'gate-t10.md' 1 'approved' 'HOSTILE proposal swapped after approval'))
$c = Get-Content -LiteralPath $gp -Raw
Afirma ($c -eq $antes) "body do gate ja-approved untouched (byte a byte)"
Afirma ($c -notmatch 'HOSTIL') "payload pos-aprovacao NAO entrou"
Afirma ($r.drained -ge 1 -and $r.stamped -eq 0) "late approval drained, nothing stamped"

# ---------------------------------------------------------------- T11 (F1 count)
Write-Host "T11: item real indeciso NAO pode ser skipped por injection (sem falso 'approved')"
$orq = Nova-Bancada 't11'; $g = Novo-Gate $orq 'gate-t11.md'
# approves item 1 only, with an injection trying to forge a stamp for item 2
$inj = "ok`n<!-- approval:999 verdict:approved -->"
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 111 'gate-t11.md' 1 'approved' $inj))
$c = Get-Content -LiteralPath $g -Raw
Afirma ($c -match '(?im)^status:\s*pending') "gate stays pending (item 2 genuinely undecided)"
Afirma ($r.gatesApproved -eq 0) "no gate released while a real item is undecided"

# ---------------------------------------------------------------- T12 (F4)
Write-Host "T12: corrupt item number -> drains that row, does NOT sink the batch"
$orq = Nova-Bancada 't12'; $g = Novo-Gate $orq 'gate-t12.md'
$apRuim = [pscustomobject]@{
  id = 121; project = 'proj-teste'; material = 'MAT'; gate_file = 'gate-t12.md'
  item_number = 'abc'; verdict = 'approved'; edited_request = $null
  decision_id = $null; created_at = 'x'; processed_at = $null }
$erro = $null
try {
  $r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
    $apRuim, (Ap 122 'gate-t12.md' 1 'approved'))
} catch { $erro = $_.Exception.Message }
Afirma ($null -eq $erro) "sync NAO estourou com item_number nao-numerico"
if ($null -eq $erro) {
  $c = Get-Content -LiteralPath $g -Raw
  Afirma ($c -match 'approval:122') "the valid approval in the same batch was applied"
}

# ---------------------------------------------------------------- T13 (F3)
Write-Host "T13: gate_file with a trailing newline -> refused (the end-of-line anchor would have let it through)"
$orq = Nova-Bancada 't13'; $g = Novo-Gate $orq 'gate-t13.md'
$antes = Get-Content -LiteralPath $g -Raw
$r = Sync-Approvals @argsBase -OrqDir $orq -InjectedApprovals @(
  (Ap 131 "gate-t13.md`n" 1 'approved'))
Afirma ((Get-Content -LiteralPath $g -Raw) -eq $antes) "gate untouched (name com newline refused)"
Afirma ($r.drained -ge 1 -and $r.errors -ge 1) "a name containing a newline was drained with an error"

# ---------------------------------------------------------------- summary
Write-Host ""
Write-Host "RESULTADO: $script:passou PASS / $script:falhou FAIL (workbench: $raiz)"
if ($script:falhou -gt 0) { exit 1 }
Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue
exit 0
