export type TriMCEnv = {
  port: number;
  tristacissBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
  /** Working directory for tool execution */
  cwd: string;
  /** Root path for stateful memory files (from TRIMC_MEMDIR). When unset, memory injection is skipped. */
  memdirPath?: string;
};

export function readEnv(): TriMCEnv {
  return {
    port: Number(process.env.TRIMC_PORT ?? 8710),
    tristacissBaseUrl: process.env.TRISTACISS_BASE_URL ?? 'http://127.0.0.1:8008',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730',
    cwd: process.env.TRIMC_CWD ?? process.cwd(),
    memdirPath: process.env.TRIMC_MEMDIR || undefined,
  };
}