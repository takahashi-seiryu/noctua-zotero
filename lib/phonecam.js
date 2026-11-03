"use strict";

// Take a photo with the iPhone and have it appear as a chat attachment.
//
// While the chat's "iPhone" popover is open, a small web server listens on this computer. Its address is the
// computer's Tailscale address, so the traffic stays inside the encrypted tailnet and works from any network.
// The popover shows a QR code with a one-time address; scanning it opens a page on the iPhone that takes
// photos and posts them here. Only peers on the tailnet (100.64.0.0/10) are served, and every request needs
// the session's random token.
var NoctuaPhoneCamera = {
  MAX_PHOTO_BYTES: 10 * 1024 * 1024,
  MAX_HEADER_BYTES: 16 * 1024,
  IDLE_MS: 10 * 60 * 1000,
  MAX_BAD_REQUESTS: 10,

  // ---- pure helpers (unit-tested in node)
  isTailnetAddress(address) {
    const match = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(String(address || ""));
    if (!match) return false;
    const [a, b] = [Number(match[1]), Number(match[2])];
    return a === 100 && b >= 64 && b <= 127;
  },
  isLoopback(address) { return /^(?:::ffff:)?127\.\d+\.\d+\.\d+$|^::1$/i.test(String(address || "")); },
  sameToken(given, expected) {
    if (typeof given !== "string" || typeof expected !== "string" || given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  },
  // Header block (bytes up to and including the blank line) -> {method, path, query, headers}; null if malformed.
  parseHead(text) {
    const lines = String(text).split("\r\n");
    const request = /^(GET|POST|HEAD|OPTIONS) (\/[^ ]*) HTTP\/1\.[01]$/.exec(lines[0] || "");
    if (!request) return null;
    const headers = {};
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const at = line.indexOf(":");
      if (at < 1) return null;
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    const [path, query = ""] = request[2].split("?");
    return {method: request[1], path, query, headers};
  },
  // The token is the first path segment: /<token>/ is the page, /<token>/up takes a photo.
  route(head, token) {
    const parts = head.path.split("/");   // ["", token, rest...]
    if (parts.length < 2 || !this.sameToken(parts[1], token)) return {kind: "denied"};
    const rest = parts.slice(2).join("/");
    if (head.method === "GET" && rest === "") return {kind: "page"};
    if (head.method === "POST" && rest === "up") return {kind: "upload"};
    return {kind: "missing"};
  },
  isJPEG(bytes) { return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; },
  photoName(query, index) {
    const raw = /(?:^|&)name=([^&]*)/.exec(query || "")?.[1] || "";
    let name = "";
    try { name = decodeURIComponent(raw); } catch (_) {}
    name = name.replace(/[^\w.-]/g, "").replace(/\.+/g, ".").slice(0, 40);
    return /\.jpe?g$/i.test(name) ? name : `iphone-photo-${index}.jpg`;
  },
  base64(bytes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + (i + 1 < bytes.length ? chars[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? chars[n & 63] : "=");
    }
    return out;
  },
  page() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>Noctua camera</title>
<style>
:root{color-scheme:light dark;font:17px -apple-system,system-ui,sans-serif}
body{margin:0;padding:max(20px,env(safe-area-inset-top)) 20px 28px;display:flex;flex-direction:column;gap:14px;min-height:100vh;box-sizing:border-box}
h1{font-size:19px;margin:4px 0 0}p{margin:0;opacity:.7;font-size:15px}
label.btn{display:block;text-align:center;padding:18px;border-radius:14px;font-weight:600;background:#3e63dd;color:#fff}
label.alt{background:transparent;color:inherit;border:1px solid #8886}
input{display:none}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
li{display:flex;gap:10px;align-items:center;font-size:15px}li img{width:44px;height:44px;border-radius:8px;object-fit:cover}
li span{flex:1}.ok{color:#30a46c}.bad{color:#e5484d}
</style></head><body>
<h1>Send photos to Noctua</h1>
<p>Photos go straight into the chat on your computer.</p>
<label class="btn">Take a photo<input id="cam" type="file" accept="image/*" capture="environment"></label>
<label class="btn alt">Choose from library<input id="lib" type="file" accept="image/*" multiple></label>
<ul id="list"></ul>
<script>
const token = location.pathname.split("/")[1], list = document.getElementById("list");
let count = 0;
async function shrink(file) {
  const bitmap = await createImageBitmap(file, {imageOrientation: "from-image"});
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.86));
}
async function send(file) {
  const li = document.createElement("li"), thumb = document.createElement("img"), text = document.createElement("span");
  thumb.src = URL.createObjectURL(file); text.textContent = "Sending…"; li.append(thumb, text); list.prepend(li);
  try {
    const blob = await shrink(file);
    const response = await fetch("/" + token + "/up?name=photo-" + (++count) + ".jpg", {method: "POST", body: blob});
    if (!response.ok) throw new Error(response.status === 404 ? "This session ended. Open a new QR code on the computer." : "Not sent (" + response.status + ")");
    text.textContent = "Sent"; text.className = "ok";
  } catch (error) { text.textContent = String(error.message || error); text.className = "bad"; }
}
for (const id of ["cam", "lib"]) document.getElementById(id).addEventListener("change", event => {
  for (const file of event.target.files) send(file); event.target.value = "";
});
</script></body></html>`;
  },

  // ---- the server (Gecko sockets)
  create({Cc, Ci, Services, Subprocess, Zotero, IOUtils, allowPeer, address, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout}) {
    const self = NoctuaPhoneCamera;
    let session = null;

    // This computer's Tailscale IPv4 address, or null if Tailscale is not installed/running.
    async function tailscaleAddress() {
      if (address) return address;
      const candidates = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/bin/tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];
      for (const command of candidates) {
        try {
          if (!(await IOUtils.exists(command))) continue;
          const proc = await Subprocess.call({command, arguments: ["ip", "-4"], stderr: "ignore"});
          let out = "", chunk;
          while ((chunk = await proc.stdout.readString())) out += chunk;
          const ip = out.trim().split(/\s+/)[0];
          if (self.isTailnetAddress(ip)) return ip;
        } catch (_) {}
      }
      return null;
    }

    function stop() {
      if (!session) return;
      const current = session; session = null;
      clearTimeout(current.timer);
      try { current.server.close(); } catch (_) {}
      for (const connection of [...current.connections]) connection.close();
    }

    function respond(connection, status, body = "", type = "text/plain; charset=utf-8") {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const head = `HTTP/1.1 ${status}\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n`
        + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n"
        + (type.startsWith("text/html") ? "Content-Security-Policy: default-src 'none'; img-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'\r\n" : "")
        + "\r\n";
      try {
        connection.out.writeByteArray([...new TextEncoder().encode(head), ...bytes]);
      } catch (_) {}
      connection.close();
    }

    function accept(current, transport) {
      let peer = "";
      try { peer = transport.getScriptablePeerAddr().address; } catch (_) {}
      if (!(self.isTailnetAddress(peer) || allowPeer?.(peer))) { try { transport.close(0); } catch (_) {} return; }
      if (current.connections.size >= 8) { try { transport.close(0); } catch (_) {} return; }

      const input = transport.openInputStream(0, 0, 0);
      const output = transport.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
      const binaryIn = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
      binaryIn.setInputStream(input);
      const binaryOut = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
      binaryOut.setOutputStream(output);
      let closed = false, buffer = new Uint8Array(0), head = null, headEnd = 0, bodyLength = 0;
      const connection = {
        out: binaryOut,
        close() {
          if (closed) return; closed = true;
          clearTimeout(deadline); current.connections.delete(connection);
          try { binaryOut.close(); } catch (_) {}
          try { binaryIn.close(); } catch (_) {}
          try { transport.close(0); } catch (_) {}
        }
      };
      const deadline = setTimeout(() => connection.close(), 30000);
      current.connections.add(connection);

      const bad = () => {
        if (++current.bad >= self.MAX_BAD_REQUESTS) { stop(); return; }
      };
      function handle() {
        const found = head ? null : findHeadEnd(buffer);
        if (!head && found < 0) {
          if (buffer.length > self.MAX_HEADER_BYTES) { bad(); respond(connection, "431 Request Header Fields Too Large"); }
          return false;
        }
        if (!head) {
          headEnd = found;
          head = self.parseHead(new TextDecoder().decode(buffer.subarray(0, headEnd)));
          if (!head) { bad(); respond(connection, "400 Bad Request"); return true; }
          bodyLength = Number(head.headers["content-length"] || 0);
          if (!Number.isInteger(bodyLength) || bodyLength < 0) { bad(); respond(connection, "400 Bad Request"); return true; }
        }
        const route = self.route(head, current.token);
        if (route.kind === "denied") { bad(); respond(connection, "404 Not Found", "not found"); return true; }
        if (route.kind === "page") { respond(connection, "200 OK", self.page(), "text/html; charset=utf-8"); return true; }
        if (route.kind !== "upload") { respond(connection, "404 Not Found", "not found"); return true; }
        if (bodyLength <= 0 || bodyLength > self.MAX_PHOTO_BYTES) { respond(connection, "413 Payload Too Large", "Photo is too large"); return true; }
        if (buffer.length - headEnd < bodyLength) return false;
        const body = buffer.subarray(headEnd, headEnd + bodyLength);
        if (!self.isJPEG(body)) { respond(connection, "415 Unsupported Media Type", "Only JPEG photos are accepted"); return true; }
        current.count += 1;
        resetIdle(current);
        try {
          current.onPhoto({name: self.photoName(head.query, current.count), type: "image/jpeg", data: self.base64(body)});
        } catch (error) { Zotero.logError(error); }
        respond(connection, "200 OK", "ok");
        return true;
      }
      function findHeadEnd(bytes) {
        for (let i = 3; i < bytes.length && i < self.MAX_HEADER_BYTES + 4; i++) {
          if (bytes[i - 3] === 13 && bytes[i - 2] === 10 && bytes[i - 1] === 13 && bytes[i] === 10) return i + 1;
        }
        return -1;
      }
      const watcher = {
        onInputStreamReady(stream) {
          if (closed) return;
          try {
            const available = binaryIn.available();
            if (available > 0) {
              const chunk = Uint8Array.from(binaryIn.readByteArray(Math.min(available, 262144)));
              const joined = new Uint8Array(buffer.length + chunk.length);
              joined.set(buffer); joined.set(chunk, buffer.length); buffer = joined;
            }
          } catch (_) { connection.close(); return; }
          let done = false;
          try { done = handle(); } catch (error) { Zotero.logError(error); connection.close(); return; }
          if (!done && !closed) stream.asyncWait(watcher, 0, 0, Services.tm.mainThread);
        }
      };
      input.QueryInterface(Ci.nsIAsyncInputStream).asyncWait(watcher, 0, 0, Services.tm.mainThread);
    }

    function resetIdle(current) {
      clearTimeout(current.timer);
      current.timer = setTimeout(() => { if (session === current) stop(); current.onEnd?.(); }, self.IDLE_MS);
    }

    // Start a session. Resolves {url, port, stop}; rejects with a readable error if Tailscale is unavailable.
    async function start(onPhoto, {onEnd} = {}) {
      stop();
      const host = await tailscaleAddress();
      if (!host) throw new Error("Tailscale was not found. Install Tailscale on this computer and your iPhone, sign in to the same account, and try again.");
      const bytes = new Uint8Array(16);
      (globalThis.crypto || Services.wm.getMostRecentWindow("navigator:browser").crypto).getRandomValues(bytes);
      const token = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
      const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      server.init(-1, false, -1);
      const current = session = {server, token, onPhoto, onEnd, connections: new Set(), count: 0, bad: 0, timer: null};
      server.asyncListen({
        onSocketAccepted(_server, transport) { if (session === current) accept(current, transport); else { try { transport.close(0); } catch (_) {} } },
        onStopListening() {}
      });
      resetIdle(current);
      const port = server.port;
      return {url: `http://${host}:${port}/${token}/`, port, token, stop: () => { if (session === current) stop(); }};
    }
    return {start, stop, tailscaleAddress};
  }
};
if (typeof module !== "undefined") module.exports = NoctuaPhoneCamera;
