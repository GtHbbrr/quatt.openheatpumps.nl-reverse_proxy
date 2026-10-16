import { TunnelRegistry } from "./TunnelRegistry";
export { TunnelRegistry };

export interface Env {
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ==============================================================================
    // 1. WIRE PROTOCOL V2.0: DEVICE INGRESS HANDLING
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

      const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
      const stub = env.TUNNEL_REGISTRY.get(doId);

      // Routeer via http://local/device om de Durable Object WebSocket Upgrade te deblokkeren!
      return await stub.fetch(new Request("http://local/device?token=" + pumpSecret, {
        headers: request.headers,
        webSocket: request.headers.get("Upgrade") ? request : undefined
      }));
    }

    // ==============================================================================
    // 2. COOKIE PAIRING REDIRECT ENDPOINT (WIRE PROTOCOL V2.0)
    // ==============================================================================
    if (url.pathname === "/pair") {
      // Haal het token op uit de query string (?token=oq-xxx) voor server-side tracking
      const secret = url.searchParams.get("token");
      
      if (!secret) {
        console.error("🚨 [PRODUCTION PAIR] Paring afgebroken: Geen token parameter gevonden in de URL.");
        return new Response("Pairing Failed: Missing token query parameter", { status: 400 });
      }

      console.log("🔓 [PRODUCTION PAIR] Paring cookie activeren voor dynamisch token:", secret);
      
      // We sturen een HTTP 302 Redirect terug naar de root (/) van de reverse proxy
      return new Response("Redirecting to OpenQuatt Application...", {
        status: 302,
        headers: {
          "Location": url.origin + "/",
          "Set-Cookie": `oq_pump=${secret}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
        }
      });
    }

    // ==============================================================================
    // 3. API ENDPOINT OM DE HANDSHAKE VIA HET DURABLE OBJECT TE CONTROLEREN
    // ==============================================================================
    if (url.pathname === "/api/pair" && request.method === "POST") {
      try {
        const body: { secret: string } = await request.json();
        
        if (!body.secret) {
          return new Response(JSON.stringify({ error: "Missing secret parameter" }), { 
            status: 400, 
            headers: { "Content-Type": "application/json" } 
          });
        }

        const routeId = await computeRouteId(body.secret);
        console.log("=== [DEBUG] START API PAIR FLOW v2.0 ===");
        
        const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
        const stub = env.TUNNEL_REGISTRY.get(doId);
        
        console.log("• [DEBUG] Versturen van Ingress Health Check naar: http://local/device/check");
        
        const checkOnline = await stub.fetch(new Request("http://local/device/check"));
        console.log("• [DEBUG] Ingress Response ontvangen! HTTP Status:", checkOnline.status);
        
        if (checkOnline.status !== 200) {
          const rawPayload = await checkOnline.text().catch(() => "Geen payload");
          return new Response(rawPayload, { 
            status: checkOnline.status, 
            headers: { "Content-Type": "application/json" } 
          });
        }

        console.log("🎉 [DEBUG SUCCESS] Check geslaagd! Set-Cookie wordt afgegeven.");
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `oq_pump=${body.secret}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
          }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: "Bad Request", message: e.message }), { status: 400 });
      }
    }

    // ==============================================================================
    // 4. BROWSER PROXYING: LOODS DATA OVER DE ACTIEVE WEBSOCKET
    // ==============================================================================
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed (Tunnel is Read-Only)", { status: 405 });
    }

    const cookieHeader = request.headers.get("Cookie") || "";
    const cookies = parseCookies(cookieHeader);
    const secret = cookies["oq_pump"];
    
    if (!secret) {
      return new Response("🔒 Toegang Geweigerd (401 Unauthorized): Toestel niet gekoppeld.", { status: 401 });
    }
    
    const routeId = await computeRouteId(secret);
    const doId = env.TUNNEL_REGISTRY.idFromName(routeId);
    const stub = env.TUNNEL_REGISTRY.get(doId);
    
    console.log(`📡 [PROXY FETCH] Verzoek naar ${url.pathname} overzetten naar route: ${routeId}`);
    return await stub.fetch(request);
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
