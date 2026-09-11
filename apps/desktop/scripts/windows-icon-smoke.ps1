param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$Icon
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$actualIcon = $null
$expectedIcon = $null
$actual = $null
$expected = $null
try {
  $actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Executable).Path)
  if (!$actualIcon) { throw 'The Windows executable has no application icon' }
  $actual = $actualIcon.ToBitmap()
  $expectedIcon = [System.Drawing.Icon]::new((Resolve-Path -LiteralPath $Icon).Path, $actual.Size)
  $expected = $expectedIcon.ToBitmap()
  if ($actual.Size -ne $expected.Size) { throw 'Application icon dimensions do not match the source ICO' }
  for ($y = 0; $y -lt $actual.Height; $y++) {
    for ($x = 0; $x -lt $actual.Width; $x++) {
      $a = $actual.GetPixel($x, $y)
      $b = $expected.GetPixel($x, $y)
      # RGB under fully transparent pixels is not visible and may be normalized.
      if (($a.A -ne $b.A) -or (($a.A -ne 0) -and ($a.ToArgb() -ne $b.ToArgb()))) {
        throw "The executable contains a stale or incorrect application icon at ($x, $y)"
      }
    }
  }
  Write-Output 'Windows executable icon matches the current source ICO'
} finally {
  if ($actual) { $actual.Dispose() }
  if ($expected) { $expected.Dispose() }
  if ($actualIcon) { $actualIcon.Dispose() }
  if ($expectedIcon) { $expectedIcon.Dispose() }
}
