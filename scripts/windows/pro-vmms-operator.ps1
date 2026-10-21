function Assert-ProVmmsRequest($Request, $Owner) {
    if ($Request.nonce -cne $Owner.nonce -or $Request.ownerPid -ne $Owner.pid -or $Owner.pid -lt 1 -or $Owner.nonce -cnotmatch '^[a-f0-9]{64}$' -or $Request.action -cnotin @('stop-vmms','restore-vmms')) { throw 'VMMS request binding changed' }
    if ($Request.action -eq 'stop-vmms') {
        foreach ($value in @($Request.id,$Request.platformId)) {
            $parsed = [guid]::Empty
            if (-not [guid]::TryParseExact([string]$value,'D',[ref]$parsed) -or $parsed -eq [guid]::Empty -or $parsed.ToString('D') -cne $value) { throw 'Canonical synthetic VM identity required' }
        }
    }
}
function Write-ProVmmsObservation([string]$File, $Observation) {
    [IO.File]::WriteAllText($File + '.next',($Observation | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $File) { [IO.File]::Replace($File + '.next',$File,[NullString]::Value) } else { [IO.File]::Move($File + '.next',$File) }
}
function Invoke-ProVmmsPhase($Session, [string]$Phase, $Guard, [string]$ProNonce) {
    $meta = $Guard.ReadCommand('vmms-inputs.json') | ConvertFrom-Json
    if ($meta.format -ne 1 -or $meta.nonce -ne $ProNonce -or $meta.caseId -notmatch '^[a-f0-9]{32}$' -or $meta.zipSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Bound VMMS fixture inputs required' }
    if ($Phase -eq 'vmms-stage') {
        $Guard.PinInputFile([string]$meta.zip)
        if ((Get-FileHash -LiteralPath $meta.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256) { throw 'VMMS check archive changed' }
        $target = 'C:\MuLab\private\vmms-' + $meta.caseId + '.zip'
        Copy-Item -LiteralPath $meta.zip -Destination $target -ToSession $Session
        return Invoke-Command -Session $Session -ArgumentList $meta -ScriptBlock {
            param($meta)
            $ErrorActionPreference = 'Stop'
            if ((Get-Service vmms).Status -ne 'Running') { throw 'Pro fixture with VMMS running required' }
            $runtimeCase = $meta.caseId
            if ($meta.retryCase) {
                if ($meta.retryCase -notmatch '^[a-f0-9]{32}$') { throw 'Typed failed case required' }
                $oldPrefix = 'C:\MuLab\public\vmms-' + $meta.retryCase
                $old = [IO.File]::ReadAllText($oldPrefix + '-run-result.json') | ConvertFrom-Json
                $oldOwner = [IO.File]::ReadAllText($oldPrefix + '-run-owner.json') | ConvertFrom-Json
                $oldProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$old.pid)
                $sameClient = $oldProcess -and $oldProcess.ExecutablePath -eq 'C:\MuLab\product\resources\node\node.exe' -and $oldProcess.CommandLine -like ('*' + $meta.retryCase + '*')
                if ($old.caseId -ne $meta.retryCase -or $oldOwner.caseId -ne $meta.retryCase -or $old.complete -ne $false -or $old.nonce -cnotmatch '^[a-f0-9]{64}$' -or $old.nonce -cne $oldOwner.nonce -or $old.pid -ne $oldOwner.pid -or $sameClient -or -not $old.nested.config.id) { throw 'Only a terminal failed synthetic case with retained configuration admits retry' }
                $oldTask = Get-ScheduledTask -TaskName ('MuPro-vmms-' + $meta.retryCase + '-run')
                if ($oldTask.State -eq 'Running') { throw 'The actual failed client task is still running' }
                $all = @(Get-VM); $id = [string]$old.nested.config.id; $name = 'mu-win-' + $id.Replace('-','')
                if ($id -notmatch '^[a-f0-9-]{36}$' -or $all.Count -ne 1 -or [string]$all[0].Id -ne $old.nested.platformId -or $all[0].Name -ne $name -or $all[0].Notes -ne ('MuCodeSandbox Windows preview ' + $name) -or $all[0].State -ne 'Off') { throw 'Only the exact stopped synthetic VM from the failed case may be reused' }
                [IO.File]::WriteAllText(('C:\MuLab\approved\vmms-' + $meta.retryCase + '-run-result.json'),($old | ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false))
                $previous = [IO.File]::ReadAllText(('C:\MuLab\approved\vmms-' + $meta.retryCase + '-config.json')) | ConvertFrom-Json
                $runtimeCase = $previous.runtimeCase
            } elseif (@(Get-VM).Count) { throw 'Empty Pro fixture required for a new synthetic allocation' }
            $tools = 'C:\MuLab\vmms-tools\' + $meta.caseId
            if (Test-Path -LiteralPath $tools) { throw 'Existing VMMS checks must be inspected' }
            $archive = 'C:\MuLab\private\vmms-' + $meta.caseId + '.zip'
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256) { throw 'Transferred VMMS checks changed' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                $allowed = @('pro-vmms-client.mjs','local-fixtures.mjs','fixture-key.pem','fixture-cert.pem')
                if ($zip.Entries.Count -ne 4 -or @($zip.Entries | Where-Object { $_.FullName -notin $allowed -or $_.Length -gt 2MB }).Count -or @($meta.files.psobject.Properties).Count -ne 4) { throw 'VMMS archive entries changed' }
            } finally { $zip.Dispose() }
            [IO.Compression.ZipFile]::ExtractToDirectory($archive,$tools)
            foreach ($name in $allowed) { if ((Get-FileHash -LiteralPath (Join-Path $tools $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.files.$name) { throw 'VMMS staged file changed' } }
            if (-not $runtimeCase) { $runtimeCase = $meta.retryCase }
            if ($runtimeCase -notmatch '^[a-f0-9]{32}$') { throw 'Typed runtime case required' }
            $settings = @{ caseId = $meta.caseId; retryCase = $meta.retryCase; runtimeCase = $runtimeCase; tools = $tools; clientSha256 = $meta.files.'pro-vmms-client.mjs'; userSid = (Get-LocalUser MuLabUser).SID.Value }
            [IO.File]::WriteAllText(('C:\MuLab\approved\vmms-' + $meta.caseId + '-config.json'),($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
            @{ complete = $true; staged = $true; serviceChanged = $false }
        }
    }
    $requestGuard = (Get-Command Assert-ProVmmsRequest -CommandType Function).ScriptBlock.ToString()
    $observationWriter = (Get-Command Write-ProVmmsObservation -CommandType Function).ScriptBlock.ToString()
    return Invoke-Command -Session $Session -ArgumentList $meta.caseId,$Phase,$requestGuard,$observationWriter -ScriptBlock {
        param($caseId,$phase,$requestGuard,$observationWriter)
        $ErrorActionPreference = 'Stop'
        $checkRequest = [ScriptBlock]::Create($requestGuard)
        $writeObservation = [ScriptBlock]::Create($observationWriter)
        $prefix = 'C:\MuLab\public\vmms-' + $caseId; $approved = 'C:\MuLab\approved\vmms-' + $caseId
        $settings = [IO.File]::ReadAllText($approved + '-config.json') | ConvertFrom-Json
        if ($settings.caseId -ne $caseId) { throw 'VMMS fixture settings changed' }
        if ($phase -eq 'vmms-inspect') {
            $reports = @(); foreach ($step in @('run','recover')) { $file = $prefix + '-' + $step + '-result.json'; if (Test-Path -LiteralPath $file) { $reports += [IO.File]::ReadAllText($file) | ConvertFrom-Json } }
            $tasks = @(Get-ScheduledTask -TaskName ('MuPro-vmms-' + $caseId + '-*') -ErrorAction SilentlyContinue | ForEach-Object { $info = Get-ScheduledTaskInfo -InputObject $_; @{ name = $_.TaskName; state = [string]$_.State; lastResult = $info.LastTaskResult; lastRun = $info.LastRunTime } })
            $logs = @(); foreach ($step in @('run','recover')) { $file = 'C:\MuLab\private\vmms-' + $caseId + '-' + $step + '-broker-error.log'; if (Test-Path -LiteralPath $file) { $stream = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); try { $reader = [IO.StreamReader]::new($stream); $value = $reader.ReadToEnd(); $logs += @{ phase = $step; tail = $value.Substring([Math]::Max(0,$value.Length-4000)) } } finally { $stream.Dispose() } } }
            $registration = Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/' + $settings.userSid + '/vms.json')
            $records = @(); if (Test-Path -LiteralPath $registration) { $ledger = [IO.File]::ReadAllText($registration) | ConvertFrom-Json; $records = @($ledger.records.psobject.Properties | ForEach-Object { @{ id = $_.Name; stage = $_.Value.stage; platformId = $_.Value.platformId } }) }
            $progress = @(); foreach ($step in @('run','recover')) { $file = $prefix + '-' + $step + '-progress.json'; if (Test-Path -LiteralPath $file) { $progress += [IO.File]::ReadAllText($file) | ConvertFrom-Json } }
            return @{ complete = $true; service = [string](Get-Service vmms).Status; results = $reports; progress = $progress; tasks = $tasks; logs = $logs; records = $records; processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq 'C:\MuLab\product\resources\node\node.exe' -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1*' } | Select-Object ProcessId,CreationDate,Name,CommandLine); nested = $(if((Get-Service vmms).Status -eq 'Running'){@(Get-VM | ForEach-Object { @{ name = $_.Name; id = [string]$_.Id; state = [string]$_.State } })}else{$null}) }
        }
        if ($phase -notin @('vmms-run','vmms-recover')) { throw 'Unsupported VMMS check' }
        if ((Get-Service vmms).Status -ne 'Running') { throw 'Unexpected stopped VMMS requires inspection, not a repeated test' }
        if ($phase -eq 'vmms-run' -and -not $settings.retryCase -and @(Get-VM).Count) { throw 'Empty Pro guest required before creating the synthetic allocation' }
        $step = $phase.Substring('vmms-'.Length); $task = 'MuPro-vmms-' + $caseId + '-' + $step
        $ownerFile = $prefix + '-' + $step + '-owner.json'; $resultFile = $prefix + '-' + $step + '-result.json'
        if ((Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $ownerFile) -or (Test-Path -LiteralPath $resultFile)) { throw 'An existing VMMS check must be inspected before retrying' }
        $node = 'C:\MuLab\product\resources\node\node.exe'; $client = Join-Path $settings.tools 'pro-vmms-client.mjs'
        if ((Get-FileHash -LiteralPath $client -Algorithm SHA256).Hash.ToLowerInvariant() -ne $settings.clientSha256) { throw 'Protected VMMS client changed' }
        $principal = New-ScheduledTaskPrincipal -UserId 'MU-PRO-LAB\MuLabUser' -LogonType Interactive -RunLevel Limited
        $launch = '$env:PSModulePath = Join-Path $PSHOME ''Modules''; & ''' + $node + ''' --no-warnings ''' + $client + ''' ' + $step + ' ' + $caseId + ' *> ''' + $prefix + '-' + $step + '-client.log''; exit $LASTEXITCODE'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launch))
        $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $encoded) -WorkingDirectory C:\MuLab\public
        $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(1)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $taskSettings | Out-Null
        Start-ScheduledTask -TaskName $task
        $until = [DateTime]::UtcNow.AddMinutes(3)
        while (-not (Test-Path -LiteralPath $ownerFile)) { if ([DateTime]::UtcNow -gt $until) { throw 'VMMS ordinary client has not started; retain its task' }; Start-Sleep -Milliseconds 200 }
        $owner = [IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$owner.pid)
        if ($owner.caseId -ne $caseId -or $owner.phase -ne $step -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $process.ExecutablePath -ne $node -or $process.CommandLine -notlike ('*' + $client + '*') -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $settings.userSid) { throw 'VMMS ordinary process binding changed' }
        $clientHandle = Get-Process -Id $owner.pid; $null = $clientHandle.Handle
        $bin = Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin'; $artifact = [IO.File]::ReadAllText((Join-Path $bin 'current.json')) | ConvertFrom-Json; $broker = Join-Path $bin $artifact.brokerFile
        if ((Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.brokerSha256) { throw 'Protected VMMS broker changed' }
        $privatePrefix = 'C:\MuLab\private\vmms-' + $caseId + '-' + $step
        $agent = Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',[string]$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ($privatePrefix + '-broker-out.log') -RedirectStandardError ($privatePrefix + '-broker-error.log') -PassThru
        $ownsOutage = $false; $restored = $false; $stoppedAt = $null; $worker = $null; $platformId = $null
        try {
            $until = [DateTime]::UtcNow.AddMinutes(20)
            do {
                $requestFile = $prefix + '-request.json'
                if ($step -eq 'run' -and (Test-Path -LiteralPath $requestFile)) {
                    $request = [IO.File]::ReadAllText($requestFile) | ConvertFrom-Json
                    & $checkRequest $request $owner
                    if ($request.action -eq 'stop-vmms' -and -not $ownsOutage) {
                        $all = @(Get-VM); $expectedName = 'mu-win-' + $request.id.Replace('-',''); $platformId = [string]$request.platformId
                        $root = Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/' + $settings.userSid)
                        $ledger = [IO.File]::ReadAllText((Join-Path $root 'vms.json')) | ConvertFrom-Json
                        $record = $ledger.records.($request.id); $expectedDisk = Join-Path $root ('vms/' + $request.id + '/disk.vhdx')
                        if ($all.Count -ne 1 -or [string]$all[0].Id -ne $platformId -or $all[0].Name -ne $expectedName -or $all[0].Notes -ne ('MuCodeSandbox Windows preview ' + $expectedName) -or $all[0].State -ne 'Running' -or $ledger.ownerSid -ne $settings.userSid -or @($ledger.records.psobject.Properties).Count -ne 1 -or $record.platformId -ne $platformId -or $record.ownerSid -ne $settings.userSid) { throw 'Only the exact registered synthetic VM may be affected by the guest VMMS outage' }
                        $drives = @(Get-VMHardDiskDrive -VM $all[0]); if ($drives.Count -ne 1 -or [IO.Path]::GetFullPath($drives[0].Path) -ne [IO.Path]::GetFullPath($expectedDisk)) { throw 'Synthetic disk boundary changed' }
                        $workers = @(Get-CimInstance Win32_Process -Filter "Name='vmwp.exe'" | Where-Object { $_.CommandLine -like ('*' + $platformId + '*') })
                        if ($workers.Count -ne 1) { throw 'Exact running VM worker required before VMMS interruption' }
                        $worker = Get-Process -Id $workers[0].ProcessId; $null = $worker.Handle
                        $service = Get-Service vmms; if ($service.Status -ne 'Running') { throw 'VMMS changed before the controlled outage' }
                        $ownsOutage = $true; $service.Stop(); $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(45)); $stoppedAt = [DateTime]::UtcNow
                        $receipt = @{ nonce = $owner.nonce; ownerPid = $owner.pid; service = 'Stopped'; platformId = $platformId; workerPid = $worker.Id; workerAlive = -not $worker.HasExited; time = $stoppedAt.ToString('o') }
                        [IO.File]::WriteAllText($approved + '-stopped.json',($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
                    }
                    if ($request.action -eq 'restore-vmms' -and -not $restored) {
                        if ($ownsOutage) { $service = Get-Service vmms; if ($service.Status -ne 'Running') { $service.Start(); $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(45)) } }
                        $state = $null; if ($platformId) { $state = Get-VM -Id ([guid]$platformId) }
                        $receipt = @{ nonce = $owner.nonce; ownerPid = $owner.pid; service = [string](Get-Service vmms).Status; platformId = $platformId; state = $(if($state){[string]$state.State}else{$null}); sameWorkerAlive = $(if($worker){-not $worker.HasExited}else{$false}); time = [DateTime]::UtcNow.ToString('o') }
                        [IO.File]::WriteAllText($approved + '-restored.json',($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false)); $restored = $true
                    }
                }
                if ($ownsOutage -and -not $restored) {
                    if ((Get-Service vmms).Status -ne 'Stopped') { throw 'Unexpected VMMS recovery interrupted the controlled outage' }
                    if (([DateTime]::UtcNow - $stoppedAt).TotalSeconds -gt 180) { throw 'Bounded VMMS outage expired; service will be restored independently' }
                    $observation = @{ nonce = $owner.nonce; ownerPid = $owner.pid; service = 'Stopped'; workerPid = $worker.Id; workerAlive = -not $worker.HasExited; time = [DateTime]::UtcNow.ToString('o') }
                    & $writeObservation ($approved + '-observed.json') $observation
                }
                if (Test-Path -LiteralPath $resultFile) {
                    $result = [IO.File]::ReadAllText($resultFile) | ConvertFrom-Json
                    if ($result.pid -ne $owner.pid -or $result.nonce -ne $owner.nonce -or $result.caseId -ne $caseId) { throw 'VMMS result process binding changed' }
                    [IO.File]::WriteAllText($approved + '-' + $step + '-result.json',($result | ConvertTo-Json -Depth 18),[Text.UTF8Encoding]::new($false))
                    Unregister-ScheduledTask -TaskName $task -Confirm:$false
                    return $result
                }
                if ($clientHandle.HasExited) { throw 'VMMS check client is terminal without a receipt; preserve allocation and logs' }
                if ([DateTime]::UtcNow -gt $until) { throw 'VMMS check still unconfirmed; preserve its processes and disk' }
                Start-Sleep -Milliseconds 100
            } while ($true)
        } finally {
            if ($ownsOutage) { $service = Get-Service vmms; if ($service.Status -ne 'Running') { $service.Start(); $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(45)) } }
        }
    }
}
