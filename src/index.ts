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
    // 2. COOKIE PAIRING ENDPOINT: SCHRIJF HET ECHTE DYNAMISCHE TOKEN WEG!
    // ==============================================================================
    if (url.pathname === "/pair") {
      // Extraheer het unieke geheim uit het URL hash-fragment (#oq-xxx)
      const secret = url.hash.substring(1);
      
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
    // 3. BROWSER PROXYING: LOODS DATA OVER DE ACTIEVE WEBSOCKET
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
