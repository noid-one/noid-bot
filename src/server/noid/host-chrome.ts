/**
 * noid: the bots' browser as a real Google Chrome on the owner's own computer, with a profile of its own. Sites such as
 * X refuse a sign-in in the shared computer's browser (a container with a virtual screen) but take one here, where the
 * owner signs in by hand, as in any browser, and the bots then use it. Chrome listens for DevTools on a local port
 * (`--remote-debugging-port`, as rakazo's browser does, so nothing drives it while nobody uses it); a bot's server
 * reaches it through a bridge that speaks Chromium's pipe protocol (JSON, each message ended by a NUL byte) on its
 * stdin and stdout. From WSL that bridge is PowerShell on Windows: WSL's own network cannot reach Windows' localhost.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Where Chrome's DevTools listens on the owner's computer. */
export const HOST_CHROME_PORT = 9222;

/** PowerShell on Windows, from WSL; undefined anywhere else. */
export function windowsPowerShell(): string | undefined {
    const path = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

    return existsSync(path) ? path : undefined;
}

/**
 * The bridge, in PowerShell: Chrome started when it is not running (its profile in %LOCALAPPDATA%\noid\browser, kept
 * apart from the owner's everyday Chrome), then the browser's DevTools socket joined to stdin and stdout. A message
 * from Chrome is written as it arrives, in pieces, then its NUL: a screenshot is never held whole.
 */
function bridgeScript(port: number, open: string | undefined): string {
    return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$port = ${port}
$open = '${(open ?? "").replaceAll("'", "''")}'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${"$"}{env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$profileDir = Join-Path $env:LOCALAPPDATA 'noid\browser'
function Version { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/json/version").Content | ConvertFrom-Json } catch { $null } }
$version = Version
if (-not $version -or $open) {
    if (-not $chrome) { [Console]::Error.WriteLine('Google Chrome is not installed on this computer.'); exit 2 }
    $flags = @("--remote-debugging-port=$port", "--user-data-dir=""$profileDir""", '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows')
    if ($open) { $flags += $open }
    Start-Process -FilePath $chrome -ArgumentList $flags
    if ($open) { exit 0 }
    for ($i = 0; $i -lt 80 -and -not $version; $i++) { Start-Sleep -Milliseconds 250; $version = Version }
    if (-not $version) { [Console]::Error.WriteLine('Chrome did not start.'); exit 3 }
}
$none = [Threading.CancellationToken]::None
$socket = New-Object System.Net.WebSockets.ClientWebSocket
$socket.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
$socket.ConnectAsync([Uri]$version.webSocketDebuggerUrl, $none).Wait()
$in = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()
$inBuffer = New-Object byte[] 65536
$pending = New-Object System.IO.MemoryStream
$socketBuffer = New-Object byte[] 1048576
$reading = $in.ReadAsync($inBuffer, 0, $inBuffer.Length)
$receiving = $socket.ReceiveAsync([ArraySegment[byte]]::new($socketBuffer), $none)
while ($true) {
    $which = [Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($reading, $receiving))
    if ($which -eq 0) {
        $count = $reading.Result
        if ($count -le 0) { break }
        $start = 0
        while ($start -lt $count) {
            $end = [Array]::IndexOf($inBuffer, [byte]0, $start, $count - $start)
            if ($end -lt 0) { $pending.Write($inBuffer, $start, $count - $start); break }
            $pending.Write($inBuffer, $start, $end - $start)
            $socket.SendAsync([ArraySegment[byte]]::new($pending.ToArray()), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $none).Wait()
            $pending.SetLength(0)
            $start = $end + 1
        }
        $reading = $in.ReadAsync($inBuffer, 0, $inBuffer.Length)
    } else {
        $result = $receiving.Result
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { break }
        $out.Write($socketBuffer, 0, $result.Count)
        if ($result.EndOfMessage) { $out.WriteByte(0); $out.Flush() }
        $receiving = $socket.ReceiveAsync([ArraySegment[byte]]::new($socketBuffer), $none)
    }
}
`;
}

function run(powershell: string, script: string, stdio: "pipe" | "ignore"): ChildProcess {
    return spawn(
        powershell,
        [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
        ],
        { stdio: [stdio, stdio, "pipe"], windowsHide: true },
    );
}

/** The bridge to the owner's Chrome, started if it is not running: its stdin and stdout are the DevTools pipe. */
export function connectHostChrome(powershell: string, port = HOST_CHROME_PORT): ChildProcess {
    return run(powershell, bridgeScript(port, undefined), "pipe");
}

/**
 * Open a site in the owner's Chrome, in a window of its own on their screen, for them to sign in by hand: Chrome
 * starts if it is not running. Resolves once Chrome has it.
 */
export function openInHostChrome(
    powershell: string,
    url: string,
    port = HOST_CHROME_PORT,
): Promise<void> {
    const child = run(powershell, bridgeScript(port, url), "ignore");
    let errors = "";

    child.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
    });

    return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) =>
            code === 0
                ? resolve()
                : reject(new Error(errors.trim() || `Chrome could not open it (${code}).`)),
        );
    });
}
