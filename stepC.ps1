$tgl = '2026-11-11'; $baru = '1.2.6'
$p = Join-Path (Get-Location) 'CHANGELOG.md'
$b = [IO.File]::ReadAllBytes($p)
$bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
$off = if ($bom) { 3 } else { 0 }
$t = [Text.Encoding]::UTF8.GetString($b, $off, $b.Length - $off)
$eol = if ($t.Contains("`r`n")) { "`r`n" } else { "`n" }
$h = '## [Belum dirilis]'
$a = '## [1.2.5] - 2026-11-05'
if ($t.IndexOf($h) -lt 0 -or $t.IndexOf($h) -ne $t.LastIndexOf($h)) { throw 'judul Belum dirilis tidak tepat satu' }
if ($t.IndexOf($a) -lt 0 -or $t.IndexOf($a) -ne $t.LastIndexOf($a)) { throw 'anchor 1.2.5 tidak tepat satu' }
$t2 = $t.Replace($h, "## [$baru] - $tgl")
$ia = $t2.IndexOf($a)
$bullet = '- README ditata ulang: tabel fitur, diagram alur guardian, dan panduan pemecahan masalah login dan guardian.' + $eol
$t2 = $t2.Insert($ia - $eol.Length, $bullet)
$enc = New-Object Text.UTF8Encoding($false)
$body = $enc.GetBytes($t2)
$out = if ($bom) { [byte[]](0xEF,0xBB,0xBF) + $body } else { $body }
[IO.File]::WriteAllBytes($p, $out)
git diff --numstat CHANGELOG.md
Get-Content CHANGELOG.md -TotalCount 14
Select-String -Path README.md,CHANGELOG.md -Pattern '\\\[|&|>|\\_'
