import { TunnelRegistry } from "./TunnelRegistry";
export { TunnelRegistry };

export interface Env {
  TUNNEL_REGISTRY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. ESP32 Ingress: Accepteer de socket van de warmtepomp over de loopback interface
    if (url.pathname === "/device") {
      const doId = env.TUNNEL_REGISTRY.idFromName("global-poc-gate");
      const stub = env.TUNNEL_REGISTRY.get(doId);
      return await stub.fetch(request);
    }

    // 2. Koppelings-endpoint voor de iPhone: Schrijf de cookie en stuur DIRECT door naar de app!
    if (url.pathname === "/pair") {
      console.log("🔓 [PoC BYPASS] Paring cookie geactiveerd. Browser doorsturen naar de hoofdinterface...");
      
      // We sturen een HTTP 302 Redirect terug naar de root (/) van de reverse proxy
      return new Response("Redirecting...", {
        status: 302,
        headers: {
          "Location": window.location.origin + "/",
          "Set-Cookie": "oq_pump=poc-bypass-token; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000"
        }
      });
    }

    // 3. Browser Proxying op de hoofdlijn: Sluis de inkomende HTTP verzoeken direct door naar de open tunnel!
    const doId = env.TUNNEL_REGISTRY.idFromName("global-poc-gate");
    const stub = env.TUNNEL_REGISTRY.get(doId);
    
    console.log(`📡 [PROXY FETCH] Browser verzoek naar ${url.pathname} over de actieve WebSocket loodsen...`);
    return await stub.fetch(request);
  }
};
