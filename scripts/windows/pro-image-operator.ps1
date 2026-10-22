function Assert-ProImageRetry($CaseId,$Previous,$Owner,[bool]$Busy,$VMs,$Ledger,$DiskPaths,[string]$Sid,[string]$Root) {
    if($Busy -or $Previous.caseId -ne $CaseId -or $Owner.caseId -ne $CaseId -or $Previous.complete -ne $false -or $Previous.nested.confirmedOff -ne $true -or $Previous.nested.removed -ne $false -or $Previous.pid -ne $Owner.pid -or $Previous.nonce -cne $Owner.nonce -or $Previous.nonce -cnotmatch '^[a-f0-9]{64}$'){throw 'Only a terminal failed image case with confirmed stop admits retry'}
    $id=[string]$Previous.nested.config.id;$platform=[string]$Previous.nested.platformId;$parsed=[guid]::Empty
    if(-not [guid]::TryParseExact($id,'D',[ref]$parsed) -or $parsed -eq [guid]::Empty -or $parsed.ToString('D') -cne $id){throw 'Canonical image environment identity required'}
    $name='mu-win-'+$id.Replace('-','');$record=$Ledger.records.$id
    if(@($VMs).Count -ne 1 -or [string]$VMs[0].Id -ne $platform -or $VMs[0].Name -ne $name -or $VMs[0].Notes -ne ('MuCodeSandbox Windows preview '+$name) -or [string]$VMs[0].State -ne 'Off' -or $Ledger.version -ne 2 -or $Ledger.ownerSid -ne $Sid -or @($Ledger.records.psobject.Properties).Count -ne 1 -or $record.ownerSid -ne $Sid -or $record.platformId -ne $platform -or @($DiskPaths).Count -ne 1 -or [IO.Path]::GetFullPath([string]$DiskPaths[0]) -ne [IO.Path]::GetFullPath((Join-Path $Root ('vms/'+$id+'/disk.vhdx')))){throw 'Only the exact registered, stopped image-test VM and original disk may be reused'}
    return $id
}
function Invoke-ProImagePhase($Session,[string]$Phase,$Guard,[string]$ProNonce,[string]$ScriptDirectory) {
    $meta = $Guard.ReadCommand('image-inputs.json') | ConvertFrom-Json
    if ($meta.format -ne 1 -or $meta.proNonce -ne $ProNonce -or $meta.caseId -notmatch '^[a-f0-9]{32}$' -or $meta.zipSha256 -notmatch '^[a-f0-9]{64}$' -or $meta.image.imageSha256 -notmatch '^[a-f0-9]{64}$') { throw 'Bound Pro image acceptance inputs required' }
    if($Phase -eq 'image-refresh'){
        $hashes=@{};$sources=@{}
        foreach($name in @('pro-image-client.mjs','pro-image-electron.cjs')){$file=Join-Path $ScriptDirectory $name;$Guard.PinInputFile($file);$sources[$name]=$file;$hashes[$name]=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
        $retryGuard=(Get-Command Assert-ProImageRetry -CommandType Function).ScriptBlock.ToString()
        $plan=Invoke-Command -Session $Session -ArgumentList $meta.caseId,$retryGuard -ScriptBlock {
            param($caseId,$retryGuard)
            $prefix='C:\MuLab\public\image-'+$caseId;$config=[IO.File]::ReadAllText(('C:\MuLab\approved\image-'+$caseId+'-config.json'))|ConvertFrom-Json
            if($config.caseId -ne $caseId -or (Get-ScheduledTask -TaskName ('MuPro-image-'+$caseId) -ErrorAction SilentlyContinue)){throw 'Existing image task must be inspected'}
            $actors=@(Get-CimInstance Win32_Process|Where-Object{($_.ExecutablePath -and $_.ExecutablePath.StartsWith($config.tools+'\',[StringComparison]::OrdinalIgnoreCase)) -or $_.ExecutablePath -like '*MuCodeSandbox-HyperVBroker-v1\bin\hv-broker-*.exe'})
            $retry=$null;$old=$null;$all=@(Get-VM)
            if(Test-Path -LiteralPath ($prefix+'-owner.json')){
                $old=[IO.File]::ReadAllText(('C:\MuLab\approved\image-'+$caseId+'-result.json'))|ConvertFrom-Json;$owner=[IO.File]::ReadAllText($prefix+'-owner.json')|ConvertFrom-Json
                $root=Join-Path $env:ProgramData ('MuCodeSandbox-HyperVBroker-v1/users/'+$config.userSid);$ledger=[IO.File]::ReadAllText((Join-Path $root 'vms.json'))|ConvertFrom-Json;$paths=@();if($all.Count -eq 1){$paths=@(Get-VMHardDiskDrive -VM $all[0]|ForEach-Object{$_.Path})}
                $retry=& ([ScriptBlock]::Create($retryGuard)) $caseId $old $owner ([bool]$actors.Count) $all $ledger $paths $config.userSid $root
            }elseif($actors.Count -or $all.Count -or (Test-Path -LiteralPath ($prefix+'-result.json'))){throw 'Only unused or explicitly verified stopped failed image diagnostics may be refreshed'}
            foreach($name in @('pro-image-client.mjs','pro-image-electron.cjs')){if((Get-FileHash -LiteralPath (Join-Path $config.tools $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.files.$name){throw 'Original protected diagnostic changed'}}
            return @{tools=[string]$config.tools;retry=$retry;oldNonce=$old.nonce;oldPid=$old.pid}
        }
        $tools=[string]$plan.tools;if($tools -ne ('C:\MuLab\image-tools\'+$meta.caseId)){throw 'Image diagnostic destination changed'}
        foreach($name in @('pro-image-client.mjs','pro-image-electron.cjs')){Copy-Item -LiteralPath $sources[$name] -Destination (Join-Path $tools $name) -ToSession $Session -Force}
        return Invoke-Command -Session $Session -ArgumentList $meta.caseId,$hashes,$plan -ScriptBlock {
            param($caseId,$hashes,$plan)
            $file='C:\MuLab\approved\image-'+$caseId+'-config.json';$config=[IO.File]::ReadAllText($file)|ConvertFrom-Json
            foreach($name in @('pro-image-client.mjs','pro-image-electron.cjs')){if((Get-FileHash -LiteralPath (Join-Path $config.tools $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$name]){throw 'Refreshed diagnostic differs'};$config.files.$name=$hashes[$name]}
            if($plan.retry){
                $prefix='C:\MuLab\public\image-'+$caseId;$old=[IO.File]::ReadAllText($prefix+'-result.json')|ConvertFrom-Json
                if($old.nonce -cne $plan.oldNonce -or $old.pid -ne $plan.oldPid -or $old.complete -ne $false){throw 'Failed image receipt changed during refresh'}
                $history='C:\MuLab\private\image-history-'+$caseId+'-'+[guid]::NewGuid().ToString('N');New-Item -ItemType Directory -Path $history|Out-Null
                foreach($name in @('owner.json','result.json','progress.json','launch.json','client.log','ui.png')){$from=[IO.Path]::GetFullPath($prefix+'-'+$name);$to=[IO.Path]::GetFullPath((Join-Path $history $name));if([IO.Path]::GetDirectoryName($from) -ne 'C:\MuLab\public' -or [IO.Path]::GetDirectoryName($to) -ne $history){throw 'Image history boundary changed'};if(Test-Path -LiteralPath $from){[IO.File]::Move($from,$to)}}
                [IO.File]::Copy(('C:\MuLab\approved\image-'+$caseId+'-result.json'),(Join-Path $history 'approved-result.json'))
                $config|Add-Member -NotePropertyName retryEnvironmentId -NotePropertyValue ([string]$plan.retry) -Force
            }
            [IO.File]::WriteAllText($file,($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false));return @{complete=$true;scope='verified-image-diagnostic-refresh';caseId=$caseId;hashes=$hashes;retryEnvironmentId=$plan.retry;productUnchanged=$true}
        }
    }
    if ($Phase -eq 'image-stage') {
        foreach ($file in @($meta.zip,$meta.image.image)) { $Guard.PinInputFile([string]$file) }
        if ((Get-FileHash -LiteralPath $meta.zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256 -or (Get-FileHash -LiteralPath $meta.image.image -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.image.imageSha256) { throw 'Image payload or synthetic base changed' }
        $target = 'C:\MuLab\private\image-' + $meta.caseId + '.zip'; $disk = 'C:\MuLab\images\image-' + $meta.caseId + '.vhdx'
        Invoke-Command -Session $Session -ArgumentList $target,$disk -ScriptBlock { param($target,$disk) if ((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $disk) -or @(Get-VM).Count -or (Get-Service vmms).Status -ne 'Running') { throw 'Empty Pro guest and fresh image payload required' } }
        Save-ProProbe 'copying-image-tools'
        Copy-Item -LiteralPath $meta.zip -Destination $target -ToSession $Session
        Save-ProProbe 'copying-synthetic-desktop-image'
        Copy-Item -LiteralPath $meta.image.image -Destination $disk -ToSession $Session
        Save-ProProbe 'verifying-image-payload'
        return Invoke-Command -Session $Session -ArgumentList $meta,$target,$disk -ScriptBlock {
            param($meta,$archive,$disk)
            $ErrorActionPreference='Stop';$tools='C:\MuLab\image-tools\'+$meta.caseId
            if (Test-Path -LiteralPath $tools) { throw 'Existing image payload must be inspected' }
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.zipSha256 -or (Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $meta.image.imageSha256) { throw 'Transferred image inputs changed' }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip=[IO.Compression.ZipFile]::OpenRead($archive)
            try {
                if ($zip.Entries.Count -gt 14000) { throw 'Image payload file limit exceeded' };[long]$bytes=0
                foreach ($entry in $zip.Entries) {
                    $name=$entry.FullName.Replace('\','/');$bytes+=$entry.Length
                    if ($bytes -gt 3GB -or $entry.Length -gt 512MB -or $name.Contains(':') -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object { $_ -in @('.','..') }).Count -or ($name -notmatch '^(product/|electron/|tools/)' -and $name -notin @('pro-image-client.mjs','pro-image-electron.cjs','local-fixtures.mjs','fixture-key.pem','fixture-cert.pem'))) { throw 'Unsafe image payload entry' }
                }
            } finally { $zip.Dispose() }
            [IO.Compression.ZipFile]::ExtractToDirectory($archive,$tools)
            foreach ($entry in $meta.files.psobject.Properties) { if ((Get-FileHash -LiteralPath (Join-Path $tools $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.Value) { throw 'Extracted image runtime changed' } }
            $config=@{caseId=$meta.caseId;proNonce=$meta.proNonce;tools=$tools;image=$disk;imageSha256=$meta.image.imageSha256;png=$meta.png;files=$meta.files;userSid=(Get-LocalUser MuLabUser).SID.Value}
            [IO.File]::WriteAllText(('C:\MuLab\approved\image-'+$meta.caseId+'-config.json'),($config|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
            @{complete=$true;staged=$true;osClipboardAccessed=$false}
        }
    }
    $response=Invoke-Command -Session $Session -ArgumentList $meta.caseId,$Phase -ScriptBlock {
        param($caseId,$phase)
        $ErrorActionPreference='Stop';$prefix='C:\MuLab\public\image-'+$caseId;$configFile='C:\MuLab\approved\image-'+$caseId+'-config.json'
        if($phase -eq 'image-inspect' -and -not(Test-Path -LiteralPath $configFile)){
            $archive='C:\MuLab\private\image-'+$caseId+'.zip';$disk='C:\MuLab\images\image-'+$caseId+'.vhdx'
            return @{complete=$true;staging=$true;archiveBytes=$(if(Test-Path -LiteralPath $archive){(Get-Item -LiteralPath $archive).Length}else{0});imageBytes=$(if(Test-Path -LiteralPath $disk){(Get-Item -LiteralPath $disk).Length}else{0});service=[string](Get-Service vmms).Status}
        }
        $config=[IO.File]::ReadAllText($configFile)|ConvertFrom-Json
        if ($config.caseId -ne $caseId) { throw 'Image test identity changed' }
        if ($phase -eq 'image-inspect') {
            $reports=@();foreach($name in @('progress','result')){$file=$prefix+'-'+$name+'.json';if(Test-Path -LiteralPath $file){$reports+=[IO.File]::ReadAllText($file)|ConvertFrom-Json}}
            $logs=@();foreach($name in @('client','broker-error')){$file=$prefix+'-'+$name+'.log';if($name -eq 'broker-error'){$file='C:\MuLab\private\image-'+$caseId+'-broker-error.log'};if(Test-Path -LiteralPath $file){$stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$reader=[IO.StreamReader]::new($stream);$text=$reader.ReadToEnd();$logs+=@{name=$name;tail=$text.Substring([Math]::Max(0,$text.Length-5000))}}finally{$stream.Dispose()}}}
            $app=Join-Path $config.tools 'product/resources/app';$hashes=@{}
            foreach($name in @('desktop/windows/main.cjs','desktop/windows/preload.cjs','desktop/windows/clipboard-image.cjs','desktop/clipboard-image.cjs','dist-server/server/platform/windows/service.js','dist-server/server/platform/windows/runtime.js','dist-server/server/platform/windows/manager.js','dist-server/server/platform/windows/session.js','dist-server/server/platform/windows/browser.js','dist-server/server/guest-exchange.js','dist-server/server/guest-image-clipboard.js','dist-server/server/clipboard-image.js','dist-server/shared/clipboard-image.js')){$hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $app $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
            $dist=Join-Path $app 'dist';foreach($file in @(Get-ChildItem -LiteralPath $dist -File -Recurse)){$relative='dist/'+$file.FullName.Substring($dist.Length+1).Replace('\','/');$hashes[$relative]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
            $release=[IO.File]::ReadAllText((Join-Path $app 'dist-server/windows-release.json'))|ConvertFrom-Json
            return @{complete=$true;caseId=$caseId;reports=$reports;logs=$logs;artifactHashes=$hashes;diagnosticHashes=@{'pro-image-client.mjs'=(Get-FileHash (Join-Path $config.tools 'pro-image-client.mjs')).Hash.ToLowerInvariant();'pro-image-electron.cjs'=(Get-FileHash (Join-Path $config.tools 'pro-image-electron.cjs')).Hash.ToLowerInvariant()};release=$release;service=[string](Get-Service vmms).Status;nodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object{$_.ExecutablePath -eq (Join-Path $config.tools 'product/resources/node/node.exe')}|Select-Object ProcessId,CreationDate,CommandLine);nested=@(Get-VM|ForEach-Object{@{name=$_.Name;id=[string]$_.Id;state=[string]$_.State}})}
        }
        if($phase -ne 'image-run' -or (-not $config.retryEnvironmentId -and @(Get-VM).Count) -or (Get-Service vmms).Status -ne 'Running'){throw 'Empty Pro guest or a verified stopped failed fixture required for the image run'}
        $ownerFile=$prefix+'-owner.json';$resultFile=$prefix+'-result.json';$task='MuPro-image-'+$caseId
        if((Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $ownerFile) -or (Test-Path -LiteralPath $resultFile)){throw 'An existing image run must be inspected, not restarted'}
        $node=Join-Path $config.tools 'product/resources/node/node.exe';$client=Join-Path $config.tools 'pro-image-client.mjs'
        foreach($name in @('pro-image-client.mjs','pro-image-electron.cjs','product/resources/node/node.exe','electron/electron.exe')){if((Get-FileHash -LiteralPath (Join-Path $config.tools $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.files.$name){throw 'Protected image client/runtime changed'}}
        $launch='$env:PSModulePath=Join-Path $PSHOME ''Modules''; & '''+$node+''' --no-warnings '''+$client+''' '+$caseId+' *> '''+$prefix+'-client.log'';exit $LASTEXITCODE';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launch))
        $principal=New-ScheduledTaskPrincipal -UserId 'MU-PRO-LAB\MuLabUser' -LogonType Interactive -RunLevel Limited;$action=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+$encoded) -WorkingDirectory C:\MuLab\public
        $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::FromHours(1)) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings|Out-Null;Start-ScheduledTask -TaskName $task
        $until=[DateTime]::UtcNow.AddMinutes(3);while(-not(Test-Path -LiteralPath $ownerFile)){if([DateTime]::UtcNow -gt $until){throw 'Image ordinary client has not started; retain its task'};Start-Sleep -Milliseconds 200}
        $owner=[IO.File]::ReadAllText($ownerFile)|ConvertFrom-Json;$process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$owner.pid)
        if($owner.caseId -ne $caseId -or $owner.nonce -notmatch '^[a-f0-9]{64}$' -or $process.ExecutablePath -ne $node -or (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid).Sid -ne $config.userSid){throw 'Image ordinary owner binding changed'}
        $handle=Get-Process -Id $owner.pid;$null=$handle.Handle;$bin=Join-Path $env:ProgramData 'MuCodeSandbox-HyperVBroker-v1/bin';$artifact=[IO.File]::ReadAllText((Join-Path $bin 'current.json'))|ConvertFrom-Json;$broker=Join-Path $bin $artifact.brokerFile
        if((Get-FileHash -LiteralPath $broker -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.brokerSha256){throw 'Protected image broker changed'}
        $agent=Start-Process -FilePath $broker -ArgumentList @('--owner',[string]$owner.pid,'--pipe',[string]$owner.nonce,'--detect-host') -WorkingDirectory $bin -WindowStyle Hidden -RedirectStandardOutput ('C:\MuLab\private\image-'+$caseId+'-broker-out.log') -RedirectStandardError ('C:\MuLab\private\image-'+$caseId+'-broker-error.log') -PassThru
        $until=[DateTime]::UtcNow.AddMinutes(25)
        do{
            if(Test-Path -LiteralPath $resultFile){$result=[IO.File]::ReadAllText($resultFile)|ConvertFrom-Json;if($result.pid -ne $owner.pid -or $result.nonce -cne $owner.nonce -or $result.caseId -ne $caseId){throw 'Image result owner changed'};[IO.File]::WriteAllText(('C:\MuLab\approved\image-'+$caseId+'-result.json'),($result|ConvertTo-Json -Depth 16),[Text.UTF8Encoding]::new($false));Unregister-ScheduledTask -TaskName $task -Confirm:$false;return $result}
            if($handle.HasExited){throw 'Image client exited without a result; retain its original resources and logs'}
            if([DateTime]::UtcNow -gt $until){throw 'Image run remains unconfirmed; inspect the actual processes before retrying'};Start-Sleep -Milliseconds 250
        }while($true)
    }
    if($Phase -eq 'image-inspect'){
        $encoded=Invoke-Command -Session $Session -ArgumentList $meta.caseId -ScriptBlock {
            param($caseId)
            $config=[IO.File]::ReadAllText(('C:\MuLab\approved\image-'+$caseId+'-config.json'))|ConvertFrom-Json;$file='C:\MuLab\public\image-'+$caseId+'-ui.png'
            if(-not(Test-Path -LiteralPath $file)){return $null}
            $info=Get-Item -LiteralPath $file
            if($info.PSIsContainer -or $info.Length -gt 10MB -or $info.Length -lt 33 -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [IO.File]::GetAccessControl($file).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $config.userSid){throw 'Only this synthetic user regular screenshot may be exported'}
            $bytes=[IO.File]::ReadAllBytes($file);if([Convert]::ToBase64String($bytes[0..7]) -ne 'iVBORw0KGgo='){throw 'Image screenshot is not PNG'}
            return [Convert]::ToBase64String($bytes)
        }
        if($encoded){$file=$Guard.Reserve('image-ui-'+[guid]::NewGuid().ToString('N')+'.png');[IO.File]::WriteAllBytes($file,[Convert]::FromBase64String($encoded));$response['screenshot']=$file}
    }
    return $response
}
