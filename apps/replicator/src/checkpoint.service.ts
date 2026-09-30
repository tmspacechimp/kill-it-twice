import { Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';

export type Checkpoint = {
  boundary: number | null;
  initialId: number | null;
  initialDone: number;
  incrementalId: number | null;
};

@Injectable()
export class CheckpointService {
  private database?: DatabaseSync;

  async open(
    readBoundary: () => Promise<number | null>,
    path = process.env.CHECKPOINT_PATH,
  ): Promise<Checkpoint> {
    if (!path) throw new Error('CHECKPOINT_PATH is required');

    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS progress (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        boundary INTEGER,
        initialId INTEGER,
        initialDone INTEGER NOT NULL CHECK (initialDone IN (0, 1)),
        incrementalId INTEGER
      ) STRICT;
    `);

    const saved = this.database.prepare('SELECT * FROM progress WHERE singleton = 1').get();
    if (saved) return saved as Checkpoint;

    const boundary = await readBoundary();
    this.database.prepare('INSERT INTO progress VALUES (1, ?, NULL, 0, ?)').run(boundary, boundary);
    return { boundary, initialId: null, initialDone: 0, incrementalId: boundary };
  }

  advanceInitial(id: number): void {
    this.db().prepare('UPDATE progress SET initialId = ? WHERE singleton = 1').run(id);
  }

  finishInitial(): void {
    this.db().exec('UPDATE progress SET initialDone = 1 WHERE singleton = 1');
  }

  advanceIncremental(id: number): void {
    this.db().prepare('UPDATE progress SET incrementalId = ? WHERE singleton = 1').run(id);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error('Checkpoint database is not open');
    return this.database;
  }
}
