#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][int]$OwnerPid, [Parameter(Mandatory)][ValidateSet('host-state','console','stop-boot','diagnostics','inspect','before-reboot','after-reboot','restart-check','package-logon','package-stage','package-install','package-inventory','package-repair','package-uninstall','package-diagnostics','package-show-list','package-open-main','vmms-stage','vmms-run','vmms-recover','vmms-inspect','image-stage','image-refresh','image-run','image-inspect','audio-stage','audio-run','audio-refresh','audio-inspect','translation-stage','translation-run','translation-refresh','translation-inspect','translation-bind','agentprobe-stage','agentprobe-stage-finish','agentprobe-run','agentprobe-inspect','soak-stage','soak-stage-finish','soak-run','soak-offline','soak-dispatch-repair-finish','soak-dispatch-repair','soak-preserve-finish','soak-preserve','soak-diagnostics','soak-retire','soak-cancel','soak-inspect','exchange-stage','exchange-stage-finish','exchange-run','exchange-inspect','compound-stage','compound-run','compound-recover','compound-inspect','compound-collect','volume-stage','volume-run','volume-recover','volume-inspect','volume-console','volume-channel-probe','volume-offline-read','volume-durable-read','volume-preserve','volume-preserve-finish','volume-retire-stage','volume-retire','volume-collect','disk-stage','disk-run','disk-refresh','disk-refresh-continue','disk-resume','disk-inspect','disk-snapshot','upgrade-profile','upgrade-stage','upgrade-old-install','upgrade-old-seed','upgrade-install','upgrade-current','upgrade-reject','upgrade-uninstall','upgrade-cleanup','upgrade-audit','upgrade-permissions','upgrade-repair-fixture','upgrade-inspect','ime-console','ime-stage','ime-run','ime-inspect','ime-stop','collect-state','collect-stop')][string]$Phase)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$directoryPath = [IO.Path]::GetFullPath($Directory)
if ([IO.Path]::GetFileName($directoryPath) -notmatch '^pro-host-[a-f0-9-]{36}$') { throw 'Dedicated Pro fixture required' }
Add-Type -Path (Join-Path $PSScriptRoot '../../native/windows/PacketLabGuard.cs')
$guard = [MuPacketLabGuard]::new($OwnerPid, $directoryPath)
$config = $guard.ReadCommand('config.json') | ConvertFrom-Json
$machine = $guard.ReadCommand('machine.json') | ConvertFrom-Json
$credentials = $guard.ReadGuestCredentials() | ConvertFrom-Json
if ($credentials.adminUser -ne 'MuLabAdmin' -or $credentials.user -ne 'MuLabUser') { throw 'Only this fixture synthetic accounts are allowed' }
$report = $guard.Reserve('probe-' + [guid]::NewGuid().ToString('N') + '.json')
$session = $null
function Save-ProProbe([string]$state, $result = $null) { [IO.File]::WriteAllText($report, (@{ phase = $Phase; state = $state; time = [DateTime]::UtcNow.ToString('o'); result = $result } | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false)) }
function Assert-ProLegacyPhase([string]$Value){if($Value -notin @('before-reboot','after-reboot','inspect','diagnostics')){throw 'This phase has no dedicated handler; legacy servicing is forbidden'}}
function Assert-ProFixture {
    if ($config.flavor -ne 'pro26300' -or $config.name -ne $machine.name -or $machine.name -notmatch '^mu-win-pro-[a-f0-9]{32}$') { throw 'Pro fixture identity changed' }
    $vm = Get-VM -Id ([guid]$machine.id)
    $disks = @(Get-VMHardDiskDrive -VM $vm)
    $expected = [IO.Path]::GetFullPath((Join-Path $directoryPath 'trace-artifacts/windows.vhdx'))
    if ($vm.Name -ne $machine.name -or $vm.Notes -ne ('MuCodeSandbox isolated Pro diagnostic ' + $machine.name) -or $disks.Count -ne 1 -or [IO.Path]::GetFullPath($disks[0].Path) -ne $expected -or [IO.Path]::GetFullPath($machine.disk) -ne $expected -or @(Get-VMNetworkAdapter -VM $vm | Where-Object SwitchName).Count -or -not (Get-VMProcessor -VM $vm).ExposeVirtualizationExtensions) { throw 'Pro VM boundary changed' }
    return $vm
}
function Connect-ProGuest([string]$DifferentBootId = '') {
    $vm = Assert-ProFixture
    if ($Phase -eq 'stop-boot') {
        $latest = Get-ChildItem -LiteralPath $directoryPath -File -Filter 'start-*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $started = Get-Content -LiteralPath $latest.FullName -Raw | ConvertFrom-Json
        if ($started.phase -ne 'running-fixed-guest-winpe-startup' -or $started.status -ne 'running') { throw 'Only the unfinished initial WinPE boot can be stopped here' }
        Stop-VM -VM $vm -TurnOff -Force
        if ((Assert-ProFixture).State -ne 'Off') { throw 'Pro boot stop unconfirmed' }
        Save-ProProbe 'failed-initial-boot-stopped' @{ diskAndVmPreserved = $true; hostRestarted = $false }; exit 0
    }
    if ($Phase -eq 'console') {
        Add-Type -AssemblyName System.Drawing
        $system = Get-WmiObject -Namespace root/virtualization/v2 -Class Msvm_ComputerSystem -Filter ("Name='" + [string]$vm.Id + "'")
        $settings = @($system.GetRelated('Msvm_VirtualSystemSettingData','Msvm_SettingsDefineState',$null,$null,'SettingData','ManagedElement',$false,$null))
        $service = Get-WmiObject -Namespace root/virtualization/v2 -Class Msvm_VirtualSystemManagementService
        $parameters = $service.GetMethodParameters('GetVirtualSystemThumbnailImage')
        $parameters['TargetSystem'] = $settings[0].Path.Path; $parameters['WidthPixels'] = [uint16]800; $parameters['HeightPixels'] = [uint16]600
        $frame = $service.InvokeMethod('GetVirtualSystemThumbnailImage',$parameters,$null)
        $pixels = 800 * 600 * 2; $offset = 0
        if ($frame.ReturnValue -ne 0 -or $frame.ImageData.Length -notin @($pixels,($pixels+4))) { throw 'Pro framebuffer unavailable' }
        if ($frame.ImageData.Length -eq $pixels+4) { $offset = 4 }
        $file = $guard.Reserve('console-' + [guid]::NewGuid().ToString('N') + '.png')
        $bitmap = [Drawing.Bitmap]::new(800,600,[Drawing.Imaging.PixelFormat]::Format16bppRgb565)
        try { $data = $bitmap.LockBits([Drawing.Rectangle]::new(0,0,800,600),[Drawing.Imaging.ImageLockMode]::WriteOnly,[Drawing.Imaging.PixelFormat]::Format16bppRgb565); try { [Runtime.InteropServices.Marshal]::Copy([byte[]]$frame.ImageData,$offset,$data.Scan0,$pixels) } finally { $bitmap.UnlockBits($data) }; $bitmap.Save($file,[Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
        Save-ProProbe 'console-observed' @{ state = [string]$vm.State; image = $file; inputSent = $false }; exit 0
    }
    if ($Phase -eq 'host-state') {
        $vhd = Get-VHD -Path $machine.disk
        $boot = $guard.ReadCommand('boot-inputs.json') | ConvertFrom-Json
        $inputPath = [IO.Path]::GetFullPath([string]$boot.iso)
        if ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($inputPath)) -ne $directoryPath -or [IO.Path]::GetFileName($inputPath) -ne 'pro-boot.iso') { throw 'Boot input path changed' }
        $guard.PinInputFile($inputPath)
        Save-ProProbe 'inspected-host-state' @{ state = [string]$vm.State; diskIdentifier = [string]$vhd.DiskIdentifier; diskAttached = $vhd.Attached; bootIsoPresent = [IO.File]::Exists($boot.iso); dvdCount = @(Get-VMDvdDrive -VM $vm).Count; bootIsoHash = (Get-FileHash -LiteralPath $boot.iso -Algorithm SHA256).Hash.ToLowerInvariant() }
        exit 0
    }
    if ($vm.State -ne 'Running') { throw 'Pro VM must already be running' }
    $credential = [pscredential]::new([string]$credentials.adminUser, (ConvertTo-SecureString $credentials.adminPassword -AsPlainText -Force))
    $until = [DateTime]::UtcNow.AddMinutes(15)
    do {
        $candidate = $null
        try {
            $candidate = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
            if ($DifferentBootId) {
                $bootId = Invoke-Command -Session $candidate -ScriptBlock { (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o') }
                if ($bootId -eq $DifferentBootId) { throw 'The old Pro Windows session is still shutting down' }
            }
            return $candidate
        } catch {
            if ($candidate) { Remove-PSSession $candidate -ErrorAction SilentlyContinue }
            if ($guard.Owner.HasExited -or [DateTime]::UtcNow -gt $until) { throw 'Pro PowerShell Direct is not ready; VM retained' }
            Start-Sleep -Seconds 3
        }
    } while ($true)
}
try {
    $vm = Assert-ProFixture
    if ($Phase -eq 'package-logon' -and $vm.State -eq 'Off') { Start-VM -VM $vm | Out-Null }
    Save-ProProbe 'connecting'
    $session = Connect-ProGuest
    $initial = Invoke-Command -Session $session -ArgumentList $config.nonce -ScriptBlock {
        param($nonce)
        $ErrorActionPreference = 'Stop'
        $release = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        $setup = Get-ItemProperty 'HKLM:\SYSTEM\Setup'
        $logon = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
        $provisioned = Get-Content C:\MuLab\public\provisioned.json -Raw | ConvertFrom-Json
        if ($env:COMPUTERNAME -ne 'MU-PRO-LAB' -or $release.EditionID -ne 'Professional' -or $release.CurrentBuildNumber -ne '26300' -or $provisioned.nonce -ne $nonce) { throw 'Actual provisioned Pro guest required' }
        @{ edition = $release.EditionID; build = $release.CurrentBuildNumber; bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); utc = [DateTime]::UtcNow.ToString('o'); timeZone = [TimeZoneInfo]::Local.Id; interactiveUser = (Get-CimInstance Win32_ComputerSystem).UserName; hyperV = [string](Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State; sshPresent = (Test-Path -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe); oobe = $setup.OOBEInProgress; setupInProgress = $setup.SystemSetupInProgress; autoUser = $logon.DefaultUserName; autoDomain = $logon.DefaultDomainName; autoEnabled = $logon.AutoAdminLogon; autoCount = $logon.AutoLogonCount; userOrdinary = -not [bool]@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID -eq (Get-LocalUser -Name MuLabUser).SID }).Count }
    }
    if ($Phase -eq 'inspect') { Save-ProProbe 'inspected' $initial; exit 0 }
    if ($Phase -eq 'diagnostics') {
        $details = Invoke-Command -Session $session -ScriptBlock {
            $logs = @(); foreach ($name in @('build-stderr.log','build-stdout.log','before-reboot-broker-stderr.log','after-reboot-broker-stderr.log')) { $file = Join-Path C:\MuLab\private $name; if (Test-Path -LiteralPath $file) { $text = [IO.File]::ReadAllText($file); $logs += @{ name = $name; text = $text.Substring([Math]::Max(0,$text.Length-8000)) } } }
            @{ logs = $logs; nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.ExecutablePath -eq 'C:\MuLab\product\resources\node\node.exe' } | Select-Object ProcessId,ParentProcessId,CommandLine); tasks = @(Get-ScheduledTask -TaskName 'MuPro-*' -ErrorAction SilentlyContinue | Select-Object TaskName,State) }
        }
        Save-ProProbe 'diagnosed' @{ host = $initial; details = $details }; exit 0
    }
    if (-not $initial.userOrdinary -or $initial.oobe -ne 0 -or $initial.setupInProgress -ne 0) { throw 'Ordinary Pro profile and completed system setup required' }
    if ($Phase -eq 'ime-console') {
        if ($initial.interactiveUser -ne 'MU-PRO-LAB\MuLabUser') { throw 'Synthetic ordinary desktop required for IME observation' }
        Start-Process -FilePath (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'vmconnect.exe') -ArgumentList @('localhost',$machine.name) -WindowStyle Normal | Out-Null
        Save-ProProbe 'ime-console-requested' @{ complete = $true; scope = 'synthetic-Pro-console-launch-request'; windowsAuthenticationAutomated = $false }; exit 0
    }
    if($Phase.StartsWith('agentprobe-',[StringComparison]::Ordinal)){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-agentprobe-operator.ps1'))))
        $result=Invoke-ProAgentprobePhase $session $Phase $guard $config.nonce
        Save-ProProbe 'agentprobe-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -in @('soak-dispatch-repair','soak-dispatch-repair-finish')){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-soak-dispatch-repair.ps1'))))
        $result=Invoke-ProSoakDispatchRepair $session $guard $config.nonce $PSScriptRoot ($Phase -eq 'soak-dispatch-repair-finish')
        Save-ProProbe 'soak-dispatch-repaired' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -eq 'soak-offline'){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-soak-offline.ps1'))))
        $result=Invoke-ProSoakOffline $session $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'soak-offline-observed' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -eq 'soak-retire'){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-soak-retire.ps1'))))
        $result=Invoke-ProSoakRetire $session $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'soak-retired' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase.StartsWith('soak-',[StringComparison]::Ordinal)){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-soak-operator.ps1'))))
        $maximum=[Math]::Max([long]0,[long]([IO.DriveInfo]::new([IO.Path]::GetPathRoot([string]$machine.disk)).AvailableFreeSpace-64GB))
        $result=Invoke-ProSoakPhase $session $Phase $guard $config.nonce $maximum
        Save-ProProbe 'soak-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -in @('exchange-stage','exchange-stage-finish','exchange-run','exchange-inspect')){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-exchange-operator.ps1'))))
        $result=Invoke-ProExchangePhase $session $Phase $guard $config.nonce
        Save-ProProbe 'exchange-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -in @('compound-stage','compound-run','compound-recover','compound-inspect','compound-collect')){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-compound-operator.ps1'))))
        $maximum=[Math]::Min([long]128GB,[long]([IO.DriveInfo]::new([IO.Path]::GetPathRoot([string]$machine.disk)).AvailableFreeSpace-64GB))
        $result=Invoke-ProCompoundPhase $session $Phase $guard $config.nonce $maximum
        Save-ProProbe 'compound-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -in @('volume-stage','volume-run','volume-recover','volume-inspect','volume-console','volume-channel-probe','volume-offline-read','volume-durable-read','volume-preserve','volume-preserve-finish','volume-retire-stage','volume-retire','volume-collect')){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-volume-operator.ps1'))))
        $headroom=[IO.DriveInfo]::new([IO.Path]::GetPathRoot([string]$machine.disk)).AvailableFreeSpace-64GB
        $maximum=[Math]::Min([long]128GB,[long]$headroom)
        $result=Invoke-ProVolumePhase $session $Phase $guard $config.nonce $PSScriptRoot $maximum
        Save-ProProbe 'volume-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if($Phase -in @('upgrade-profile','upgrade-stage','upgrade-old-install','upgrade-old-seed','upgrade-install','upgrade-current','upgrade-reject','upgrade-uninstall','upgrade-cleanup','upgrade-audit','upgrade-permissions','upgrade-repair-fixture','upgrade-inspect')){
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-upgrade-operator.ps1'))))
        $result=Invoke-ProUpgradePhase $session $Phase $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'upgrade-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if ($Phase -in @('disk-stage','disk-run','disk-refresh','disk-refresh-continue','disk-resume','disk-inspect','disk-snapshot')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-disk-operator.ps1'))))
        Save-ProProbe 'running-disk-check' $initial
        $result = Invoke-ProDiskPhase $session $Phase $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'disk-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if ($Phase -in @('translation-stage','translation-run','translation-refresh','translation-inspect','translation-bind')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-image-operator.ps1'))))
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-translation-operator.ps1'))))
        Save-ProProbe 'running-translation-check' $initial
        $result = Invoke-ProTranslationPhase $session $Phase $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'translation-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if ($Phase -in @('ime-stage','ime-run','ime-inspect','ime-stop')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-ime-operator.ps1'))))
        $result = Invoke-ProImePhase $session $Phase $guard $config.nonce
        Save-ProProbe 'ime-result' $result
        if(-not $result.complete){exit 1};exit 0
    }
    if ($Phase -in @('audio-stage','audio-run','audio-refresh','audio-inspect')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-image-operator.ps1'))))
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-audio-operator.ps1'))))
        Save-ProProbe 'running-audio-check' $initial
        $result = Invoke-ProAudioPhase $session $Phase $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'audio-result' $result
        if (-not $result.complete) { exit 1 }; exit 0
    }
    if ($Phase -in @('image-stage','image-refresh','image-run','image-inspect')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-image-operator.ps1'))))
        Save-ProProbe 'running-image-check' $initial
        $result = Invoke-ProImagePhase $session $Phase $guard $config.nonce $PSScriptRoot
        Save-ProProbe 'image-result' $result
        if (-not $result.complete) { exit 1 }; exit 0
    }
    if ($Phase -in @('vmms-stage','vmms-run','vmms-recover','vmms-inspect')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-vmms-operator.ps1'))))
        Save-ProProbe 'running-vmms-check' $initial
        $result = Invoke-ProVmmsPhase $session $Phase $guard $config.nonce
        Save-ProProbe 'vmms-result' $result
        if (-not $result.complete) { exit 1 }; exit 0
    }
    if ($Phase -in @('package-stage','package-install','package-inventory','package-repair','package-uninstall','package-diagnostics','package-show-list','package-open-main')) {
        . ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'pro-package-operator.ps1'))))
        Save-ProProbe 'running-package-check' $initial
        $result = Invoke-ProPackagePhase $session $Phase $guard $directoryPath $config.nonce
        if (-not $result.complete) { Save-ProProbe 'package-failed' $result; exit 1 }
        if ($Phase -eq 'package-open-main') { Start-Process -FilePath (Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'vmconnect.exe') -ArgumentList @('localhost',$machine.name) -WindowStyle Normal | Out-Null }
        Save-ProProbe 'package-completed' $result; exit 0
    }
    if ($Phase -eq 'package-logon') {
        Invoke-Command -Session $session -ScriptBlock {
            if (@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*' }).Count) { throw 'Empty synthetic Pro guest required' }
            $c = Get-Content C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
            if ($c.user -ne 'MuLabUser') { throw 'Synthetic application user required' }
            $key = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
            Set-ItemProperty -LiteralPath $key -Name DefaultDomainName -Value 'MU-PRO-LAB'
            Set-ItemProperty -LiteralPath $key -Name DefaultUserName -Value $c.user
            Set-ItemProperty -LiteralPath $key -Name DefaultPassword -Value $c.userPassword
            Set-ItemProperty -LiteralPath $key -Name AutoAdminLogon -Value '1'
            Set-ItemProperty -LiteralPath $key -Name AutoLogonCount -Value 2 -Type DWord
        }
        Save-ProProbe 'package-synthetic-logon-restart'
        try { Invoke-Command -Session $session -ScriptBlock { Restart-Computer -Force } } catch [System.Management.Automation.Remoting.PSRemotingTransportException] {}
        Remove-PSSession $session -ErrorAction SilentlyContinue; $session = $null
        $session = Connect-ProGuest ([string]$initial.bootId)
        $until = [DateTime]::UtcNow.AddMinutes(4)
        do {
            $user = Invoke-Command -Session $session -ScriptBlock { (Get-CimInstance Win32_ComputerSystem).UserName }
            if ($user -eq 'MU-PRO-LAB\MuLabUser') { break }
            if ([DateTime]::UtcNow -gt $until) { throw 'Synthetic Pro desktop is not ready' }; Start-Sleep -Seconds 2
        } while ($true)
        Save-ProProbe 'package-ordinary-desktop-ready' @{ complete = $true; syntheticUser = 'MuLabUser'; hostRestarted = $false }; exit 0
    }
    if ($Phase -eq 'restart-check') {
        Invoke-Command -Session $session -ScriptBlock {
            if (@(Get-VM).Count -or @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*' }).Count) { throw 'Empty Pro VM with no servicing process required' }
        }
        Save-ProProbe 'restarting-empty-pro-test-vm'
        try { Invoke-Command -Session $session -ScriptBlock { Restart-Computer -Force } } catch [System.Management.Automation.Remoting.PSRemotingTransportException] {}
        Remove-PSSession $session -ErrorAction SilentlyContinue; $session = $null
        $session = Connect-ProGuest ([string]$initial.bootId)
        $until = [DateTime]::UtcNow.AddMinutes(4)
        do {
            $ready = Invoke-Command -Session $session -ScriptBlock { @{ bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'); vmms = (Get-Service vmms).Status -eq 'Running'; user = (Get-CimInstance Win32_ComputerSystem).UserName } }
            if ($ready.vmms -and $ready.user -eq 'MU-PRO-LAB\MuLabUser') { break }
            if ([DateTime]::UtcNow -gt $until) { throw 'Pro restarted but ordinary desktop or VMMS is not ready' }; Start-Sleep -Seconds 2
        } while ($true)
        if ($ready.bootId -eq $initial.bootId) { throw 'Old Pro boot accepted as a restart' }
        $count = Invoke-Command -Session $session -ScriptBlock { @(Get-VM).Count }
        if ($count) { throw 'Unexpected nested VM after restart' }
        Save-ProProbe 'restart-verified' @{ complete = $true; previousBootId = $initial.bootId; newBootId = $ready.bootId; vmmsReady = $true; ordinaryDesktopReady = $true; nestedGuests = [int]$count; hostRestarted = $false }; exit 0
    }
    if ($Phase -in @('collect-state','collect-stop')) {
        $collected = Invoke-Command -Session $session -ScriptBlock {
            $busy = @(Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith('C:\MuLab\public\package-',[StringComparison]::OrdinalIgnoreCase) -and $_.Name -in @('MuCodeSandbox Windows Preview.exe','node.exe')) -or $_.ExecutablePath -eq 'C:\MuLab\installers\current-preview.exe' -or ($_.CommandLine -like '*--host-once*' -and $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*') })
            if ($busy.Count) { throw 'Installed application or servicing is active; close it before stopping the Pro VM' }
            $count = @(Get-VM).Count
            if ($count) { throw 'Nested Pro test VMs remain; preserve the running guest' }
            $switches = @(Get-VMSwitch | Where-Object { $_.Name -match '^mu-win-[a-f0-9]{32}$' }).Count
            if ($switches) { throw 'Dedicated Linux switches remain' }
            $sid = (Get-LocalUser -Name MuLabUser).SID.Value
            $root = Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/' + $sid)
            $primary = Join-Path $root 'vms.json'; $backup = Join-Path $root 'vms.backup.json'
            $a = Get-Content -LiteralPath $primary -Raw | ConvertFrom-Json
            $b = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
            if ($a.version -ne 2 -or $b.version -ne 2 -or $a.ownerSid -ne $sid -or $b.ownerSid -ne $sid -or @($a.records.psobject.Properties).Count -or @($b.records.psobject.Properties).Count -or (Get-FileHash $primary).Hash -ne (Get-FileHash $backup).Hash -or @(Get-ChildItem -LiteralPath (Join-Path $root 'vms') -Force).Count) { throw 'Protected Pro registration or storage is not empty and consistent' }
            $meta = Get-Content -LiteralPath (Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin/current.json') -Raw | ConvertFrom-Json
            $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
            Set-ItemProperty -LiteralPath $winlogon -Name AutoAdminLogon -Value '0'
            Remove-ItemProperty -LiteralPath $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
            Set-ItemProperty -LiteralPath $winlogon -Name AutoLogonCount -Value 0 -Type DWord
            $listTask = Get-ScheduledTask -TaskName MuPro-package-show-list -ErrorAction SilentlyContinue
            if ($listTask) {
                if ($listTask.Actions.Execute -ne (Join-Path $env:SystemRoot 'System32/control.exe') -or $listTask.Actions.Arguments -ne '/name Microsoft.ProgramsAndFeatures') { throw 'Unknown list task preserved' }
                Unregister-ScheduledTask -TaskName MuPro-package-show-list -Confirm:$false
            }
            if ((Get-Service vmms).Status -ne 'Running') { throw 'Pro VMMS has not been restored' }
            $moduleHashes = @{}
            foreach ($name in @('broker','runtime','manager','session','service','config')) { $moduleHashes[$name] = (Get-FileHash -LiteralPath ('C:\MuLab\product\resources\app\dist-server\server\platform\windows\' + $name + '.js') -Algorithm SHA256).Hash.ToLowerInvariant() }
            return @{ nestedGuests = $count; privateSwitches = $switches; registrationCopiesEqual = $true; registeredGuests = 0; runtimeDirectories = 0; brokerSourceDigest = $meta.sourceDigest; backendModuleHashes = $moduleHashes; vmmsRunning = $true }
        }
        if($Phase -eq 'collect-state') {
            Save-ProProbe 'collected-with-test-desktop-preserved' @{independent=$collected;syntheticAutologonDisabled=$true;proVmRunning=((Assert-ProFixture).State -eq 'Running');networkDisconnected=$true;hostRestarted=$false};exit 0
        }
        Remove-PSSession $session; $session = $null
        $vm = Assert-ProFixture; Stop-VM -VM $vm -TurnOff -Force
        if ((Assert-ProFixture).State -ne 'Off') { throw 'Pro VM stop not confirmed' }
        Save-ProProbe 'collected-and-stopped' @{ independent = $collected; syntheticAutologonDisabled = $true; proVmOff = $true; networkDisconnected = $true; secureBoot = [string](Get-VMFirmware -VM $vm).SecureBoot; tpmEnabled = (Get-VMSecurity -VM $vm).TpmEnabled }; exit 0
    }
    if ($Phase -eq 'after-reboot') {
        $previous = Invoke-Command -Session $session -ScriptBlock {
            $r = Get-Content C:\MuLab\approved\before-reboot-result.json -Raw | ConvertFrom-Json
            if (-not $r.complete -or $r.after.operation.status -ne 'completed' -or $r.after.operation.changed -notcontains 'hyperv') { throw 'Successful Pro Hyper-V installation receipt required' }
            $sid = (Get-LocalUser -Name MuLabUser).SID.Value
            $job = Get-Content -LiteralPath (Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/' + $sid + '/host-components/job-' + $r.after.operation.id + '.json')) -Raw | ConvertFrom-Json
            if ($job.status -ne 'completed' -or $job.bootId -ne $r.before.bootId) { throw 'Protected Pro servicing job differs' }
            return $r
        }
        if ($initial.bootId -eq $previous.before.bootId) {
            Save-ProProbe 'restarting-only-the-pro-test-vm'
            $null = Assert-ProFixture
            try { Invoke-Command -Session $session -ScriptBlock { Restart-Computer -Force } } catch [System.Management.Automation.Remoting.PSRemotingTransportException] {}
            Remove-PSSession $session -ErrorAction SilentlyContinue; $session = $null
            Start-Sleep -Seconds 5
            $session = Connect-ProGuest ([string]$previous.before.bootId)
        }
    }
    Assert-ProLegacyPhase $Phase
    Save-ProProbe 'running-production-client' $initial
    $result = Invoke-Command -Session $session -ArgumentList $Phase,$config.stagedHashes -ScriptBlock {
        param($phase,$hashes)
        $ErrorActionPreference = 'Stop'
        foreach ($entry in $hashes.psobject.Properties) {
            $file = Join-Path C:\MuLab $entry.Name
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Staged Pro package changed' }
        }
        $node = 'C:\MuLab\product\resources\node\node.exe'
        $build = @'
import {buildBroker} from 'file:///C:/MuLab/product/resources/app/dist-server/server/platform/windows/broker.js';
import {writeFile} from 'node:fs/promises';
await writeFile('C:/MuLab/private/artifact.json',JSON.stringify(await buildBroker('C:/MuLab/private/build')));
'@
        [IO.File]::WriteAllText('C:\MuLab\private\build.mjs', $build)
        $buildProcess = Start-Process -FilePath $node -ArgumentList @('--no-warnings', 'C:\MuLab\private\build.mjs') -WindowStyle Hidden -RedirectStandardOutput C:\MuLab\private\build-stdout.log -RedirectStandardError C:\MuLab\private\build-stderr.log -PassThru -Wait
        if ($buildProcess.ExitCode -ne 0) { throw 'Pro production broker build failed; retain its private build log' }
        $artifact = Get-Content C:\MuLab\private\artifact.json -Raw | ConvertFrom-Json
        & ([ScriptBlock]::Create([IO.File]::ReadAllText('C:\MuLab\product\resources\app\dist-server\scripts\windows\install-broker.ps1'))) -Broker $artifact.broker -ExpectedBrokerHash $artifact.sha256 -Channel $artifact.channel -ExpectedChannelHash $artifact.channelSha256 -SourceDigest $artifact.sourceDigest
        $c = Get-Content C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
        $taskName = 'MuPro-' + $phase
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Prior Pro task must be inspected rather than restarted' }
        foreach ($name in @(($phase + '-owner.json'), ($phase + '-result.json'))) { if (Test-Path -LiteralPath (Join-Path C:\MuLab\public $name)) { throw 'Prior Pro client result must be inspected' } }
        $principal = New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME + '\' + $c.user) -LogonType Interactive -RunLevel Limited
        $action = New-ScheduledTaskAction -Execute $node -Argument ('--no-warnings C:\MuLab\client.mjs ' + $phase) -WorkingDirectory C:\MuLab\public
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(2)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
        Start-ScheduledTask -TaskName $taskName
        $ownerFile = 'C:\MuLab\public\' + $phase + '-owner.json'; $until = [DateTime]::UtcNow.AddMinutes(3)
        while (-not (Test-Path -LiteralPath $ownerFile)) { if ([DateTime]::UtcNow -gt $until) { throw 'Ordinary Pro client has not started; inspect its interactive desktop and actual task' }; Start-Sleep -Milliseconds 250 }
        $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
        $clientProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owner.pid)
        if ($owner.nonce -notmatch '^[a-f0-9]{64}$' -or $clientProcess.ExecutablePath -ne $node -or (Invoke-CimMethod -InputObject $clientProcess -MethodName GetOwnerSid).Sid -ne (Get-LocalUser -Name $c.user).SID.Value) { throw 'Pro client process binding changed' }
        $bin = Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin'
        $meta = Get-Content -LiteralPath (Join-Path $bin 'current.json') -Raw | ConvertFrom-Json
        $broker = Join-Path $bin $meta.brokerFile
        if ((Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.brokerSha256) { throw 'Protected Pro broker changed' }
        $agent = Start-Process -FilePath $broker -ArgumentList @('--owner', [string]$owner.pid, '--pipe', [string]$owner.nonce, '--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ('C:\MuLab\private\' + $phase + '-broker-stdout.log') -RedirectStandardError ('C:\MuLab\private\' + $phase + '-broker-stderr.log') -PassThru
        $resultFile = 'C:\MuLab\public\' + $phase + '-result.json'; $until = [DateTime]::UtcNow.AddMinutes(65)
        do {
            if (Test-Path -LiteralPath $resultFile) {
                $finished = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
                if ($finished.pid -ne $owner.pid -or $finished.nonce -ne $owner.nonce) { throw 'Pro client result binding changed' }
                if (-not $finished.complete) { throw ('Pro client failed: ' + $finished.error.message) }
                New-Item -ItemType Directory -Path C:\MuLab\approved -Force | Out-Null
                $acl = [Security.AccessControl.DirectorySecurity]::new()
                $acl.SetAccessRuleProtection($true, $false)
                foreach ($sid in @('S-1-5-18','S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
                [IO.Directory]::SetAccessControl('C:\MuLab\approved', $acl)
                [IO.File]::WriteAllText(('C:\MuLab\approved\' + $phase + '-result.json'), ($finished | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
                Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
                return $finished
            }
            if ($agent.HasExited) { throw 'Pro broker exited before a result; inspect its retained process logs' }
            if ([DateTime]::UtcNow -gt $until) { throw 'Pro servicing remains unconfirmed; do not restart or stop this VM' }
            Start-Sleep -Seconds 1
        } while ($true)
    }
    Save-ProProbe 'completed' $result
} catch {
    $failure = $_
    Save-ProProbe 'failed' @{ message = $failure.Exception.Message; stack = $failure.ScriptStackTrace }
    throw $failure
} finally {
    if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
    $guard.Dispose()
}
