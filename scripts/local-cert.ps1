param([string]$Directory = '.local/phase2/tls')
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Directory))
[IO.Directory]::CreateDirectory($target) | Out-Null
if ((Test-Path (Join-Path $target 'cert.pem')) -and (Test-Path (Join-Path $target 'key.pem'))) { exit 0 }
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=PGS loopback development', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddIpAddress([Net.IPAddress]::Loopback)
  $req.CertificateExtensions.Add($san.Build())
  $cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddYears(1))
  try {
    [IO.File]::WriteAllText((Join-Path $target 'cert.pem'), $cert.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $target 'key.pem'), $rsa.ExportPkcs8PrivateKeyPem())
  } finally { $cert.Dispose() }
} finally { $rsa.Dispose() }