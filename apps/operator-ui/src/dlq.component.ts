import { Component, inject, signal } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { ApiService, errorMessage } from './api.service';
import { OperationsService } from './operations.service';
import type { DlqPage, Reply } from './contracts';

@Component({
  selector: 'app-dlq',
  imports: [JsonPipe],
  template: `
    <section aria-labelledby="dlq-heading">
      <h2 id="dlq-heading">Rejected events (DLQ)</h2>
      <button [disabled]="pending()" (click)="load()">Refresh DLQ</button>
      <p role="status">{{ message() }}</p>
      @if (page(); as data) {
        <table>
          <thead>
            <tr>
              <th>Select</th>
              <th>ID</th>
              <th>Reason</th>
              <th>Record</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of data.entries; track entry.id) {
              <tr>
                <td>
                  <input
                    type="radio"
                    name="dlq-entry"
                    [attr.aria-label]="'Select ' + entry.id"
                    [checked]="selected() === entry.id"
                    (change)="selected.set(entry.id)"
                  />
                </td>
                <td>{{ entry.id }}</td>
                <td>{{ entry.reason }}</td>
                <td>
                  <pre>{{ entry.record | json }}</pre>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="4">No entries in this page.</td>
              </tr>
            }
          </tbody>
        </table>
        <div class="actions">
          <button
            [disabled]="!selected() || pending() || operations.busy(['replicator', 'opensearch'])"
            (click)="replay()"
          >
            Replay selected entry
          </button>
          <button [disabled]="!data.nextCursor || pending()" (click)="load(data.nextCursor)">
            Next page
          </button>
        </div>
      }
    </section>
  `,
})
export class DlqComponent {
  private readonly api = inject(ApiService);
  readonly operations = inject(OperationsService);
  readonly page = signal<DlqPage | null>(null);
  readonly selected = signal<string | null>(null);
  readonly pending = signal(false);
  readonly message = signal('Loading DLQ availability.');
  constructor() {
    void this.load();
  }

  async load(cursor: string | null = null): Promise<void> {
    this.pending.set(true);
    this.selected.set(null);
    try {
      const path = '/dlq?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const reply = await this.api.request<Reply<DlqPage>>('GET', path);
      this.page.set(reply.available ? reply.data : null);
      this.message.set(reply.available ? '' : reply.reason);
    } catch (error) {
      this.page.set(null);
      this.message.set('Unavailable: ' + errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }

  async replay(): Promise<void> {
    const id = this.selected();
    if (!id) return;
    this.pending.set(true);
    try {
      const reply = await this.operations.gate(['replicator', 'opensearch'], () =>
        this.api.request<Reply<{ message: string }>>(
          'POST',
          '/dlq/' + encodeURIComponent(id) + '/replay',
        ),
      );
      this.message.set(reply.available ? reply.data.message : reply.reason);
    } catch (error) {
      this.message.set(errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }
}
