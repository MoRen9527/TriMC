export type TriMCEnv = {
  port: number;
  tristacissBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
};

export function readEnv(): TriMCEnv {
  return {
    port: Number(process.env.TRIMC_PORT ?? 8710),
    tristacissBaseUrl: process.env.TRISTACISS_BASE_URL ?? 'http://127.0.0.1:8008',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730'
  };
}