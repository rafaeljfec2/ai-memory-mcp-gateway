export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  constructor(
    readonly ctx?: ExecutionContext<Props>,
    readonly env?: Env,
  ) {}
}
