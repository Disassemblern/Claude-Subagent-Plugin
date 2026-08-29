# Subagent approval dialog. Reads a JSON payload on stdin, writes a JSON object
# of decisions on stdout. Runs from a hook with no TTY.
# Spawns from one turn reach their hooks seconds apart, so the window opens
# immediately and new rows stream in from rowsFile while it is up.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json
$timeoutMs = if ($payload.timeoutMs) { [int]$payload.timeoutMs } else { 90000 }
$rowsFile = $payload.rowsFile

$MODELS = @("inherit", "haiku", "sonnet", "opus", "fable")
$ROW_H = 74

$form = New-Object System.Windows.Forms.Form
$form.Text = "Subagent gate"
$form.Size = New-Object System.Drawing.Size(940, 560)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.MinimizeBox = $false
$form.MaximizeBox = $false

$header = New-Object System.Windows.Forms.Label
$header.Location = New-Object System.Drawing.Point(14, 12)
$header.Size = New-Object System.Drawing.Size(880, 20)
$header.Text = "Waiting for subagents..."
$form.Controls.Add($header)

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(14, 32)
$status.Size = New-Object System.Drawing.Size(880, 18)
$status.ForeColor = [System.Drawing.Color]::FromArgb(180, 110, 20)
$status.Text = "Still receiving spawns - approving now will only apply to the rows shown."
$form.Controls.Add($status)

$panel = New-Object System.Windows.Forms.Panel
$panel.Location = New-Object System.Drawing.Point(10, 54)
$panel.Size = New-Object System.Drawing.Size(900, 400)
$panel.AutoScroll = $true
$panel.Anchor = "Top,Left,Bottom,Right"
$form.Controls.Add($panel)

$controls = @{}
$script:nextY = 6

function Add-Row($row) {
    if ($controls.ContainsKey($row.toolUseId)) { return }

    $box = New-Object System.Windows.Forms.GroupBox
    $box.Location = New-Object System.Drawing.Point(4, $script:nextY)
    $box.Size = New-Object System.Drawing.Size(858, 68)
    $box.Text = "$($row.subagentType)"

    $run = New-Object System.Windows.Forms.CheckBox
    $run.Text = $row.description
    $run.Checked = $true
    $run.Location = New-Object System.Drawing.Point(12, 20)
    $run.Size = New-Object System.Drawing.Size(520, 20)
    $box.Controls.Add($run)

    $preview = New-Object System.Windows.Forms.Label
    $preview.Text = $row.prompt
    $preview.Location = New-Object System.Drawing.Point(30, 42)
    $preview.Size = New-Object System.Drawing.Size(500, 18)
    $preview.ForeColor = [System.Drawing.Color]::Gray
    $preview.AutoEllipsis = $true
    $box.Controls.Add($preview)

    $label = New-Object System.Windows.Forms.Label
    $label.Text = "model (now: $($row.effectiveModel))"
    $label.Location = New-Object System.Drawing.Point(556, 20)
    $label.Size = New-Object System.Drawing.Size(180, 18)
    $box.Controls.Add($label)

    $combo = New-Object System.Windows.Forms.ComboBox
    $combo.DropDownStyle = "DropDownList"
    $combo.Location = New-Object System.Drawing.Point(556, 40)
    $combo.Size = New-Object System.Drawing.Size(130, 22)
    [void]$combo.Items.AddRange($MODELS)
    $combo.SelectedItem = if ($MODELS -contains $row.effectiveModel) { $row.effectiveModel } else { "inherit" }
    $box.Controls.Add($combo)

    $remember = New-Object System.Windows.Forms.CheckBox
    $remember.Text = "remember for this type"
    $remember.Location = New-Object System.Drawing.Point(700, 41)
    $remember.Size = New-Object System.Drawing.Size(150, 20)
    $box.Controls.Add($remember)

    $panel.Controls.Add($box)
    $controls[$row.toolUseId] = @{ Run = $run; Combo = $combo; Remember = $remember }
    $script:nextY += $ROW_H
}

$script:settleAt = 0
$script:final = $false

function Sync-Rows {
    if (-not $rowsFile) { return }
    try { $doc = Get-Content -LiteralPath $rowsFile -Raw -ErrorAction Stop | ConvertFrom-Json }
    catch { return }   # mid-write or missing; try again next tick
    foreach ($row in @($doc.rows)) { Add-Row $row }
    if ($doc.settleAt) { $script:settleAt = [double]$doc.settleAt }
    $script:final = [bool]$doc.final
}

# There is no way to know the total in advance: the runtime reports each spawn
# only as it happens. So show whether more may still be coming, and when we
# stop waiting, rather than pretending to know a count.
function Update-Status {
    $n = $controls.Count
    $form.Text = "Subagent gate - $n subagent(s)"
    $header.Text = "Uncheck to block a spawn. Change the model to control what it costs."

    if ($script:final) {
        $status.ForeColor = [System.Drawing.Color]::FromArgb(30, 120, 70)
        $status.Text = "All $n spawn(s) received - nothing more is coming."
        $approve.Text = "Approve"
        return
    }

    $nowMs = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $left = [Math]::Max(0, [Math]::Ceiling(($script:settleAt - $nowMs) / 1000))
    $status.ForeColor = [System.Drawing.Color]::FromArgb(180, 110, 20)
    $status.Text = "Still receiving spawns - $n so far, waiting $left more second(s) for others. Approving now applies only to these $n."
    $approve.Text = "Approve these $n"
}

foreach ($row in @($payload.rows)) { Add-Row $row }
Sync-Rows

$script:result = "cancel"

$approve = New-Object System.Windows.Forms.Button
$approve.Text = "Approve"
$approve.Size = New-Object System.Drawing.Size(110, 30)
$approve.Location = New-Object System.Drawing.Point(690, 470)
$approve.Anchor = "Bottom,Right"
$approve.Add_Click({ $script:result = "approve"; $form.Close() })
$form.Controls.Add($approve)
$form.AcceptButton = $approve

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel all"
$cancel.Size = New-Object System.Drawing.Size(110, 30)
$cancel.Location = New-Object System.Drawing.Point(572, 470)
$cancel.Anchor = "Bottom,Right"
$cancel.Add_Click({ $script:result = "cancel"; $form.Close() })
$form.Controls.Add($cancel)

Update-Status

$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 400
$poll.Interval = 250
$poll.Add_Tick({ Sync-Rows; Update-Status })
$poll.Start()

# Unattended machines must not block a turn forever. Timing out means "leave it
# alone", never "deny": the caller treats a timeout as allow-unchanged.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $timeoutMs
$timer.Add_Tick({ $script:result = "timeout"; $timer.Stop(); $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
$timer.Stop()
$poll.Stop()

$decisions = @{}
if ($script:result -eq "approve") {
    foreach ($key in $controls.Keys) {
        $c = $controls[$key]
        $model = if ($c.Combo.SelectedItem -eq "inherit") { $null } else { [string]$c.Combo.SelectedItem }
        $decisions[$key] = @{
            approved = [bool]$c.Run.Checked
            model    = $model
            remember = [bool]$c.Remember.Checked
        }
    }
}
elseif ($script:result -eq "cancel") {
    foreach ($key in $controls.Keys) {
        $decisions[$key] = @{ approved = $false; model = $null; remember = $false }
    }
}

[Console]::Out.Write((@{ result = $script:result; decisions = $decisions } | ConvertTo-Json -Depth 5 -Compress))
