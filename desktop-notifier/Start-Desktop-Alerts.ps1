[CmdletBinding()]
param([string]$ServerUrl = 'http://localhost:3000')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$script:CrmUrl = $ServerUrl.TrimEnd('/')
$parsed = [uri]$script:CrmUrl
if ($parsed.Scheme -notin @('http','https') -or $parsed.UserInfo -or $parsed.AbsolutePath -ne '/') { throw 'Enter the CRM address, such as http://localhost:3000' }
$script:Session = $null
$script:Csrf = ''
$script:Quitting = $false
$script:Pending = @()
$script:Polling = $false

function Sign-In {
    $credential = Get-Credential -Message "Sign in to Lead CRM at $script:CrmUrl. Your password is not saved."
    if (-not $credential) { return $false }
    $payload = @{email=$credential.UserName;password=$credential.GetNetworkCredential().Password} | ConvertTo-Json
    try {
        $script:Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        $login = Invoke-RestMethod -Uri "$script:CrmUrl/api/auth/login" -Method Post -ContentType 'application/json' -Body $payload -WebSession $script:Session -TimeoutSec 8
        $script:Csrf = $login.csrfToken
        return $true
    } finally { $payload = $null; $credential = $null }
}

if (-not (Sign-In)) { exit }
$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = 'Lead - New lead assignments'
$script:Form.Size = New-Object System.Drawing.Size(440,390)
$script:Form.StartPosition = 'Manual'
$script:Form.TopMost = $true
$script:Form.FormBorderStyle = 'FixedDialog'
$script:Form.ControlBox = $false
$script:Form.ShowInTaskbar = $false
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$script:Form.Location = New-Object System.Drawing.Point(($bounds.Right-455),($bounds.Bottom-405))
$script:Heading = New-Object System.Windows.Forms.Label
$script:Heading.Text = 'New leads assigned to you'
$script:Heading.Font = New-Object System.Drawing.Font('Segoe UI',14,[System.Drawing.FontStyle]::Bold)
$script:Heading.Location = New-Object System.Drawing.Point(18,18)
$script:Heading.Size = New-Object System.Drawing.Size(395,34)
$script:List = New-Object System.Windows.Forms.ListBox
$script:List.Font = New-Object System.Drawing.Font('Segoe UI',11)
$script:List.Location = New-Object System.Drawing.Point(18,65)
$script:List.Size = New-Object System.Drawing.Size(390,175)
$script:Open = New-Object System.Windows.Forms.Button
$script:Open.Text = 'Open selected lead'
$script:Open.Location = New-Object System.Drawing.Point(18,250)
$script:Open.Size = New-Object System.Drawing.Size(390,38)
$script:Status = New-Object System.Windows.Forms.Label
$script:Status.Location = New-Object System.Drawing.Point(18,300)
$script:Status.Size = New-Object System.Drawing.Size(390,45)
$script:Status.Text = 'This alert stays until you open the lead.'
$script:Form.Controls.AddRange(@($script:Heading,$script:List,$script:Open,$script:Status))
$script:Form.Add_FormClosing({ param($sender,$eventArgs) if (-not $script:Quitting) { $eventArgs.Cancel = $true } })

$script:Tray = New-Object System.Windows.Forms.NotifyIcon
$script:Tray.Icon = [System.Drawing.SystemIcons]::Information
$script:Tray.Text = 'Lead CRM - Desktop alerts running'
$script:Tray.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$showItem = $menu.Items.Add('Show pending assignments')
$showItem.Add_Click({ if ($script:Pending.Count -gt 0) { $script:Form.Show(); $script:Form.Activate() } else { [System.Windows.Forms.MessageBox]::Show('No pending assignments.','Lead CRM') | Out-Null } })
$loginItem = $menu.Items.Add('Sign in again')
$loginItem.Add_Click({ try { if (Sign-In) { $script:Timer.Start(); Poll-Assignments } } catch { [System.Windows.Forms.MessageBox]::Show('Sign-in failed. Check your CRM email and password.','Lead CRM') | Out-Null } })
$quitItem = $menu.Items.Add('Quit desktop alerts')
$quitItem.Add_Click({ $script:Quitting=$true; $script:Timer.Stop(); $script:Tray.Visible=$false; $script:Form.Close(); [System.Windows.Forms.Application]::Exit() })
$script:Tray.ContextMenuStrip = $menu

function Poll-Assignments {
    if ($script:Polling) { return }
    $script:Polling = $true
    try {
        $response = Invoke-RestMethod -Uri "$script:CrmUrl/api/notifications" -WebSession $script:Session -TimeoutSec 5
        $pendingNow = @($response | ForEach-Object { $_ })
        if ($pendingNow.Count -eq 1 -and $null -eq $pendingNow[0]) { $pendingNow = @() }
        $previousId = if ($script:List.SelectedIndex -ge 0) { $script:Pending[$script:List.SelectedIndex].id } else { 0 }
        $script:Pending = $pendingNow
        $script:List.Items.Clear()
        foreach ($notice in $script:Pending) { [void]$script:List.Items.Add("$($notice.name) - $($notice.interest)") }
        if ($script:Pending.Count -gt 0) {
            $selectedIndex=0
            for($i=0;$i -lt $script:Pending.Count;$i++){if($script:Pending[$i].id -eq $previousId){$selectedIndex=$i}}
            $script:List.SelectedIndex=$selectedIndex
            if (-not $script:Form.Visible) { $script:Form.Show() }
        } else { $script:Form.Hide() }
        $script:Status.Text='This alert stays until you open the lead.'
        $script:Tray.Text='Lead CRM - Desktop alerts running'
    } catch {
        $script:Status.Text='Cannot reach CRM. Retrying; pending alerts are saved on the server.'
        $script:Tray.Text='Lead CRM - Connection unavailable'
        $responseProperty=$_.Exception.PSObject.Properties['Response']
        if ($responseProperty -and $responseProperty.Value -and [int]$responseProperty.Value.StatusCode -eq 401) {
            $script:Timer.Stop()
            $script:Tray.Text='Lead CRM - Sign in again from this tray icon'
            $script:Tray.ShowBalloonTip(10000,'Lead CRM','Session expired. Right-click this icon and choose Sign in again.',[System.Windows.Forms.ToolTipIcon]::Info)
        }
    } finally { $script:Polling=$false }
}

$script:Open.Add_Click({
    if ($script:List.SelectedIndex -lt 0) { return }
    $notice=$script:Pending[$script:List.SelectedIndex]
    try {
        Start-Process "$script:CrmUrl/?lead=$($notice.leadId)"
        Invoke-RestMethod -Uri "$script:CrmUrl/api/notifications/$($notice.id)/acknowledge" -Method Post -Headers @{'x-csrf-token'=$script:Csrf} -WebSession $script:Session -TimeoutSec 5 | Out-Null
        Poll-Assignments
    } catch { $script:Status.Text='Could not open or acknowledge. Your alert is retained; try again.' }
})
$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 15000
$script:Timer.Add_Tick({ Poll-Assignments })
$script:Timer.Start()
Poll-Assignments
try { [System.Windows.Forms.Application]::Run() }
finally {
    $script:Timer.Dispose();$script:Tray.Dispose();$script:Form.Dispose()
    try { Invoke-RestMethod -Uri "$script:CrmUrl/api/auth/logout" -Method Post -Headers @{'x-csrf-token'=$script:Csrf} -WebSession $script:Session -TimeoutSec 3 | Out-Null } catch { }
}
