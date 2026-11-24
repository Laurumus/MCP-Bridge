import { DatabaseSync } from 'node:sqlite';

export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Statuses that hold the single active-task slot and therefore need the
 * watchdog/recovery to keep tracking them. `error` is NOT active: it marks a
 * session that never received a running task (setup failure or a confirmed
 * prompt rejection), so it does not occupy the slot.
 */
export const ACTIVE_STATUSES = ['submitting', 'pending', 'unknown'];

/**
 * SQLite-backed store for the bridge's tasks.
 * Only sessions created by this bridge are ever referenced: the bridge never
 * accepts a raw sessionID from the MCP client, and every lookup is keyed by
 * the bridge-generated taskID.
 */
export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id    TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        prompt     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status     TEXT NOT NULL,
        outcome    TEXT,
        error      TEXT
      );
    `);
    this._insert = this.db.prepare(
      `INSERT INTO tasks (task_id, session_id, prompt, created_at, status, outcome, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this._get = this.db.prepare(
      `SELECT task_id, session_id, prompt, created_at, status, outcome, error
       FROM tasks WHERE task_id = ?`,
    );
    this._update = this.db.prepare(
      `UPDATE tasks SET status = ?, outcome = ?, error = ? WHERE task_id = ?`,
    );
    this._listNonTerminal = this.db.prepare(
      `SELECT task_id, session_id, prompt, created_at, status, outcome, error
       FROM tasks WHERE status IN ('submitting', 'pending', 'unknown')`,
    );
  }

  insert(task) {
    this._insert.run(
      task.taskId, task.sessionId, task.prompt, task.createdAt,
      task.status, task.outcome ?? null, task.error ?? null,
    );
  }

  get(taskId) {
    const row = this._get.get(taskId);
    return row ? this._rowToTask(row) : null;
  }

  getBySessionId(sessionId) {
    const row = this.db.prepare(
      `SELECT task_id, session_id, prompt, created_at, status, outcome, error
       FROM tasks WHERE session_id = ?`,
    ).get(sessionId);
    return row ? this._rowToTask(row) : null;
  }

  update(taskId, { status, outcome, error }) {
    this._update.run(status ?? null, outcome ?? null, error ?? null, taskId);
  }

  listNonTerminal() {
    return this._listNonTerminal.all().map((r) => this._rowToTask(r));
  }

  _rowToTask(row) {
    return {
      taskId: row.task_id,
      sessionId: row.session_id,
      prompt: row.prompt,
      createdAt: row.created_at,
      status: row.status,
      outcome: row.outcome,
      error: row.error,
    };
  }

  close() {
    this.db.close();
  }
}
