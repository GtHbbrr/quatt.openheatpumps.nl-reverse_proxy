import { TunnelRegistry } from "./TunnelRegistry";
export { TunnelRegistry };

export interface Env {
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. ESP32 verbindt via WSS naar /device (Sectie 4)
    if (url.pathname === "/device") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response("Unauthorized", { status: 401 });
      }
      const pumpSecret = authHeader.substring(7).trim();
      const routeId = await computeRouteId(pumpSecret);

      const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
      const stub = env.TUNNEL_REGISTRY.get(doId);
      return stub.fetch(request);
    }

    // 2. Pairing flow (/pair#<secret>) (Sectie 10)
    if (url.pathname === "/pair") {
      const html = `
        <!DOCTYPE html>
        <html>
        <head><title>OpenQuatt Pairing</title></head>
        <body>
          <h2>OpenQuatt Koppelen</h2>
          <p id="status">Koppelen initialiseren...</p>
          <script>
            const secret = window.location.hash.substring(1);
            if (!secret) {
              document.getElementById("status").innerText = "Geen secret gevonden in URL fragment.";
            } else {
              fetch("/api/pair", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ secret })
              }).then(res => {
                if (res.ok) {
                  document.getElementById("status").innerText = "Succesvol gekoppeld! U wordt doorgestuurd...";
                  setTimeout(() => { window.location.href = "/"; }, 2000);
                } else {
                  document.getElementById("status").innerText = "Koppelen mislukt. Is de warmtepomp online?";
                }
              });
            }
          </script>
        </body>
        </html>
      `;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // API endpoint om de cookie te zetten (Sectie 10)
    if (url.pathname === "/api/pair" && request.method === "POST") {
      try {
        const body: { secret: string } = await request.json();
        const routeId = await computeRouteId(body.secret);
        
        const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
        const stub = env.TUNNEL_REGISTRY.get(doId);
        const checkOnline = await stub.fetch(new Request("http://local/status"));
        
        if (checkOnline.status !== 200) {
          return new Response("Device offline", { status: 503 });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `oq_pump=${body.secret}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
          }
        });
      } catch (e) {
        return new Response("Bad Request", { status: 400 });
      }
    }

    // 3. Normaal browserbezoek (GET / HEAD)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed (Tunnel is Read-Only)", { status: 405 });
    }

    const cookies = parseCookies(cookieHeader);
    const secret = cookies["oq_pump"];
    
    if (!secret) {
      const allHeaders = JSON.stringify(Object.fromEntries(request.headers.entries()), null, 2);
      const debugHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>OpenQuatt Proxy Debug</title>
          <style>
            body { font-family: sans-serif; padding: 20px; line-height: 1.5; background: #f9f9f9; color: #333; }
            .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); max-width: 600px; margin: 0 auto; }
            h2 { color: #d32f2f; margin-top: 0; }
            pre { background: #eee; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; }
            .meta { font-size: 0.9rem; color: #666; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🔒 Toegang Geweigerd (401 Unauthorized)</h2>
            <p><strong>Status:</strong> Niet gekoppeld. Gebruik de lokale <code>openquatt.local</code> interface om uw toestel te koppelen.</p>
            
            <hr>
            <h3>🕵️ Buitenshuis Debug Informatie</h3>
            <p class="meta">De Cloudflare Worker heeft gezocht naar de cookie <code>oq_pump</code>, maar deze is niet meegezonden door uw browser.</p>
            
            <p><strong>Gevonden Cookies:</strong></p>
            <pre>${cookieHeader ? escapeHtml(cookieHeader) : "<i>(Geen cookies aanwezig)</i>"}</pre>
            
            <p><strong>Inkomende HTTP Headers:</strong></p>
            <pre>${escapeHtml(allHeaders)}</pre>
            
            <p class="meta"><em>Tip: Schakel de switch op openquatt.local een keer UIT en AAN om de koppelings-cookie opnieuw via de /pair# postfix te genereren.</em></p>
          </div>
        </body>
        </html>
      `;
      return new Response(debugHtml, { status: 401, headers: { "Content-Type": "text/html" } });
    }

    function escapeHtml(str: string): string {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\x27/g, "&#x27;");
    }
    
    const routeId = await computeRouteId(secret);
    const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
    const stub = env.TUNNEL_REGISTRY.get(doId);
    
    return stub.fetch(request);
  }
};

async function computeRouteId(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, cookie) => {
    const [key, value] = cookie.split("=").map(c => c.trim());
    if (key && value) acc[key] = value;
    return acc;
  }, {} as Record<string, string>);
}

