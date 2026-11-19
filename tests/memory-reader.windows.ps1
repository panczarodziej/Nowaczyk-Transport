$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Core
. (Join-Path $PSScriptRoot '../telemetry-app/memory-reader.ps1')
$id=[Guid]::NewGuid().ToString('N')
$smallName='Local\NT-small-'+$id
$validName='Local\NTTelemetry1'
$small=$null;$valid=$null;$write=$null;$public=$null
try {
 $small=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew($smallName,4096)
 $public=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew('Local\SCSTelemetry',4096)
 $valid=[IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew($validName,32768)
 $write=$valid.CreateViewAccessor()
 $write.Write([long]0,[byte]1)
 $write.Write([long]40,[uint32]12)
 $write.Write([long]4303,[byte]1)
 $write.Write([long]4399,[byte]99)
 $bytes=Read-NowaczykTelemetryMemory -Names @($smallName,$validName)
 if($bytes.Length -ne 4400 -or $bytes[4303] -ne 1 -or $bytes[4399] -ne 99){throw 'Reader did not read complete delivery event after a short mapping'}
 $private=Read-NowaczykTelemetryMemory
 if($private[4303] -ne 1 -or $private.Length -ne 4400){throw 'Private mapping was blocked by public 4096-byte map'}
 $failed=$false
 try {Read-NowaczykTelemetryMemory -Names @($smallName) | Out-Null} catch {$failed=$true}
 if(-not $failed){throw 'Short memory mapping was incorrectly accepted'}
 $write.Write([long]40,[uint32]11)
 $failed=$false
 try {Read-NowaczykTelemetryMemory -Names @($validName) | Out-Null} catch {$failed=$true}
 if(-not $failed){throw 'Incompatible revision was accepted'}
 Write-Output 'PASS: complete event read, short mapping fallback, revision validation'
} finally {
 if($write){$write.Dispose()};if($valid){$valid.Dispose()};if($small){$small.Dispose()};if($public){$public.Dispose()}
}
