import { DatabaseSync, type StatementSync } from 'node:sqlite';

export class ReceiptStore {
  private readonly database: DatabaseSync;
  private readonly insertReceipt: StatementSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS processed_events (
          consumer_name TEXT NOT NULL,
          source_name TEXT NOT NULL,
          event_id INTEGER NOT NULL,
          processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (consumer_name, source_name, event_id)
        ) STRICT;
      `);
      this.insertReceipt = this.database.prepare(`
        INSERT INTO processed_events (consumer_name, source_name, event_id)
        VALUES ('shipment-consumer', 'client-source', ?)
        ON CONFLICT (consumer_name, source_name, event_id) DO NOTHING
        RETURNING event_id
      `);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  record(eventId: number): boolean {
    // Consume the full RETURNING result so the statement commits before acknowledgement.
    const inserted = this.insertReceipt.all(eventId);
    return inserted.length === 1;
  }

  close(): void {
    this.database.close();
  }
}
