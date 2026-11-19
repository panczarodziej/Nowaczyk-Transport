# RenCloud rev 12: fields through special_b end at byte 4399.
function Read-NowaczykTelemetryMemory {
 param([string[]]$Names=@('Local\NTTelemetry1'))
 $errors=New-Object 'System.Collections.Generic.List[string]'
 foreach($name in $Names) {
  $mapping=$null; $view=$null
  try {
   $mapping=[IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($name,[IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
   # Explicit Int64 length: do not infer the view length from the first memory region.
   $view=$mapping.CreateViewAccessor([long]0,[long]4400,[IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
   $bytes=New-Object byte[] 4400
   for($offset=0;$offset -lt 4400;$offset++){$bytes[$offset]=$view.ReadByte([long]$offset)}
   $revision=[BitConverter]::ToUInt32($bytes,40)
   if($revision -ne 12){throw "Nieobslugiwana rewizja: $revision (wymagana 12)"}
   return ,$bytes
  } catch {
   $errors.Add("${name}: $($_.Exception.Message)")
  } finally {
   if($null -ne $view){$view.Dispose()}
   if($null -ne $mapping){$mapping.Dispose()}
  }
 }
 throw ('Nie mozna odczytac 4400 bajtow RenCloud rev 12. '+($errors -join ' | '))
}
