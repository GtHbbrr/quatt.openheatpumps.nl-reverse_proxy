import { TunnelRegistry } from "./TunnelRegistry";
export { TunnelRegistry };

export interface Env {
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ==============================================================================
    // WIRE PROTOCOL V2.0: DEVICE INGRESS HANDLING (PRODUCTION RELAY)
    // ==============================================================================
    if (url.pathname === "/device") {
        // 1. Valideer Upgrade header (verplicht volgens Cloudflare docs)
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader !== "websocket") {
            console.error("🚨 [WORKER REJECT] Geen WebSocket Upgrade header gevonden.");
            return new Response("Expected WebSocket Upgrade", { status: 426 });
        }
    
        // 2. Token extractie
        const queryToken = url.searchParams.get("token");
        const authHeader = request.headers.get("Authorization")?.replace("Bearer ", "");
        const pumpSecret = queryToken || authHeader;
    
        if (!pumpSecret) {
            console.error("🚨 [WORKER REJECT] Geen token gevonden.");
            return new Response("Unauthorized: Missing token parameter", { status: 401 });
        }
    
        const routeId = await computeRouteId(pumpSecret);

        // ✅ AI DEBUG LOGS: Toon het token en de berekende hash van de inkomende ESP32
        console.log(`🔍 [DEVICE] ESP32 token: ${pumpSecret}`);
        console.log(`🔍 [DEVICE] RouteId: ${routeId}`);

        const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
        const stub = env.TUNNEL_REGISTRY.get(doId);
    
        // 3. Try-catch zodat fouten zichtbaar worden in plaats van 503
        try {
            return await stub.fetch(request);
        } catch (err: any) {
            console.error("🚨 [WORKER] Durable Object fout:", err.message, err.stack);
            return new Response(JSON.stringify({ 
                error: "DO fetch failed", 
                detail: err.message 
            }), { 
                status: 502, 
                headers: { "Content-Type": "application/json" } 
            });
        }
    }

    // ==============================================================================
    // 2. PAIRING FLOW HTML VIEW (Vangt de # hash-prikkel client-side op!)
    // ==============================================================================
    if (url.pathname === "/pair") {
      // Als er DIRECT een query-parameter staat, verwerk hem direct (302 fallback)
      const directToken = url.searchParams.get("token");
      if (directToken) {
        console.log("🔓 [PRODUCTION PAIR] Directe query-parameter gedetecteerd:", directToken);
        return new Response("Redirecting...", {
          status: 302,
          headers: {
            "Location": url.origin + "/",
            "Set-Cookie": `oq_pump=${directToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
          }
        });
      }

      // Serveer de interactieve inspecteur die de hash (#) in de browser uitleest
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
              document.getElementById("hash-detail").innerHTML = "<span class='badge red'>Fout</span> Geen secret gevonden na de hashtag (#).";
            } else {
              document.getElementById("step-hash").className = "step success";
              document.getElementById("hash-detail").innerHTML = "<span class='badge green'>OK</span> Secret gedetecteerd: <code>" + secret + "</code>";
              document.getElementById("step-api").className = "step active";
              document.getElementById("api-detail").innerText = "Verzoek versturen naar /api/pair...";

              fetch("/api/pair", {
                method: "POST",
                headers: { "Type": "application/json" },
                body: JSON.stringify({ secret })
              }).then(async res => {
                if (res.ok) {
                  document.getElementById("step-api").className = "step success";
                  document.getElementById("step-result").style.display = "block";
                  document.getElementById("step-result").className = "step success";
                  document.getElementById("result-title").innerText = "🎉 Koppeling Geslaagd!";
                  document.getElementById("result-text").innerHTML = "Succesvol stateless verbonden via de oq_pump cookie.";
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
    // 3. API ENDPOINT OM DE HANDSHAKE VIA HET DURABLE OBJECT TE CONTROLEREN
    // ==============================================================================
    if (url.pathname === "/api/pair" && request.method === "POST") {
      try {
        const body: { secret: string } = await request.json();
        if (!body.secret) {
          return new Response(JSON.stringify({ error: "Missing secret parameter" }), { status: 400 });
        }

        const routeId = await computeRouteId(body.secret);

        // ✅ AI DEBUG LOGS: Toon het token en de berekende hash van de browseraanvraag
        console.log(`🔍 [API/PAIR] Browser token: ${body.secret}`);
        console.log(`🔍 [API/PAIR] RouteId: ${routeId}`);

        const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
        const stub = env.TUNNEL_REGISTRY.get(doId);
        
        // Controleer de status op het unieke DO subpad
        const checkOnline = await stub.fetch(new Request("http://local/device/check"));
        
        if (checkOnline.status !== 200) {
          const rawPayload = await checkOnline.text().catch(() => "Geen payload");
          return new Response(rawPayload, { status: checkOnline.status, headers: { "Content-Type": "application/json" } });
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            // GECORRIGEERD: SameSite=Lax is verplicht voor subrequests (CSS/JS) via proxy-tunnels!
            "Set-Cookie": `oq_pump=${body.secret}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`
          }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: "Bad Request" }), { status: 400 });
      }
    }

    // ==============================================================================
    // 4. NORMAAL BROWSERBEZOEK (ESP32 Overbelastingsbeveiliging & Rate Limiting)
    // ==============================================================================
    const cookieHeader = request.headers.get("Cookie") || "";
    const cookieMatch = cookieHeader.match(/(?:^|; )oq_pump=([^;]*)/);
    const secret = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    
    if (!secret || secret === "—" || secret.trim() === "") {
      return new Response("Unauthorized", { status: 401 });
    }
    
    const routeId = await computeRouteId(secret);
    const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
    const stub = env.TUNNEL_REGISTRY.get(doId);
    
    // Maak een unieke cache-sleutel voor herhalende API-aanvragen
    const cacheKey = request.url;

    try {
      // 1. AFDEKKING VOOR DE STATISCHE ASSETS (CSS / JS)
      if (url.pathname.endsWith('.css') || url.pathname.endsWith('.js')) {
        const doResponse = await stub.fetch(request);
        const correctedHeaders = new Headers(doResponse.headers);

        correctedHeaders.set('Content-Type', url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
        correctedHeaders.delete('Content-Encoding');
        correctedHeaders.set('Cache-Control', 'public, max-age=31536000, no-transform');
        
        // Pas hier ook direct de CSP toe voor de assets
        correctedHeaders.set('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https://media.esphome.io;");

        const rawBuffer = await doResponse.arrayBuffer();
        try {
          const decompressor = new DecompressionStream("gzip");
          const writer = decompressor.writable.getWriter();
          writer.write(rawBuffer);
          writer.close();
          const textResponse = await new Response(decompressor.readable).text();
          correctedHeaders.set('Content-Length', new TextEncoder().encode(textResponse).length.toString());
          return new Response(textResponse, { status: doResponse.status, headers: correctedHeaders });
        } catch {
          const decoder = new TextDecoder("utf-8", { fatal: false });
          return new Response(decoder.decode(rawBuffer), { status: doResponse.status, headers: correctedHeaders });
        }
      }

      // ==============================================================================
      // 2. AGGRESSIEVE VERKEERSREGELAAR VOOR LIVE API DATA (Ontlast de ESP32)
      // ==============================================================================
      if (url.pathname.includes('/openquatt/')) {
        // We verdelen de verzoeken strategisch op basis van het subpad om de queue te spreiden
        if (url.pathname.endsWith('entities')) {
          // Geef entiteiten de hoogste prioriteit, maar met een minimale spreiding
          await new Promise(resolve => setTimeout(resolve, 30));
        } else if (url.pathname.endsWith('logs') || url.pathname.endsWith('recent')) {
          // Logs zijn bizar zwaar voor de flash/SRAM van de ESP32. Vertraag deze bewust met 450ms.
          // Hierdoor krijgt de entiteiten-stroom altijd voorrang!
          await new Promise(resolve => setTimeout(resolve, 450));
        } else {
          // Overige polling requests (zoals status/incidents) krijgen een milde vertraging
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      // ==============================================================================
      // 3. DOORGEVEN NAAR DURABLE OBJECT MET TIMEOUT SAFETY
      // ==============================================================================
      // We bouwen een race in Cloudflare: als de ESP32 niet binnen 2.5 seconden antwoordt,
      // breekt Cloudflare het verzoek netjes af met een fallback, zodat de tunnel open blijft.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);

      try {
        const doResponse = await stub.fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (doResponse.status === 503 || doResponse.status === 502) {
          throw new Error("ESP32_BUSY");
        }

        // ✅ REPARATIE & IMPLEMENTATIE: Bouw hier de headers op voor de HTML pagina en API calls
        const generalHeaders = new Headers(doResponse.headers);
        generalHeaders.set('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https://media.esphome.io;");

        // Stuur de response netjes terug inclusief de CSP header
        return new Response(doResponse.body, {
          status: doResponse.status,
          statusText: doResponse.statusText,
          headers: generalHeaders
        });

      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
      
    } catch (doError: any) {
      console.warn("⚠️ [TUNNEL BUSY] ESP32 is overbelast of offline. Stuur rustige fallback.", doError.message);
      
      return new Response(JSON.stringify({ 
        status: "tunnel_throttled", 
        message: "ESP32 is verzoeken aan het verwerken, geduld...",
        entities: [],
        incidents: []       
      }), {
        status: 200, 
        headers: { 
          "Content-Type": "application/json",
          "Content-Security-Policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https://media.esphome.io;"
        }
      });
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
