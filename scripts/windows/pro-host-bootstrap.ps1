# Consumed by the specialize pass inside the new isolated Pro VM only.
$ErrorActionPreference = 'Stop'
$computer = Get-CimInstance Win32_ComputerSystem
$release = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
if ($computer.Manufacturer -ne 'Microsoft Corporation' -or $computer.Model -ne 'Virtual Machine' -or $release.EditionID -ne 'Professional' -or $release.CurrentBuildNumber -ne '26300') { throw 'Fresh Hyper-V Pro guest required' }
$marker = Get-Content -LiteralPath C:\MuLab\private\deployment.json -Raw | ConvertFrom-Json
if ($marker.flavor -ne 'pro26300' -or $marker.nonce -notmatch '^[a-f0-9]{64}$') { throw 'Pro diagnostic deployment marker required' }
$credentials = Get-Content -LiteralPath C:\MuLab\private\credentials.json -Raw | ConvertFrom-Json
if ($credentials.adminUser -ne 'MuLabAdmin' -or $credentials.user -ne 'MuLabUser') { throw 'Only synthetic diagnostic accounts are allowed' }
foreach ($pair in @(@($credentials.adminUser, $credentials.adminPassword), @($credentials.user, $credentials.userPassword))) {
    if (Get-LocalUser -Name $pair[0] -ErrorAction SilentlyContinue) { throw 'Fresh synthetic account required' }
    New-LocalUser -Name $pair[0] -Password (ConvertTo-SecureString $pair[1] -AsPlainText -Force) -PasswordNeverExpires | Out-Null
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $pair[0]
}
Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $credentials.adminUser
$user = Get-LocalUser -Name $credentials.user
if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID -eq $user.SID }).Count) { throw 'Synthetic application user must remain ordinary' }
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($user.SID)
foreach ($value in @($user.SID.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
[IO.Directory]::SetAccessControl('C:\MuLab\public', $acl)
$result = @{ nonce = $marker.nonce; edition = $release.EditionID; build = $release.CurrentBuildNumber; localSyntheticAccounts = $true; ordinaryApplicationUser = $true; networkRequired = $false; time = [DateTime]::UtcNow.ToString('o') }
[IO.File]::WriteAllText('C:\MuLab\public\provisioned.json', ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
