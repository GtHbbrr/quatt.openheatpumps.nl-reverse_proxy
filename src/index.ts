import { TunnelRegistry } from "./TunnelRegistry";
export { TunnelRegistry };

export interface Env {
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ==============================================================================
    // WIRE PROTOCOL V2.0: DEVICE INGRESS HANDLING (Sectie 1)
    // ==============================================================================
    if (url.pathname === "/device") {
      const queryToken = url.searchParams.get("token");
      const authHeader = request.headers.get("Authorization")?.replace("Bearer ", "");
      const pumpSecret = queryToken || authHeader;

      if (!pumpSecret) {
        console.error("🚨 [WORKER REJECT] Ingress geweigerd: Geen token gevonden.");
        return new Response("Unauthorized: Missing token parameter", { status: 401 });
      }

      console.log("🟢 [WORKER INGRESS] WebSocket handdruk gestart voor token:", pumpSecret);
      const routeId = await computeRouteId(pumpSecret);
      console.log("• Berekende routeId hash voor Device:", routeId);

      const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
      const stub = env.TUNNEL_REGISTRY.get(doId);

      // FIX: Abstracte DO subrequest-routering conform de platformeisen
      return await stub.fetch(new Request("http://local/device?token=" + pumpSecret, {
        headers: request.headers,
        webSocket: request.headers.get("Upgrade") ? request : undefined
      }));
    }

    // ==============================================================================
    // 2. PAIRING FLOW HTML VIEW (Sectie 10)
    // ==============================================================================
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
            .badge.green { background: #2e7d32; }
            .badge.red { background: #c62828; }
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
            const secret = window.location.hash.substring(1);
            if (!secret) {
              document.getElementById("step-hash").className = "step fail";
              document.getElementById("hash-detail").innerHTML = "<span class='badge red'>Fout</span> Geen secret gevonden.";
            } else {
              document.getElementById("step-hash").className = "step success";
              document.getElementById("hash-detail").innerHTML = "<span class='badge green'>OK</span> Secret gedetecteerd: <code>" + secret + "</code>";
              document.getElementById("step-api").className = "step active";
              document.getElementById("api-detail").innerText = "Verzoek versturen naar /api/pair...";

              fetch("/api/pair", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ secret })
              }).then(async res => {
                if (res.ok) {
                  document.getElementById("step-api").className = "step success";
                  document.getElementById("step-result").style.display = "block";
                  document.getElementById("step-result").className = "step success";
                  document.getElementById("result-title").innerText = "🎉 Koppeling Geslaagd!";
                  document.getElementById("result-text").innerHTML = "Succesvol gekoppeld! U wordt binnen 2 seconden doorsturen naar de live-interface...";
                  setTimeout(() => { window.location.href = window.location.origin + "/"; }, 2000);
                } else {
                  document.getElementById("step-api").className = "step fail";
                  const errText = await res.text().catch(() => "Fout");
                  document.getElementById("step-result").style.display = "block";
                  document.getElementById("step-result").className = "step fail";
                  document.getElementById("result-title").innerText = "Koppeling Mislukt";
                  document.getElementById("result-text").innerHTML = "<pre>" + errText + "</pre>";
                }
              }).catch(err => {
                document.getElementById("step-api").className = "step fail";
              });
            }
          </script>
        </body>
        </html>
      `;
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // ==============================================================================
    // 3. API ENDPOINT OM DE COOKIE TE ZETTEN (Sectie 10)
    // ==============================================================================
    if (url.pathname === "/api/pair" && request.method === "POST") {
      try {
        const body: { secret: string } = await request.json();
        const routeId = await computeRouteId(body.secret);
        console.log("=== [DEBUG] START API PAIR FLOW v2.0 ===");
        
        const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
        const stub = env.TUNNEL_REGISTRY.get(doId);
        
        console.log("• [DEBUG] Versturen van Ingress Health Check (http://local/) naar Durable Object...");
        
        let checkOnline: Response;
        try {
          checkOnline = await stub.fetch(new Request("http://local/device"));

          console.log("• [DEBUG] Ingress Response ontvangen! Status:", checkOnline.status);
        } catch (fetchError: any) {
          return new Response(JSON.stringify({ 
            error: "Tunnel Fetch Exception", 
            message: fetchError.message 
          }), { status: 502, headers: { "Content-Type": "application/json" } });
        }
        
        if (checkOnline.status !== 200) {
          const rawPayload = await checkOnline.text().catch(() => "Geen payload");
          return new Response(rawPayload, { status: checkOnline.status, headers: { "Content-Type": "application/json" } });
        }

        console.log("🎉 [DEBUG SUCCESS] Check geslaagd! Set-Cookie wordt afgegeven.");
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `oq_pump=${body.secret}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
          }
        });
      } catch (e: any) {
        return new Response("Bad Request", { status: 400 });
      }
    }

    // ==============================================================================
    // 4. NORMAAL BROWSERBEZOEK (NON-LOCAL CLOUD ROUTING)
    // ==============================================================================
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed (Tunnel is Read-Only)", { status: 405 });
    }

    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = parseCookies(cookieHeader);
    const secret = cookies["oq_pump"];
    
    if (!secret) {
      const debugHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>OpenQuatt Proxy Debug</title></head>
        <body><div style="font-family:sans-serif;padding:20px;">🔒 Toegang Geweigerd (401 Unauthorized)</div></body>
        </html>
      `;
      return new Response(debugHtml, { status: 401, headers: { "Content-Type": "text/html" } });
    }
    
    const routeId = await computeRouteId(secret);
    const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
    const stub = env.TUNNEL_REGISTRY.get(doId);
    
    try {
      const response = await stub.fetch(request);
      return response;
    } catch (doError: any) {
      return new Response(JSON.stringify({ error: doError.message }), { status: 502 });
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
