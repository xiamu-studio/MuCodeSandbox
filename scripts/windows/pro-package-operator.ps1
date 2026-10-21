function Assert-ProPreInstallRetry {
    param([string]$CaseId, $Previous, $Process, [bool]$HasState, [bool]$RegistryPresent)
    $sameClient = $Process -and $Process.ExecutablePath -eq 'C:\MuLab\product\resources\node\node.exe' -and $Process.CommandLine -like '*pro-installed-client.mjs*'
    $checks = @($Previous.checks).Count
    if ($Previous.caseId -ne $CaseId -or $Previous.complete -ne $false -or $checks -or $sameClient -or $HasState -or $RegistryPresent) {
        throw ('Pre-install restage refused: ' + (@{sameCase=($Previous.caseId -eq $CaseId);complete=$Previous.complete;checks=$checks;sameClient=[bool]$sameClient;statePresent=$HasState;registryPresent=$RegistryPresent}|ConvertTo-Json -Compress))
    }
}
function Invoke-ProPackagePhase($Session, [string]$Phase, $Guard, [string]$Directory, [string]$ProNonce) {
    if ($Phase -eq 'package-diagnostics') {
        return Invoke-Command -Session $Session -ScriptBlock {
            $results = @(Get-ChildItem C:\MuLab\public -File -Filter 'package-*-result.json' | ForEach-Object { [IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json })
            $config = Get-Content C:\MuLab\approved\package-config.json -Raw | ConvertFrom-Json
            $directory = 'C:\MuLab\public\package-' + $config.caseId
            $trace = Join-Path $directory 'installer-trace.log'
            @{ complete = $true; results = $results; processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like 'C:\MuLab\*' } | Select-Object ProcessId,ParentProcessId,Name); trace = $(if(Test-Path -LiteralPath $trace){[IO.File]::ReadAllText($trace)}else{''}) }
        }
    }
    $packageInput = $Guard.ReadCommand('package-inputs.json') | ConvertFrom-Json
    if ($packageInput.format -ne 1 -or $packageInput.nonce -ne $ProNonce -or $packageInput.caseId -notmatch '^[a-f0-9]{32}$' -or $packageInput.revisionId -notmatch '^[a-f0-9]{32}$' -or $packageInput.zipSha256 -notmatch '^[a-f0-9]{64}$' -or $packageInput.installerSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Typed Pro package inputs required' }
    if ($Phase -eq 'package-stage') {
        foreach ($file in @($packageInput.zip,$packageInput.installer)) { $Guard.PinInputFile([string]$file) }
        if ((Get-FileHash -LiteralPath $packageInput.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $packageInput.zipSha256 -or (Get-FileHash -LiteralPath $packageInput.installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $packageInput.installerSha256) { throw 'Pro package inputs changed' }
        $target = 'C:\MuLab\private\package-' + $packageInput.revisionId + '.zip'
        Copy-Item -LiteralPath $packageInput.zip -Destination $target -ToSession $Session
        Copy-Item -LiteralPath $packageInput.installer -Destination C:\MuLab\installers\current-preview.exe -ToSession $Session
        $retryGuard = (Get-Command Assert-ProPreInstallRetry -CommandType Function).ScriptBlock.ToString()
        return Invoke-Command -Session $Session -ArgumentList $packageInput,$retryGuard -ScriptBlock {
            param($meta,$retryGuard)
            $retryCheck = [ScriptBlock]::Create($retryGuard)
            $ErrorActionPreference = 'Stop'
            $tools = 'C:\MuLab\package-tools\' + $meta.revisionId
            if (Test-Path -LiteralPath $tools) { throw 'Existing package staging must be inspected' }
            $userSid = (Get-LocalUser -Name MuLabUser).SID.Value
            if (Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $userSid + '\Software\Microsoft\Windows\CurrentVersion\Uninstall\e88eb670-5944-5236-81aa-7c1d3da3d6df')) { throw 'Existing user preview installation preserved' }
            $oldResult = 'C:\MuLab\public\package-install-result.json'
            if (Test-Path -LiteralPath $oldResult) {
                $old = [IO.File]::ReadAllText($oldResult) | ConvertFrom-Json
                $priorProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$old.pid)
                $hasState = Test-Path -LiteralPath ('C:\MuLab\public\package-' + $meta.caseId + '\state.json')
                & $retryCheck $meta.caseId $old $priorProcess $hasState $false
                $retained = 'C:\MuLab\private\package-rejected-' + [guid]::NewGuid().ToString('N')
                New-Item -ItemType Directory -Path $retained | Out-Null
                foreach ($name in @('package-install-owner.json','package-install-result.json')) {
                    $from = [IO.Path]::GetFullPath((Join-Path C:\MuLab\public $name)); $to = [IO.Path]::GetFullPath((Join-Path $retained $name))
                    if ([IO.Path]::GetDirectoryName($from) -ne 'C:\MuLab\public' -or [IO.Path]::GetDirectoryName($to) -ne $retained) { throw 'History retention boundary changed' }
                    if (Test-Path -LiteralPath $from) { [IO.File]::Move($from,$to) }
                }
            }
            $archive = 'C:\MuLab\private\package-' + $meta.revisionId + '.zip'
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256 -or (Get-FileHash C:\MuLab\installers\current-preview.exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.installerSha256) { throw 'Transferred installer or checks changed' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                $allowed = @('pro-programs-inventory.ps1','pro-retained-profile.mjs','pro-installed-client.mjs')
                if ($zip.Entries.Count -ne 3 -or @($zip.Entries | Where-Object { $_.FullName -notin $allowed }).Count) { throw 'Package check archive entries changed' }
            } finally { $zip.Dispose() }
            [IO.Compression.ZipFile]::ExtractToDirectory($archive,$tools)
            foreach ($entry in $meta.files.psobject.Properties) { if ((Get-FileHash -LiteralPath (Join-Path $tools $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Guest check file changed' } }
            $config = @{ caseId = $meta.caseId; tools = $tools; installer = 'C:/MuLab/installers/current-preview.exe'; installerSha256 = $meta.installerSha256; version = $meta.version; userSid = $userSid; clientSha256 = $meta.files.'pro-installed-client.mjs' }
            [IO.File]::WriteAllText('C:\MuLab\approved\package-config.json',($config | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
            @{ complete = $true; caseId = $meta.caseId; ordinaryUser = 'MuLabUser'; installerDigestVerified = $true }
        }
    }
    if ($Phase -eq 'package-show-list') {
        return Invoke-Command -Session $Session -ScriptBlock {
            $task = 'MuPro-package-show-list'
            if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { throw 'Prior list task must be inspected' }
            $principal = New-ScheduledTaskPrincipal -UserId 'MU-PRO-LAB\MuLabUser' -LogonType Interactive -RunLevel Limited
            $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/control.exe') -Argument '/name Microsoft.ProgramsAndFeatures'
            Register-ScheduledTask -TaskName $task -Action $action -Principal $principal | Out-Null
            Start-ScheduledTask -TaskName $task
            @{ complete = $true; ordinaryUser = 'MuLabUser'; viewRequested = $true; uninstallInvoked = $false }
        }
    }
    if ($Phase -eq 'package-open-main') {
        return Invoke-Command -Session $Session -ScriptBlock {
            $config = [IO.File]::ReadAllText('C:\MuLab\approved\package-config.json') | ConvertFrom-Json
            $root = 'C:\MuLab\public\package-' + $config.caseId
            $installed = [IO.Path]::GetFullPath((Join-Path $root '程序 O''Brien $ 测试\MuCodeSandbox Windows Preview'))
            if (-not $installed.StartsWith($root + '\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($installed) -ne 'MuCodeSandbox Windows Preview') { throw 'Installed application boundary changed' }
            $executable = Join-Path $installed 'MuCodeSandbox Windows Preview.exe'
            $expected = (Get-FileHash -LiteralPath 'C:\MuLab\product\MuCodeSandbox Windows Preview.exe' -Algorithm SHA256).Hash
            if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash -ne $expected) { throw 'Installed application changed' }
            $task = 'MuPro-package-main'
            if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { throw 'Prior actual desktop launch must be inspected' }
            $principal = New-ScheduledTaskPrincipal -UserId 'MU-PRO-LAB\MuLabUser' -LogonType Interactive -RunLevel Limited
            $action = New-ScheduledTaskAction -Execute $executable -WorkingDirectory $installed
            Register-ScheduledTask -TaskName $task -Action $action -Principal $principal | Out-Null
            Start-ScheduledTask -TaskName $task
            @{ complete = $true; scope = 'manual-desktop-launch-request'; ordinaryUser = 'MuLabUser'; launchRequested = $true; desktopReadyVerified = $false; windowsAuthenticationAutomated = $false }
        }
    }
    $verb = $Phase.Substring('package-'.Length)
    if ($verb -notin @('install','inventory','repair','uninstall')) { throw 'Unsupported Pro package check' }
    return Invoke-Command -Session $Session -ArgumentList $verb,$packageInput.caseId -ScriptBlock {
        param($verb,$caseId)
        $ErrorActionPreference = 'Stop'
        $config = Get-Content C:\MuLab\approved\package-config.json -Raw | ConvertFrom-Json
        if ($config.caseId -ne $caseId) { throw 'Pro check case changed' }
        $client = Join-Path $config.tools 'pro-installed-client.mjs'
        if ((Get-FileHash -LiteralPath $client -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.clientSha256) { throw 'Protected check client changed' }
        $task = 'MuPro-package-' + $verb
        $ownerFile = 'C:\MuLab\public\package-' + $verb + '-owner.json'; $resultFile = 'C:\MuLab\public\package-' + $verb + '-result.json'
        if ((Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $ownerFile) -or (Test-Path -LiteralPath $resultFile)) { throw 'Prior package check must be inspected before retrying' }
        $node = 'C:\MuLab\product\resources\node\node.exe'
        $principal = New-ScheduledTaskPrincipal -UserId 'MU-PRO-LAB\MuLabUser' -LogonType Interactive -RunLevel Limited
        $action = New-ScheduledTaskAction -Execute $node -Argument ('--no-warnings "' + $client + '" ' + $verb) -WorkingDirectory C:\MuLab\public
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(1)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
        Start-ScheduledTask -TaskName $task
        $until = [DateTime]::UtcNow.AddMinutes(3)
        while (-not (Test-Path -LiteralPath $ownerFile)) { if ([DateTime]::UtcNow -gt $until) { throw 'Ordinary package client has not started; keep its task for inspection' }; Start-Sleep -Milliseconds 250 }
        $owner = [IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owner.pid)
        if ($owner.caseId -ne $caseId -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $process.ExecutablePath -ne $node -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $config.userSid) { throw 'Package client process binding changed' }
        $until = [DateTime]::UtcNow.AddMinutes(25)
        do {
            if (Test-Path -LiteralPath $resultFile) {
                $result = [IO.File]::ReadAllText($resultFile) | ConvertFrom-Json
                if ($result.pid -ne $owner.pid -or $result.nonce -ne $owner.nonce -or $result.caseId -ne $caseId) { throw 'Package result binding changed' }
                Unregister-ScheduledTask -TaskName $task -Confirm:$false
                return $result
            }
            if ([DateTime]::UtcNow -gt $until) { throw 'Actual installer or its client is still unconfirmed; inspect before retrying' }
            Start-Sleep -Seconds 1
        } while ($true)
    }
}
