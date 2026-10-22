function Invoke-ProImePhase($Session,[string]$Phase,$Guard,[string]$ProNonce) {
    $meta=$Guard.ReadCommand('ime-inputs.json')|ConvertFrom-Json
    if($meta.format -ne 1 -or $meta.proNonce -ne $ProNonce -or $meta.caseId -notmatch '^[a-f0-9]{32}$' -or $meta.supportCase -notmatch '^[a-f0-9]{32}$' -or $meta.zipSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Bound IME fixture required'}
    if($Phase -eq 'ime-stage') {
        $Guard.PinInputFile([string]$meta.zip)
        if((Get-FileHash -LiteralPath $meta.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256){throw 'IME payload changed'}
        $archive='C:\MuLab\private\ime-'+$meta.caseId+'.zip'
        Copy-Item -LiteralPath $meta.zip -Destination $archive -ToSession $Session
        return Invoke-Command -Session $Session -ArgumentList $meta,$archive -ScriptBlock {
            param($meta,$archive)
            $ErrorActionPreference='Stop';$tools='C:\MuLab\ime-tools\'+$meta.caseId;$support='C:\MuLab\image-tools\'+$meta.supportCase
            if(@(Get-VM).Count -or (Test-Path -LiteralPath $tools)){throw 'Unused IME fixture and empty Pro guest required'}
            $base=[IO.File]::ReadAllText(('C:\MuLab\approved\image-'+$meta.supportCase+'-config.json'))|ConvertFrom-Json
            $electron=Join-Path $support 'electron/electron.exe'
            if($base.tools -ne $support -or (Get-FileHash -LiteralPath $electron -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.electronSha256 -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256){throw 'IME support or archive changed'}
            Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($archive)
            try {
                [long]$size=0;if($zip.Entries.Count -gt 100){throw 'IME payload file count exceeded'}
                foreach($entry in $zip.Entries){$name=$entry.FullName.Replace('\','/');$size+=$entry.Length;if($size -gt 30MB -or $entry.Length -gt 10MB -or $name.Contains(':') -or $name.StartsWith('/') -or @($name.Split('/')|Where-Object{$_ -in @('.','..')}).Count -or ($name -ne 'pro-ime-electron.cjs' -and -not $name.StartsWith('ui/'))){throw 'Unsafe IME payload entry'}}
            }finally{$zip.Dispose()}
            [IO.Compression.ZipFile]::ExtractToDirectory($archive,$tools)
            foreach($entry in $meta.files.psobject.Properties){if((Get-FileHash -LiteralPath (Join-Path $tools $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value){throw 'Staged IME bytes differ'}}
            $config=@{caseId=$meta.caseId;proNonce=$meta.proNonce;tools=$tools;support=$support;electron=$electron;electronSha256=$meta.electronSha256;files=$meta.files;sourceHashes=$meta.sourceHashes;userSid=(Get-LocalUser MuLabUser).SID.Value}
            [IO.File]::WriteAllText(('C:\MuLab\approved\ime-'+$meta.caseId+'-config.json'),($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
            return @{complete=$true;staged=$true;scope='native-IME-synthetic-receivers';vmCreated=$false}
        }
    }
    return Invoke-Command -Session $Session -ArgumentList $meta.caseId,$Phase -ScriptBlock {
        param($caseId,$phase)
        $ErrorActionPreference='Stop';$prefix='C:\MuLab\public\ime-'+$caseId;$task='MuPro-ime-'+$caseId
        $config=[IO.File]::ReadAllText(('C:\MuLab\approved\ime-'+$caseId+'-config.json'))|ConvertFrom-Json
        if($config.caseId -ne $caseId -or $config.tools -ne ('C:\MuLab\ime-tools\'+$caseId)){throw 'IME config changed'}
        if($phase -eq 'ime-run') {
            if((Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath ($prefix+'-state.json')) -or @(Get-VM).Count -or (Get-CimInstance Win32_ComputerSystem).UserName -ne 'MU-PRO-LAB\MuLabUser'){throw 'Unused ordinary-user desktop IME run required'}
            foreach($entry in $config.files.psobject.Properties){if((Get-FileHash -LiteralPath (Join-Path $config.tools $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value){throw 'IME input changed'}}
            if((Get-FileHash -LiteralPath $config.electron -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.electronSha256){throw 'IME Electron changed'}
            $action=New-ScheduledTaskAction -Execute $config.electron -Argument ('"'+(Join-Path $config.tools 'pro-ime-electron.cjs')+'" --pro-ime-case '+$caseId) -WorkingDirectory $config.tools
            $principal=New-ScheduledTaskPrincipal -UserId 'MU-PRO-LAB\MuLabUser' -LogonType Interactive -RunLevel Limited
            $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromMinutes(35)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings|Out-Null;Start-ScheduledTask -TaskName $task
            return @{complete=$true;launchRequested=$true;nativeImeTested=$false;windowsAuthenticationAutomated=$false}
        }
        $state=$null;if(Test-Path -LiteralPath ($prefix+'-state.json')){$state=[IO.File]::ReadAllText($prefix+'-state.json')|ConvertFrom-Json}
        $actors=@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'"|Where-Object{$_.ExecutablePath -eq $config.electron -and $_.CommandLine -like ('*'+$caseId+'*')}|Select-Object ProcessId,CreationDate,CommandLine)
        if($phase -eq 'ime-stop') {
            if(-not $state -or $state.caseId -ne $caseId){throw 'IME owner receipt required'}
            if(-not $state.stopped){
                $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$state.pid)
                if($owner.ExecutablePath -ne $config.electron -or $owner.CommandLine -notlike ('*'+$caseId+'*') -or (Invoke-CimMethod -InputObject $owner -MethodName GetOwnerSid).Sid -ne $config.userSid){throw 'IME owner identity changed'}
                $handle=Get-Process -Id $state.pid;$null=$handle.Handle
                [IO.File]::WriteAllText($prefix+'-stop.json','{}',[Text.UTF8Encoding]::new($false))
                if(-not $handle.WaitForExit(15000)){throw 'IME graceful exit unconfirmed'}
            }
            $state=[IO.File]::ReadAllText($prefix+'-state.json')|ConvertFrom-Json
            $remaining=@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'"|Where-Object{$_.ExecutablePath -eq $config.electron -and $_.CommandLine -like ('*'+$caseId+'*')})
            if(-not $state.stopped -or $remaining.Count){throw 'IME cleanup unconfirmed'}
            Unregister-ScheduledTask -TaskName $task -Confirm:$false
            return @{complete=$true;stopped=$true;state=$state;remainingActors=$remaining.Count}
        }
        if($phase -ne 'ime-inspect'){throw 'Unknown IME phase'}
        return @{complete=$true;state=$state;actors=$actors;task=@(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue|Select-Object TaskName,State);nestedCount=@(Get-VM).Count}
    }
}
