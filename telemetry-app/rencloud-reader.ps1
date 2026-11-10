# Nowaczyk Transport - czytnik RenCloud v1.12.1 (Windows PowerShell 5.1)
# Tylko odczyt mapy Local\SCSTelemetry, wysylka do 127.0.0.1.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Core
function F32($b,$o){ return [BitConverter]::ToSingle($b,$o) }
function F64($b,$o){ return [BitConverter]::ToDouble($b,$o) }
function S($b,$o,$n=64) {
  $s=[Text.Encoding]::UTF8.GetString($b,$o,$n)
  return $s.Split([char]0)[0].Trim()
}
$logDir=Join-Path $env:LOCALAPPDATA 'Nowaczyk Transport Telemetry'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath=Join-Path $logDir 'reader-diagnostics.log'
$lastError=''
function Report($message) {
 if($message -ne $script:lastError) {
  $script:lastError=$message
  [Console]::WriteLine($message)
  Add-Content -Path $logPath -Value ("$(Get-Date -Format o) $message") -Encoding UTF8
 }
}
Report 'Czytnik uruchomiony'
$lastDelivered=$false
$lastOnJob=$false
$hadValidSample=$false
$lastJob=$null
# Nie tworz fikcyjnego zaladunku po samym starcie czytnika.
# Dostawa musi byc potwierdzona flaga z pluginu.

while($true) {
 try {
  $mmf=$null
  foreach($name in @('Local\SCSTelemetry','SCSTelemetry','Global\SCSTelemetry')) {
   try { $mmf=[IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($name,[IO.MemoryMappedFiles.MemoryMappedFileRights]::Read); break } catch { }
  }
  if($null -eq $mmf) { throw 'Nie znaleziono mapy pamieci SCSTelemetry (DLL nie udostepnia danych)' }
  try {
   $view=$mmf.CreateViewAccessor(0,0,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
   try {
    if($view.Capacity -lt 4400) { throw "Za mala mapa pamieci: $($view.Capacity) bajtow" }
    $b=New-Object byte[] (4400)
    for($i=0;$i -lt $b.Length;$i++) { $b[$i]=$view.ReadByte($i) }
   } finally { $view.Dispose() }
  } finally { $mmf.Dispose() }
  if($b[0] -ne 1) { Report "Mapa dostepna, ale nieaktywna: pierwszy bajt=$($b[0])"; Start-Sleep -Seconds 2; continue }
  $rev=[BitConverter]::ToUInt32($b,40)
  if($rev -ne 12) { Report "Nieobslugiwana rewizja pluginu: $rev (czytnik oczekuje 12)"; Start-Sleep -Seconds 5; continue }
  # offsets from RenCloud scs-telemetry-common.hpp rev 12
  $speed=[math]::Abs((F32 $b 948)*3.6)
  $cargoMass=F32 $b 748
  $fuel=F32 $b 1000
  $odometer=F32 $b 1056
  $onJob=($b[4300] -ne 0)
  $delivered=($b[4303] -ne 0)
  $event=''
  if($hadValidSample -and $onJob -and -not $lastOnJob){$event='job-started'}
  if($hadValidSample -and $delivered -and -not $lastDelivered){$event='job-delivered'}
  $hadValidSample=$true
  $lastDelivered=$delivered
  $lastOnJob=$onJob
  $payload=@{
   speedKmh=[math]::Round($speed,2)
   cargoMassKg=[math]::Round([math]::Max(0,$cargoMass),1)
   fuelLiters=[math]::Max(0,$fuel)
   odometerKm=[math]::Max(0,$odometer)
   cargo=(S $b 2620)
   destinationCity=(S $b 2748)
   destinationCompany=(S $b 2876)
   sourceCity=(S $b 3004)
   sourceCompany=(S $b 3132)
   worldX=(F64 $b 2200)
   worldY=(F64 $b 2208)
   worldZ=(F64 $b 2216)
   onJob=$onJob
   cargoLoaded=($b[1564] -ne 0)
   paused=($b[4] -ne 0)
   event=$event
  }
  if($onJob -and $payload.cargo) { $lastJob=$payload.Clone() }
  if($event -eq 'job-delivered' -and $lastJob) {
   foreach($key in @('cargo','cargoMassKg','sourceCity','sourceCompany','destinationCity','destinationCompany')) { $payload[$key]=$lastJob[$key] }
  }
  $json=ConvertTo-Json -InputObject $payload -Compress -Depth 3
  Report 'Połączono z pamięcią telemetrii'
  Invoke-RestMethod -Uri 'http://127.0.0.1:38271/v1/telemetry' -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 2 | Out-Null
 } catch {
  Report ("Blad odczytu/wysylki: " + $_.Exception.Message)
 }
 Start-Sleep -Milliseconds 200
}
