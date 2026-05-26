declare module 'pg' {
  export class Pool {
    constructor(config?: Record<string, unknown>);
    query(sql: string, values?: unknown[]): Promise<{ rows?: any[]; rowCount?: number }>;
    end(): Promise<void>;
  }
}