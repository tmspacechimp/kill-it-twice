import { Component, inject, signal } from '@angular/core';
import { OperationsService } from './operations.service';
import { StatusService } from './status.service';
import { ApiService, errorMessage } from './api.service';
import type { Reply } from './contracts';

@Component({
  selector: 'app-simulations',
  template: `
    <section aria-labelledby="simulations-heading">
      <h2 id="simulations-heading">Failure simulations</h2>
      <p>
        Container commands report Docker outcomes. Restarting the current replicator reloads
        existing rows.
      </p>
      <div class="actions">
        <button
          [disabled]="operations.busy(['replicator']) || pending()"
          (click)="operations.run('/simulations/replicator/kill', ['replicator'])"
        >
          Kill replicator
        </button>
        <button
          [disabled]="operations.busy(['replicator']) || pending()"
          (click)="operations.run('/simulations/replicator/restart', ['replicator'])"
        >
          Restart replicator
        </button>
        <button
          [disabled]="operations.busy(['opensearch']) || pending()"
          (click)="operations.run('/simulations/opensearch/stop', ['opensearch'])"
        >
          Stop OpenSearch
        </button>
        <button
          [disabled]="operations.busy(['opensearch']) || pending()"
          (click)="operations.run('/simulations/opensearch/restore', ['opensearch'])"
        >
          Restore OpenSearch
        </button>
      </div>
      <button
        [disabled]="
          !status.available() ||
          operations.busy(['writer', 'replicator', 'opensearch']) ||
          pending()
        "
        (click)="rejectRecords()"
      >
        Run G4 rejected-record simulation
      </button>
      @if (!status.available()) {
        <p>G4 unavailable: the replicator API is unavailable.</p>
      }
      <p role="status">{{ message() }}</p>
    </section>
  `,
})
export class SimulationsComponent {
  readonly operations = inject(OperationsService);
  readonly status = inject(StatusService);
  private readonly api = inject(ApiService);
  readonly pending = signal(false);
  readonly message = signal('');
  async rejectRecords(): Promise<void> {
    this.pending.set(true);
    try {
      const reply = await this.operations.gate(['writer', 'replicator', 'opensearch'], () =>
        this.api.request<Reply<{ message: string }>>('POST', '/simulations/rejected-records'),
      );
      this.message.set(reply.available ? reply.data.message : reply.reason);
    } catch (error) {
      this.message.set(errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }
}
