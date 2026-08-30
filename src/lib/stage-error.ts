/**
 * How a stage refuses to go on.
 *
 * Before PHASE2.md Step 3 each stage was its own process: it printed
 * `✖ <message>` and called `process.exit(1)`, and six of them carried an
 * identical local `fail()` to do it. A stage that exits cannot be composed —
 * `run` (Step 5) has to know which stage stopped and what it had already
 * written — so a stage throws now and `cli.ts` does the printing and the
 * exiting, with the same two lines of output as before.
 */
export class StageError extends Error {
  /**
   * True when the stage has already printed its own failure report and the CLI
   * should do nothing but set the exit code. `validate` is the case that needs
   * it: it prints `✖ N problem(s) … DO NOT COMMIT` followed by the list, and a
   * second `✖` under that would read as a different failure.
   */
  readonly reported: boolean

  constructor(message: string, reported = false) {
    super(message)
    this.name = 'StageError'
    this.reported = reported
  }
}

/** Stop this stage. The CLI prints `✖ <message>` and exits 1. */
export function fail(message: string): never {
  throw new StageError(message)
}

/** Stop this stage, having already said why. The CLI prints nothing and exits 1. */
export function failAfterReport(): never {
  throw new StageError('', true)
}
