$lama = '1.2.5'; $baru = '1.2.6'
$p = Join-Path (Get-Location) 'package.json'
$b = [IO.File]::ReadAllBytes($p)
$bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
$off = if ($bom) { 3 } else { 0 }
$t = [Text.Encoding]::UTF8.GetString($b, $off, $b.Length - $off)
$re = [regex]('("version"\s*:\s*")' + [regex]::Escape($lama) + '(")')
if ($re.Matches($t).Count -ne 1) { throw 'versi lama tidak tepat satu kali' }
$t2 = $re.Replace($t, '${1}' + $baru + '${2}')
$enc = New-Object Text.UTF8Encoding($false)
$body = $enc.GetBytes($t2)
$out = if ($bom) { [byte[]](0xEF,0xBB,0xBF) + $body } else { $body }
[IO.File]::WriteAllBytes($p, $out)
git diff --numstat package.json
