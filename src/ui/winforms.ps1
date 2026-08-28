# Subagent approval dialog. Reads a JSON array of rows on stdin, writes a JSON
# object of decisions on stdout. Runs from a hook with no TTY.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json
$rows = @($payload.rows)
$timeoutMs = if ($payload.timeoutMs) { [int]$payload.timeoutMs } else { 90000 }

$MODELS = @("inherit", "haiku", "sonnet", "opus", "fable")

$form = New-Object System.Windows.Forms.Form
$form.Text = "Subagent gate - $($rows.Count) subagent(s) about to spawn"
$form.Size = New-Object System.Drawing.Size(940, [Math]::Min(720, 210 + ($rows.Count * 74)))
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.MinimizeBox = $false
$form.MaximizeBox = $false

$header = New-Object System.Windows.Forms.Label
$header.Text = "Uncheck to block a spawn. Change the model to control what it costs."
$header.Location = New-Object System.Drawing.Point(14, 12)
$header.Size = New-Object System.Drawing.Size(880, 20)
$form.Controls.Add($header)

$panel = New-Object System.Windows.Forms.Panel
$panel.Location = New-Object System.Drawing.Point(10, 38)
$panel.Size = New-Object System.Drawing.Size(900, ($form.ClientSize.Height - 100))
$panel.AutoScroll = $true
$panel.Anchor = "Top,Left,Bottom,Right"
$form.Controls.Add($panel)

$controls = @{}
$y = 6
foreach ($row in $rows) {
    $box = New-Object System.Windows.Forms.GroupBox
    $box.Location = New-Object System.Drawing.Point(4, $y)
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
    $y += 74
}

$result = "cancel"

$approve = New-Object System.Windows.Forms.Button
$approve.Text = "Approve"
$approve.Size = New-Object System.Drawing.Size(110, 30)
$approve.Location = New-Object System.Drawing.Point(690, ($form.ClientSize.Height - 46))
$approve.Anchor = "Bottom,Right"
$approve.Add_Click({ $script:result = "approve"; $form.Close() })
$form.Controls.Add($approve)
$form.AcceptButton = $approve

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel all"
$cancel.Size = New-Object System.Drawing.Size(110, 30)
$cancel.Location = New-Object System.Drawing.Point(572, ($form.ClientSize.Height - 46))
$cancel.Anchor = "Bottom,Right"
$cancel.Add_Click({ $script:result = "cancel"; $form.Close() })
$form.Controls.Add($cancel)

# Unattended machines must not block a turn forever. Timing out means "leave it
# alone", never "deny": the caller treats an empty result as allow-unchanged.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $timeoutMs
$timer.Add_Tick({ $script:result = "timeout"; $timer.Stop(); $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
$timer.Stop()

$decisions = @{}
if ($result -eq "approve") {
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
elseif ($result -eq "cancel") {
    foreach ($key in $controls.Keys) {
        $decisions[$key] = @{ approved = $false; model = $null; remember = $false }
    }
}

[Console]::Out.Write((@{ result = $result; decisions = $decisions } | ConvertTo-Json -Depth 5 -Compress))
