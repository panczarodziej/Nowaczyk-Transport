# Nowaczyk Transport - czytnik RenCloud v1.12.1 (Windows PowerShell 5.1)
# Tylko odczyt mapy Local\SCSTelemetry, wysylka do 127.0.0.1.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Core
. (Join-Path $PSScriptRoot 'memory-reader.ps1')
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
$lastLoaded=$false
$hadValidSample=$false
$lastJob=$null
$checkpointAt=[DateTime]::MinValue
$jobCheckpoint=Join-Path $logDir 'active-job.json'
try {
 if(Test-Path $jobCheckpoint) {
  $saved=Get-Content $jobCheckpoint -Raw | ConvertFrom-Json
  $lastJob=@{}
  foreach($property in $saved.PSObject.Properties){$lastJob[$property.Name]=$property.Value}
 }
} catch { $lastJob=$null }
# Nie tworz fikcyjnego zaladunku po samym starcie czytnika.
# Dostawa musi byc potwierdzona flaga z pluginu.

while($true) {
 try {
  $b=Read-NowaczykTelemetryMemory
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
  $loaded=$onJob -and ($b[1564] -ne 0)
  $event=''
  if($loaded -and -not $lastLoaded){$event='job-started'}
  if(($hadValidSample -or $lastJob) -and $delivered -and -not $lastDelivered){$event='job-delivered'}
  $payload=@{
   speedKmh=[math]::Round($speed,2)
   cargoMassKg=[math]::Round([math]::Max(0,$cargoMass),1)
   fuelLiters=[math]::Max(0,$fuel)
   odometerKm=[math]::Max(0,$odometer)
   cargoId=(S $b 2556)
   cargo=(S $b 2620)
   destinationCityId=(S $b 2684)
   destinationCity=(S $b 2748)
   destinationCompanyId=(S $b 2812)
   destinationCompany=(S $b 2876)
   sourceCityId=(S $b 2940)
   sourceCity=(S $b 3004)
   sourceCompanyId=(S $b 3068)
   sourceCompany=(S $b 3132)
   worldX=(F64 $b 2200)
   worldY=(F64 $b 2208)
   worldZ=(F64 $b 2216)
   onJob=$onJob
   cargoLoaded=$loaded
   paused=($b[4] -ne 0)
   event=$event
  }
  if($onJob -and $payload.cargo -and -not $delivered) {
   $lastJob=$payload.Clone()
   if($event -eq 'job-started' -or ((Get-Date)-$checkpointAt).TotalSeconds -ge 10) {
    $lastJob | ConvertTo-Json -Compress | Set-Content -Path ($jobCheckpoint+'.tmp') -Encoding UTF8
    Move-Item -Path ($jobCheckpoint+'.tmp') -Destination $jobCheckpoint -Force
    $checkpointAt=Get-Date
   }
  }
  if($event -eq 'job-delivered') {
   $distance=F32 $b 1460
   if($distance -gt 0 -and $distance -le 100000){$payload.jobDeliveredDistanceKm=$distance}
   if($lastJob) {
    foreach($key in @('cargo','cargoId','cargoMassKg','sourceCity','sourceCityId','sourceCompany','sourceCompanyId','destinationCity','destinationCityId','destinationCompany','destinationCompanyId')) {
     if(-not $payload[$key]){$payload[$key]=$lastJob[$key]}
    }
   }
  }
  $json=ConvertTo-Json -InputObject $payload -Compress -Depth 3
  Report 'Połączono z pamięcią telemetrii'
  Invoke-RestMethod -Uri 'http://127.0.0.1:38271/v1/telemetry' -Method Post -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 2 -ErrorAction Stop | Out-Null
  $hadValidSample=$true
  $lastDelivered=$delivered
  $lastLoaded=$loaded
  if($event -eq 'job-delivered'){$lastJob=$null;Remove-Item $jobCheckpoint -ErrorAction SilentlyContinue}
 } catch {
  Report ("Blad odczytu/wysylki: " + $_.Exception.Message)
 }
 Start-Sleep -Milliseconds 200
}

