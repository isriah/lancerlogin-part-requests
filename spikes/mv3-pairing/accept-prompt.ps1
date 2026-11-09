# Clicks a button in the permission prompt of ONE browser process tree, using Windows UI Automation, as a person would.
# It only looks at windows owned by the process IDs given, so it cannot touch any other browser window.
# Usage: accept-prompt.ps1 -RootPid <browser pid> -Button Allow|Deny [-TimeoutSeconds 15]
param([Parameter(Mandatory)][int]$RootPid, [Parameter(Mandatory)][ValidateSet("Allow", "Deny")][string]$Button, [int]$TimeoutSeconds = 15)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$seen = @()
while ((Get-Date) -lt $deadline) {
  foreach ($browserPid in $RootPid, (Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootPid" | Where-Object Name -eq "msedge.exe").ProcessId) {
    $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty), $browserPid
    foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
      $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
      foreach ($candidate in $buttons) {
        $name = $candidate.Current.Name
        if ($name -and $seen -notcontains $name) { $seen += $name }
        if ($name -eq $Button) {
          $candidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          Write-Output "clicked:$name"
          exit 0
        }
      }
    }
  }
  Start-Sleep -Milliseconds 300
}
Write-Output "not-found; buttons seen: $($seen -join ' | ')"
exit 2
