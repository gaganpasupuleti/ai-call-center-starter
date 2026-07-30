Add-Type -AssemblyName System.Speech
$outDir = Join-Path $PSScriptRoot '..\artifacts'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$wav = Join-Path $outDir 'welcome-src.wav'
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = -1
$synth.Volume = 100
$synth.SetOutputToWaveFile($wav)
$text = "Hi, hello! How are you doing today? Let's try this one."
$synth.Speak($text)
$synth.Dispose()
Write-Output "WAV_OK=$wav"
Get-Item $wav | ForEach-Object { Write-Output ("WAV_BYTES=" + $_.Length) }
