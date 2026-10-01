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
        <head>
          <title>OpenQuatt Pairing Debugger</title>
          <style>
            body { font-family: sans-serif; padding: 20px; line-height: 1.5; background: #f4f6f9; color: #333; }
            .card { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 600px; margin: 0 auto; }
            h2 { color: #0288d1; margin-top: 0; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; }
            .step { margin: 15px 0; padding: 10px; border-left: 4px solid #b0bec5; background: #fafafa; }
            .step.active { border-left-color: #0288d1; background: #e1f5fe; }
            .step.success { border-left-color: #2e7d32; background: #e8f5e9; }
            .step.fail { border-left-color: #c62828; background: #ffebee; }
            pre { background: #263238; color: #eceff1; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; }
            .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 0.8rem; font-weight: bold; color: white; }
            .badge.blue { background: #0288d1; }
            .badge.red { background: #c62828; }
            .badge.green { background: #2e7d32; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>OpenQuatt Stateless Pairing Inspecteur</h2>
            
            <div id="step-hash" class="step active">
              <strong>Stap 1: URL Hash-fragment controleren</strong>
              <div id="hash-detail" style="margin-top: 5px; font-size: 0.9rem;">Uitlezen van URL postfix fragment...</div>
            </div>

            <div id="step-api" class="step">
              <strong>Stap 2: POST Verzoek naar /api/pair</strong>
              <div id="api-detail" style="margin-top: 5px; font-size: 0.9rem;">Wacht op Stap 1...</div>
            </div>

            <div id="step-result" class="step" style="display:none;">
              <strong id="result-title">Eindstatus</strong>
              <p id="result-text" style="font-size: 0.95rem; margin: 5px 0 0 0;"></p>
            </div>
          </div>

          <script>
            const stepHash = document.getElementById("step-hash");
            const hashDetail = document.getElementById("hash-detail");
            const stepApi = document.getElementById("step-api");
            const apiDetail = document.getElementById("api-detail");
            const stepResult = document.getElementById("step-result");
            const resultTitle = document.getElementById("result-title");
            const resultText = document.getElementById("result-text");

            // 1. Extraheer de secret uit de URL postfix hash
            const secret = window.location.hash.substring(1);
            
            if (!secret) {
              stepHash.className = "step fail";
              hashDetail.innerHTML = "<span class=\x27badge red\x27>Fout</span> Geen secret gevonden in URL fragment na de hashtag (#).<br><em>Zorg dat de openquatt.local redirect de URL opbouwt als /pair#XYZ</em>";
              stepApi.className = "step fail";
              apiDetail.innerText = "POST afgebroken wegens missend geheim.";
            } else {
              stepHash.className = "step success";
              hashDetail.innerHTML = "<span class=\x27badge green\x27>OK</span> Secret succesvol gedetecteerd uit URL postfix!<br><strong>Gelezen geheim (Vluchtig RAM ID):</strong> <code>" + secret + "</code>";
              
              // 2. Start de POST aanroep naar het Cloudflare API-endpoint
              stepApi.className = "step active";
              apiDetail.innerHTML = "Verzoek versturen naar <code>POST /api/pair</code> met payload:<br><pre>" + JSON.stringify({ secret: secret }, null, 2) + "</pre><em>De Cloudflare Worker verifieert nu of het Durable Object online is via een status-check...</em>";

              fetch("/api/pair", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ secret })
              }).then(async res => {
                if (res.ok) {
                  stepApi.className = "step success";
                  apiDetail.innerHTML = "<span class='badge green'>Status " + res.status + " OK</span> Stateless cookie succesvol geactiveerd!";
                  stepResult.style.display = "block";
                  stepResult.className = "step success";
                  resultTitle.innerText = "🎉 Koppeling Geslaagd!";
                  resultText.innerHTML = "U bent succesvol stateless verbonden via de beveiligde oq_pump cookie.<br>U wordt binnen 2 seconden automatisch doorstuur naar de live-interface van uw warmtepomp...";
                  setTimeout(() => { window.location.href = window.location.origin + "/"; }, 2000);
                } else {
                  stepApi.className = "step fail";
                  const errText = await res.text().catch(() => "Geen platte tekst response.");
                  let jsonDetail = {};
                  try { jsonDetail = JSON.parse(errText); } catch(e) {}

                  apiDetail.innerHTML = "<span class=\x27badge red\x27>Fout: Status " + res.status + "</span> De Cloudflare API weigerde de koppeling.";
                  
                  stepResult.style.display = "block";
                  stepResult.className = "step fail";
                  resultTitle.innerText = "Koppeling Mislukt";
                  
                  let debugExplain = "<strong>Mogelijke oorzaken:</strong><br>";
                  if (res.status === 503 || errText.includes("offline")) {
                    debugExplain += "<strong>Device Offline (503):</strong> Het Durable Object heeft op dit moment geen actieve WebSocket-pijplijn openstaan vanaf je ESP32 thuis. Controleer of de ESP32-firmware daadwerkelijk verbinding zoekt met <code>wss://quatt.openheatpumps.nl/device</code>.<br>";
                  } else if (res.status === 401) {
                    debugExplain += "<strong>Unauthorized (401):</strong> De ESP32 probeert wel te verbinden, maar de Bearer Authorization token matcht niet met de SHA-256 routering.<br>";
                  } else {
                    debugExplain += "<strong>Serverfout:</strong> " + errText + "<br>";
                  }
                  debugExplain += "<br><small style=\x27color:#666;\x27>Raw Server Response:</small><br><pre>" + (typeof jsonDetail === "object" ? JSON.stringify(jsonDetail, null, 2) : errText) + "</pre>";
                  resultText.innerHTML = debugExplain;
                }
              }).catch(err => {
                stepApi.className = "step fail";
                apiDetail.innerText = "Netwerkfout bij het aanroepen van de API.";
                stepResult.style.display = "block";
                stepResult.className = "step fail";
                resultTitle.innerText = "Exception Gevangen";
                resultText.innerText = err.message;
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

    const cookieHeader = request.headers.get("Cookie") || "";
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
    
    console.log("==> PROXY FETCH: Inkomend HTTP-verzoek ontvangen voor route:", routeId);
    console.log("Method:", request.method, "URL:", request.url);
    
    try {
      const response = await stub.fetch(request);
      console.log("<== PROXY RESPONSE: Durable Object antwoordde met HTTP status:", response.status);
      
      if (response.status === 503) {
        console.error("🚨 CRITICAL: Durable Object retourneerde een 503! De WebSocket-pijplijn naar de ESP32 is waarschijnlijk abrupt afgebroken tijdens de data-overdracht.");
      }
      return response;
    } catch (doError: any) {
      console.error("🚨 FATAL DO CRASH: stub.fetch(request) gooide een runtime-exception!");
      console.error("• Foutmelding:", doError.message);
      console.error("• Stacktrace:", doError.stack || "Geen stacktrace beschikbaar");
      
      return new Response(JSON.stringify({
        error: "Durable Object Ingress Failure",
        message: doError.message,
        stack: doError.stack
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
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

