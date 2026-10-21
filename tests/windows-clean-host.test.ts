import {test} from 'node:test';import path from 'node:path';
import {run} from '../server/process.ts';import {powershellPath,powershellArgs} from '../server/platform/windows/runtime.ts';

test('Clean Windows deployment accepts only its new exact-sized VHD and rejects host system disks',{skip:process.platform!=='win32'},async()=>{
 const file=path.resolve('scripts/windows/create-clean-host.ps1').replaceAll("'","''");
 await run(powershellPath(),powershellArgs(`$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid clean-host deployment source'}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-DiagnosticDisk'},$true)
if(-not $definition){throw 'Diagnostic disk guard missing'}
. ([ScriptBlock]::Create($definition.Extent.Text))
$disk=[pscustomobject]@{Number=12345};$diskFile='X:\\synthetic-lab\\windows.vhdx'
$script:kind='valid'
function Get-VHD {
 [CmdletBinding()]param([int]$DiskNumber)
 if($DiskNumber -ne 12345){throw 'Unexpected target disk'}
 if($script:kind -eq 'physical'){throw 'This is not an attached VHD'}
 [pscustomobject]@{Path=$(if($script:kind -eq 'other-vhd'){'X:\\somebody-else\\windows.vhdx'}else{$diskFile})}
}
function Get-Disk {
 [CmdletBinding()]param([int]$Number)
 if($Number -ne 12345){throw 'Unexpected target disk'}
 [pscustomobject]@{IsBoot=($script:kind -eq 'boot');IsSystem=($script:kind -eq 'system');Size=$(if($script:kind -eq 'wrong-size'){32GB}else{96GB})}
}
Assert-DiagnosticDisk
foreach($kind in @('physical','other-vhd','boot','system','wrong-size')){
 $script:kind=$kind;$rejected=$false;try{Assert-DiagnosticDisk}catch{$rejected=$true}
 if(-not $rejected){throw ('Deployment accepted an unrelated disk: '+$kind)}
}`),{timeoutMs:10000});
});
