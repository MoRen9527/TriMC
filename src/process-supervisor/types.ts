export type RunState = 'starting' | 'running' | 'exiting' | 'exited';

export type TerminationReason =
  | 'manual-cancel'
  | 'overall-timeout'
  | 'no-output-timeout'
  | 'spawn-error'
  | 'signal'
  | 'exit';

export type RunRecord = {
  runId: string;
  scopeKey?: string;
  pid?: number;
  startedAtMs: number;
  lastOutputAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  state: RunState;
  terminationReason?: TerminationReason;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
};

export type RunExit = {
  reason: TerminationReason;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
};

export type ManagedRun = {
  runId: string;
  pid?: number;
  startedAtMs: number;
  stdin?: ManagedRunStdin;
  wait: () => Promise<RunExit>;
  cancel: (reason?: TerminationReason) => void;
};

export type ManagedRunStdin = {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
};

export type SpawnInput = {
  runId?: string;
  scopeKey?: string;
  replaceExistingScope?: boolean;
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  captureOutput?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  input?: string;
};

export type RegisterLogicalRunInput = {
  runId?: string;
  scopeKey?: string;
  replaceExistingScope?: boolean;
  abortController: AbortController;
};

export type LogicalRunFinalizeInput = {
  reason: TerminationReason;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
};

export interface ProcessSupervisor {
  spawn(input: SpawnInput): Promise<ManagedRun>;
  registerLogicalRun(input: RegisterLogicalRunInput): ManagedRun;
  finalizeLogicalRun(runId: string, exit: LogicalRunFinalizeInput): RunRecord | undefined;
  cancel(runId: string, reason?: TerminationReason): void;
  cancelScope(scopeKey: string, reason?: TerminationReason): void;
  getRecord(runId: string): RunRecord | undefined;
}

export interface RunRegistry {
  add: (record: RunRecord) => void;
  get: (runId: string) => RunRecord | undefined;
  list: () => RunRecord[];
  listByScope: (scopeKey: string) => RunRecord[];
  updateState: (
    runId: string,
    state: RunState,
    patch?: Partial<Pick<RunRecord, 'pid' | 'terminationReason' | 'exitCode' | 'exitSignal'>>,
  ) => RunRecord | undefined;
  touchOutput: (runId: string) => void;
  finalize: (
    runId: string,
    exit: {
      reason: TerminationReason;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
    },
  ) => { record: RunRecord; firstFinalize: boolean } | null;
  delete: (runId: string) => void;
}
