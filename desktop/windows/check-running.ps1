$ErrorActionPreference = 'Stop'
try {
    $installRoot = $env:MU_WINDOWS_INSTALL_ROOT
    if ([string]::IsNullOrWhiteSpace($installRoot)) { throw 'Installation directory missing' }
    $installRoot = [IO.Path]::GetFullPath($installRoot).TrimEnd([char]92) + [char]92
    $busy = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) -and
        $_.Name -in @('MuCodeSandbox Windows Preview.exe', 'node.exe')
    })
    if ($busy.Count) { exit 2 }
    exit 0
} catch {
    [Console]::Error.WriteLine('Unable to confirm Windows Preview is closed')
    exit 3
}
