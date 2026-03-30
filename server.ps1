param(
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootFullPath = [System.IO.Path]::GetFullPath($Root)
$Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)

function Get-ContentType([string]$Path) {
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".js" { return "application/javascript; charset=utf-8" }
    ".css" { return "text/css; charset=utf-8" }
    ".json" { return "application/json; charset=utf-8" }
    ".png" { return "image/png" }
    ".jpg" { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".svg" { return "image/svg+xml" }
    ".ico" { return "image/x-icon" }
    ".txt" { return "text/plain; charset=utf-8" }
    default { return "application/octet-stream" }
  }
}

function Send-Bytes([System.Net.Sockets.NetworkStream]$Stream, [int]$StatusCode, [string]$Reason, [byte[]]$Body, [string]$ContentType) {
  $Header =
    "HTTP/1.1 $StatusCode $Reason`r`n" +
    "Content-Type: $ContentType`r`n" +
    "Content-Length: $($Body.Length)`r`n" +
    "Connection: close`r`n" +
    "`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  $Stream.Write($Body, 0, $Body.Length)
}

function Send-Text([System.Net.Sockets.NetworkStream]$Stream, [int]$StatusCode, [string]$Reason, [string]$Body) {
  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  Send-Bytes -Stream $Stream -StatusCode $StatusCode -Reason $Reason -Body $Bytes -ContentType "text/plain; charset=utf-8"
}

try {
  $Listener.Start()
  Write-Host ""
  Write-Host "Deepfake OT Morph Lab"
  Write-Host "Serving: $RootFullPath"
  Write-Host "Open:    http://localhost:$Port/"
  Write-Host "Stop:    Ctrl+C"
  Write-Host ""

  while ($true) {
    $Client = $Listener.AcceptTcpClient()

    try {
      $Stream = $Client.GetStream()
      $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $RequestLine = $Reader.ReadLine()

      if ([string]::IsNullOrWhiteSpace($RequestLine)) {
        continue
      }

      while (($HeaderLine = $Reader.ReadLine()) -ne "") {
        if ($null -eq $HeaderLine) {
          break
        }
      }

      $Parts = $RequestLine.Split(" ")
      $Method = if ($Parts.Length -ge 1) { $Parts[0] } else { "" }
      $RawPath = if ($Parts.Length -ge 2) { $Parts[1] } else { "/" }

      if ($Method -ne "GET") {
        Send-Text -Stream $Stream -StatusCode 405 -Reason "Method Not Allowed" -Body "Only GET is supported."
        continue
      }

      $SafePath = [System.Uri]::UnescapeDataString(($RawPath.Split("?")[0]))
      if ([string]::IsNullOrWhiteSpace($SafePath) -or $SafePath -eq "/") {
        $SafePath = "/index.html"
      }

      $RelativePath = $SafePath.TrimStart("/") -replace "/", "\"
      $Candidate = Join-Path $RootFullPath $RelativePath
      $Resolved = [System.IO.Path]::GetFullPath($Candidate)

      if (-not $Resolved.StartsWith($RootFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text -Stream $Stream -StatusCode 403 -Reason "Forbidden" -Body "Forbidden"
        continue
      }

      if (-not (Test-Path -LiteralPath $Resolved -PathType Leaf)) {
        Send-Text -Stream $Stream -StatusCode 404 -Reason "Not Found" -Body "Not found"
        continue
      }

      $Bytes = [System.IO.File]::ReadAllBytes($Resolved)
      Send-Bytes -Stream $Stream -StatusCode 200 -Reason "OK" -Body $Bytes -ContentType (Get-ContentType $Resolved)
    } finally {
      if ($Reader) {
        $Reader.Dispose()
      }

      if ($Stream) {
        $Stream.Dispose()
      }

      $Client.Close()
    }
  }
} catch {
  Write-Host ""
  Write-Host "Server failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  Read-Host "Press Enter to close"
} finally {
  if ($Listener) {
    $Listener.Stop()
  }
}
